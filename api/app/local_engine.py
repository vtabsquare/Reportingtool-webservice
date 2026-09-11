from __future__ import annotations
import json, os, sqlite3, threading, time, hashlib
from pathlib import Path
from typing import Any
import pandas as pd

from .storage import DATA, DEMO

ANALYTICS = DATA / 'vtab_analytics.duckdb'
COLUMNAR = DATA / 'columnar'
TEMP = DATA / 'temp'
CATALOG = DATA / 'storage_catalog.json'
_LOCK = threading.RLock()

_ANALYTICS_READY = False
_ANALYTICS_ERROR: str | None = None

def analytics_status():
    return {
        'ready': bool(_ANALYTICS_READY),
        'error': _ANALYTICS_ERROR,
        'database': str(ANALYTICS),
        'columnarDirectory': str(COLUMNAR),
    }

def _restore_catalog_views(con):
    """Recreate persisted DuckDB views from the Parquet storage catalog.

    The DuckDB file is only a query/catalog accelerator; imported data lives in
    Parquet. Recreating views is therefore safe and non-destructive.
    """
    cat=_load_catalog().get('tables',{})
    for table,entry in cat.items():
        path=Path(entry.get('path',''))
        if path.exists():
            try:_create_view(con,table,path)
            except Exception:pass

def ensure_analytics_ready():
    """Initialize DuckDB lazily and safely.

    This function is deliberately kept out of application startup so a damaged,
    locked, or missing analytical engine cannot prevent Home/Project from opening.
    """
    global _ANALYTICS_READY,_ANALYTICS_ERROR
    if _ANALYTICS_READY:
        return {'ready':True,'engine':'DuckDB + Parquet ZSTD','database':str(ANALYTICS)}
    with _LOCK:
        if _ANALYTICS_READY:
            return {'ready':True,'engine':'DuckDB + Parquet ZSTD','database':str(ANALYTICS)}
        try:
            con=connect()
            try:
                con.execute('SELECT 1').fetchone()
                _restore_catalog_views(con)
            finally:
                con.close()
            # Seed bundled reference/demo tables only after the basic engine is usable.
            bootstrap_from_sqlite()
            _ANALYTICS_READY=True;_ANALYTICS_ERROR=None
            return {'ready':True,'engine':'DuckDB + Parquet ZSTD','database':str(ANALYTICS)}
        except Exception as exc:
            _ANALYTICS_READY=False;_ANALYTICS_ERROR=str(exc)
            raise

def _duckdb():
    try:
        import duckdb
        return duckdb
    except Exception as e:
        raise RuntimeError(
            'DuckDB analytical engine is not installed. Run RUN_AUTHORING.bat so '
            'requirements-startup.txt is installed.'
        ) from e

def _sql_string(value:str)->str:
    return "'" + str(value).replace("'", "''") + "'"

def _path_sql(path:Path)->str:
    return _sql_string(path.resolve().as_posix())

def _load_catalog()->dict:
    try:
        catalog=json.loads(CATALOG.read_text(encoding='utf-8')) if CATALOG.exists() else {'tables':{}}
        # Catalogs are shipped between machines. Older builds persisted an
        # absolute developer path, which left DuckDB views pointing at files
        # that only existed on the build computer. Resolve missing/relative
        # paths against this installation's data/columnar directory.
        for table,entry in (catalog.get('tables',{}) or {}).items():
            raw=Path(str((entry or {}).get('path') or ''))
            resolved=(DATA/raw).resolve() if raw and not raw.is_absolute() else raw
            if not resolved.is_file():
                candidate=_parquet_path(table)
                if candidate.is_file():resolved=candidate
            entry['path']=str(resolved)
        return catalog
    except Exception:
        return {'tables':{}}

def _save_catalog(catalog:dict):
    CATALOG.write_text(json.dumps(catalog,indent=2),encoding='utf-8')

def connect(read_only:bool=False):
    DATA.mkdir(parents=True,exist_ok=True)
    COLUMNAR.mkdir(parents=True,exist_ok=True)
    TEMP.mkdir(parents=True,exist_ok=True)
    duckdb=_duckdb()
    con=duckdb.connect(str(ANALYTICS),read_only=read_only)
    try:
        con.execute("INSTALL httpfs; LOAD httpfs;")
    except Exception:
        pass # Ignore in locked/read-only mode if already installed
    threads=max(1,min(os.cpu_count() or 4,16))
    memory=os.getenv('VTAB_MEMORY_LIMIT','4GB')
    con.execute(f"SET threads={threads}")
    con.execute(f"SET memory_limit={_sql_string(memory)}")
    con.execute(f"SET temp_directory={_path_sql(TEMP)}")
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET enable_object_cache=true")
    return con

def _parquet_path(table:str)->Path:
    safe=''.join(c if c.isalnum() or c=='_' else '_' for c in table).strip('_') or 'Table'
    return COLUMNAR/(safe[:100]+'.parquet')

def _create_view(con,table:str,path:Path):
    q='"'+table.replace('"','""')+'"'
    con.execute(f"CREATE OR REPLACE VIEW {q} AS SELECT * FROM read_parquet({_path_sql(path)})")

def _record(table:str,row_count:int,source_bytes:int|None,compressed_bytes:int,path:Path,kind='managed'):
    cat=_load_catalog()
    ratio=(source_bytes/compressed_bytes) if source_bytes and compressed_bytes else None
    cat.setdefault('tables',{})[table]={
        'table':table,'rows':int(row_count),'sourceBytes':source_bytes,
        'compressedBytes':int(compressed_bytes),'compressionRatio':round(ratio,2) if ratio else None,
        # Store a portable path; _load_catalog resolves it for runtime callers.
        'path':str(path.resolve().relative_to(DATA.resolve())) if path.resolve().is_relative_to(DATA.resolve()) else str(path),
        'kind':kind,'updatedAt':time.time(),
    }
    _save_catalog(cat)

def write_dataframe(df:pd.DataFrame,table:str,source_bytes:int|None=None,kind='managed'):
    df=df.copy()
    df.columns=[str(c).strip() or f'Column_{i+1}' for i,c in enumerate(df.columns)]
    path=_parquet_path(table)
    with _LOCK:
        con=connect()
        try:
            con.register('__vtab_df',df)
            con.execute(
                f"COPY (SELECT * FROM __vtab_df) TO {_path_sql(path)} "
                "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)"
            )
            _create_view(con,table,path)
            rows=con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        finally:
            try:con.unregister('__vtab_df')
            except Exception:pass
            con.close()
    _record(table,rows,source_bytes,path.stat().st_size,path,kind)
    return rows

def import_path(path:Path,table:str,source_bytes:int|None=None):
    ext=path.suffix.lower()
    out=_parquet_path(table)
    with _LOCK:
        con=connect()
        try:
            if ext=='.csv':
                source=f"read_csv_auto({_path_sql(path)}, sample_size=200000, all_varchar=false, ignore_errors=false)"
            elif ext in ('.tsv','.txt'):
                source=f"read_csv_auto({_path_sql(path)}, delim='\t', sample_size=200000, all_varchar=false, ignore_errors=false)"
            elif ext=='.parquet':
                source=f"read_parquet({_path_sql(path)})"
            elif ext in ('.json','.jsonl'):
                source=f"read_json_auto({_path_sql(path)}, maximum_object_size=16777216)"
            else:
                raise ValueError('Direct columnar import supports CSV, TSV/TXT, JSON/JSONL and Parquet.')
            try:
                con.execute(
                    f"COPY (SELECT * FROM {source}) TO {_path_sql(out)} "
                    "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)"
                )
            except Exception:
                if ext=='.csv':
                    source=f"read_csv_auto({_path_sql(path)}, sample_size=200000, all_varchar=true, ignore_errors=false)"
                elif ext in ('.tsv','.txt'):
                    source=f"read_csv_auto({_path_sql(path)}, delim='\t', sample_size=200000, all_varchar=true, ignore_errors=false)"
                else:
                    raise
                try:
                    if out.exists():out.unlink()
                except Exception:pass
                con.execute(
                    f"COPY (SELECT * FROM {source}) TO {_path_sql(out)} "
                    "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)"
                )
            _create_view(con,table,out)
            rows=con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        finally:con.close()
    _record(table,rows,source_bytes or path.stat().st_size,out.stat().st_size,out,'managed')
    return rows

def materialize_query(sql:str,params:list[Any],table:str):
    path=_parquet_path(table)
    with _LOCK:
        con=connect()
        try:
            con.execute(
                f"COPY ({sql}) TO {_path_sql(path)} "
                "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)",
                params
            )
            _create_view(con,table,path)
            rows=con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        finally:con.close()
    # Processed data has no single original file size. Record compressed physical size.
    _record(table,rows,None,path.stat().st_size,path,'processed')
    return rows,path

def table_columns(table:str):
    ensure_analytics_ready()
    con=connect()
    try:
        rows=con.execute(f'DESCRIBE SELECT * FROM "{table}"').fetchall()
        return [r[0] for r in rows]
    finally:con.close()

def table_types(table:str):
    ensure_analytics_ready()
    con=connect()
    try:
        rows=con.execute(f'DESCRIBE SELECT * FROM "{table}"').fetchall()
        return {r[0]:r[1] for r in rows}
    finally:con.close()

def metadata():
    ensure_analytics_ready()
    cat=_load_catalog().get('tables',{})
    con=connect()
    try:
        tables=[
            r[0] for r in con.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema='main' ORDER BY table_name"
            ).fetchall()
        ]
        out=[]
        for table in tables:
            try:
                desc=con.execute(f'DESCRIBE SELECT * FROM "{table}"').fetchall()
            except Exception:
                # Hydrated published snapshots use a temporary local cache.
                # If that cache has been cleaned, discard only the stale view
                # instead of making every Data/Refresh settings page fail.
                entry=cat.get(table,{})
                path=Path(str(entry.get('path') or ''))
                if path.is_file():
                    _create_view(con,table,path)
                    desc=con.execute(f'DESCRIBE SELECT * FROM "{table}"').fetchall()
                else:
                    q='"'+table.replace('"','""')+'"'
                    try:con.execute(f'DROP VIEW IF EXISTS {q}')
                    except Exception:pass
                    continue
            cols=[{'name':r[0],'type':r[1] or 'VARCHAR','nullable':True,'pk':False} for r in desc]
            entry=cat.get(table,{})
            count=entry.get('rows')
            if count is None:
                count=con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            out.append({
                'schema':'main','name':table,'type':'table','columns':cols,'rowCount':int(count),
                'managed':entry.get('kind') in ('managed','processed','calendar'),
                'storage':entry,
            })
        return out
    finally:con.close()

def bootstrap_from_sqlite():
    """Copy the five bundled demo/reference tables into the columnar engine once."""
    if not DEMO.exists():
        return
    con=connect()
    try:
        existing={r[0] for r in con.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"
        ).fetchall()}
    finally:con.close()
    src=sqlite3.connect(DEMO)
    try:
        tables=[r[0] for r in src.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()]
        for table in tables:
            if table in existing:
                continue
            df=pd.read_sql_query(f'SELECT * FROM "{table}"',src)
            approx=int(df.memory_usage(index=True,deep=True).sum())
            write_dataframe(df,table,approx,'reference')
    finally:src.close()

def storage_stats():
    ensure_analytics_ready()
    cat=_load_catalog()
    entries=list(cat.get('tables',{}).values())
    measured=[x for x in entries if x.get('kind')=='managed' and x.get('sourceBytes')]
    source=sum(int(x.get('sourceBytes') or 0) for x in measured)
    compressed=sum(int(x.get('compressedBytes') or 0) for x in measured)
    ratio=(source/compressed) if source and compressed else None
    return {
        'engine':'DuckDB + Parquet ZSTD',
        'tables':len(entries),'measuredImports':len(measured),
        'sourceBytes':source,
        'compressedBytes':compressed,
        'compressionRatio':round(ratio,2) if ratio else None,
        'target':'up to 50x on highly compressible data; actual ratio depends on data cardinality and source format',
        'threads':max(1,min(os.cpu_count() or 4,16)),
        'memoryLimit':os.getenv('VTAB_MEMORY_LIMIT','4GB'),
        'columnarDirectory':str(COLUMNAR),
        'details':entries,
    }

def optimize_storage():
    ensure_analytics_ready()
    """Rewrite columnar files with ZSTD and larger row groups."""
    cat=_load_catalog()
    rewritten=0
    for table,entry in list(cat.get('tables',{}).items()):
        path=Path(entry.get('path',''))
        if not path.exists():
            continue
        tmp=path.with_suffix('.opt.parquet')
        con=connect()
        try:
            con.execute(
                f"COPY (SELECT * FROM read_parquet({_path_sql(path)})) TO {_path_sql(tmp)} "
                "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 262144)"
            )
            con.close()
            tmp.replace(path)
            con=connect()
            _create_view(con,table,path)
            con.close()
            entry['compressedBytes']=path.stat().st_size
            if entry.get('sourceBytes'):
                entry['compressionRatio']=round(entry['sourceBytes']/max(path.stat().st_size,1),2)
            rewritten+=1
        finally:
            try:con.close()
            except Exception:pass
            if tmp.exists():
                try:tmp.unlink()
                except Exception:pass
    _save_catalog(cat)
    return {'ok':True,'rewritten':rewritten,**storage_stats()}

def delete_managed_table(table:str):
    ensure_analytics_ready()
    """Delete an imported/processed/calendar table and its physical Parquet file.

    Reference/demo tables are deliberately protected.
    """
    cat=_load_catalog();entry=cat.get('tables',{}).get(table)
    if not entry:
        raise ValueError(f"Table '{table}' is not a managed local table.")
    if entry.get('kind') not in ('managed','processed','calendar'):
        raise ValueError('Only imported, processed, or generated calendar tables can be deleted.')
    path=Path(entry.get('path','')) if entry.get('path') else None
    with _LOCK:
        con=connect()
        try:
            q='"'+table.replace('"','""')+'"'
            con.execute(f'DROP VIEW IF EXISTS {q}')
            con.execute(f'DROP TABLE IF EXISTS {q}')
        finally:con.close()
    if path and path.exists():
        try:path.unlink()
        except Exception:pass
    cat.get('tables',{}).pop(table,None);_save_catalog(cat)
    return {'ok':True,'table':table}


def _calendar_column_specs():
    """Return exactly 360 useful calendar/date attributes for the generated Date dimension."""
    c=[]
    def add(alias,expr):
        if alias not in {a for a,_ in c}: c.append((alias,expr))

    # Core identity / common BI fields.
    core=[
      ('Date','Date'),('DateKey',"CAST(strftime(Date,'%Y%m%d') AS INTEGER)"),
      ('DateSerial',"date_diff('day', DATE '1900-01-01', Date)"),('DateISO',"strftime(Date,'%Y-%m-%d')"),
      ('Date_DDMMYYYY',"strftime(Date,'%d-%m-%Y')"),('Date_MMDDYYYY',"strftime(Date,'%m/%d/%Y')"),
      ('Date_DDSlashMMYYYY',"strftime(Date,'%d/%m/%Y')"),('Date_Dot',"strftime(Date,'%d.%m.%Y')"),
      ('Day', 'day(Date)'),('Day2',"strftime(Date,'%d')"),('DayName',"strftime(Date,'%A')"),('DayShort',"strftime(Date,'%a')"),
      ('DayOfWeek','dayofweek(Date)'),('ISODayOfWeek',"CAST(strftime(Date,'%u') AS INTEGER)"),('DayOfYear','dayofyear(Date)'),
      ('WeekNumber','week(Date)'),('ISOWeekNumber',"CAST(strftime(Date,'%V') AS INTEGER)"),('ISOWeekYear',"CAST(strftime(Date,'%G') AS INTEGER)"),
      ('WeekStart',"date_trunc('week',Date)::DATE"),('WeekEnd',"(date_trunc('week',Date)+INTERVAL 6 DAY)::DATE"),
      ('MonthNumber','month(Date)'),('Month2',"strftime(Date,'%m')"),('MonthName',"strftime(Date,'%B')"),('MonthShort',"strftime(Date,'%b')"),
      ('MonthYear',"strftime(Date,'%b %Y')"),('MonthYearLong',"strftime(Date,'%B %Y')"),('YearMonth',"strftime(Date,'%Y-%m')"),
      ('MonthYearSort',"CAST(strftime(Date,'%Y%m') AS INTEGER)"),('MonthStart',"date_trunc('month',Date)::DATE"),('MonthEnd','last_day(Date)'),
      ('QuarterNumber','quarter(Date)'),('Quarter',"'Q'||CAST(quarter(Date) AS VARCHAR)"),
      ('QuarterYear',"'Q'||CAST(quarter(Date) AS VARCHAR)||' '||CAST(year(Date) AS VARCHAR)"),
      ('YearQuarter',"CAST(year(Date) AS VARCHAR)||'-Q'||CAST(quarter(Date) AS VARCHAR)"),
      ('QuarterStart',"date_trunc('quarter',Date)::DATE"),('QuarterEnd',"(date_trunc('quarter',Date)+INTERVAL 3 MONTH-INTERVAL 1 DAY)::DATE"),
      ('Year','year(Date)'),('Year2',"strftime(Date,'%y')"),('YearStart',"date_trunc('year',Date)::DATE"),
      ('YearEnd',"(date_trunc('year',Date)+INTERVAL 1 YEAR-INTERVAL 1 DAY)::DATE"),
      ('YearMonthKey',"CAST(strftime(Date,'%Y%m') AS INTEGER)"),('YearQuarterKey','year(Date)*10+quarter(Date)'),
      ('YearWeekKey',"CAST(strftime(Date,'%G%V') AS INTEGER)"),('WeekMonth',"'W'||lpad(CAST(week(Date) AS VARCHAR),2,'0')||' '||strftime(Date,'%b %Y')"),
      ('IsWeekend','dayofweek(Date) IN (0,6)'),('IsWeekday','dayofweek(Date) NOT IN (0,6)'),
      ('IsToday','Date=current_date'),('IsYesterday','Date=current_date-INTERVAL 1 DAY'),('IsTomorrow','Date=current_date+INTERVAL 1 DAY'),
      ('IsPast','Date<current_date'),('IsFuture','Date>current_date'),('IsCurrentWeek',"date_trunc('week',Date)=date_trunc('week',current_date)"),
      ('IsCurrentMonth',"date_trunc('month',Date)=date_trunc('month',current_date)"),('IsCurrentQuarter',"date_trunc('quarter',Date)=date_trunc('quarter',current_date)"),
      ('IsCurrentYear','year(Date)=year(current_date)'),('IsPreviousWeek',"date_trunc('week',Date)=date_trunc('week',current_date)-INTERVAL 1 WEEK"),
      ('IsPreviousMonth',"date_trunc('month',Date)=date_trunc('month',current_date)-INTERVAL 1 MONTH"),
      ('IsPreviousQuarter',"date_trunc('quarter',Date)=date_trunc('quarter',current_date)-INTERVAL 3 MONTH"),
      ('IsPreviousYear','year(Date)=year(current_date)-1'),('IsNextWeek',"date_trunc('week',Date)=date_trunc('week',current_date)+INTERVAL 1 WEEK"),
      ('IsNextMonth',"date_trunc('month',Date)=date_trunc('month',current_date)+INTERVAL 1 MONTH"),('IsNextQuarter',"date_trunc('quarter',Date)=date_trunc('quarter',current_date)+INTERVAL 3 MONTH"),
      ('IsNextYear','year(Date)=year(current_date)+1'),('DayOffset',"date_diff('day',current_date,Date)"),
      ('WeekOffset',"date_diff('week',date_trunc('week',current_date),date_trunc('week',Date))"),
      ('MonthOffset',"date_diff('month',date_trunc('month',current_date),date_trunc('month',Date))"),
      ('QuarterOffset',"date_diff('quarter',date_trunc('quarter',current_date),date_trunc('quarter',Date))"),
      ('YearOffset','year(Date)-year(current_date)'),('DaysInMonth','day(last_day(Date))'),
      ('IsMonthStart',"Date=date_trunc('month',Date)::DATE"),('IsMonthEnd','Date=last_day(Date)'),
      ('IsQuarterStart',"Date=date_trunc('quarter',Date)::DATE"),('IsQuarterEnd',"Date=(date_trunc('quarter',Date)+INTERVAL 3 MONTH-INTERVAL 1 DAY)::DATE"),
      ('IsYearStart',"Date=date_trunc('year',Date)::DATE"),('IsYearEnd',"Date=(date_trunc('year',Date)+INTERVAL 1 YEAR-INTERVAL 1 DAY)::DATE"),
    ]
    for x in core:add(*x)

    # Twelve fiscal-calendar perspectives. M01 is calendar year; M04, M07, etc. are common enterprise calendars.
    for m in range(1,13):
        off=m-1; tag=f'M{m:02d}'; shift=f"(Date-INTERVAL {off} MONTH)"
        add(f'FiscalYear_{tag}',f'year({shift})')
        add(f'FiscalYearLabel_{tag}',f"'FY'||CAST(year({shift}) AS VARCHAR)")
        add(f'FiscalQuarter_{tag}',f'quarter({shift})')
        add(f'FiscalQuarterLabel_{tag}',f"'FQ'||CAST(quarter({shift}) AS VARCHAR)")
        add(f'FiscalMonth_{tag}',f'((month(Date)-{m}+12)%12)+1')
        add(f'FiscalYearMonthKey_{tag}',f'year({shift})*100+(((month(Date)-{m}+12)%12)+1)')
        add(f'FiscalYearQuarterKey_{tag}',f'year({shift})*10+quarter({shift})')
        add(f'FiscalYearStart_{tag}',f"(date_trunc('year',{shift})+INTERVAL {off} MONTH)::DATE")
        add(f'FiscalYearEnd_{tag}',f"(date_trunc('year',{shift})+INTERVAL {off+12} MONTH-INTERVAL 1 DAY)::DATE")
        add(f'FiscalQuarterStart_{tag}',f"(date_trunc('quarter',{shift})+INTERVAL {off} MONTH)::DATE")
        add(f'FiscalQuarterEnd_{tag}',f"(date_trunc('quarter',{shift})+INTERVAL {off+3} MONTH-INTERVAL 1 DAY)::DATE")

    # Readable display formats commonly requested in enterprise BI.
    formats=[
      ('YYYYMMDD','%Y%m%d'),('YYYY_MM_DD','%Y_%m_%d'),('YYYYSlashMMSlashDD','%Y/%m/%d'),('DDMMYYYY','%d%m%Y'),
      ('MMDDYYYY','%m%d%Y'),('DD_MMM_YYYY','%d_%b_%Y'),('DD_MMMM_YYYY','%d_%B_%Y'),('MMM_DD_YYYY','%b_%d_%Y'),
      ('MMMM_DD_YYYY','%B_%d_%Y'),('DD_MMM','%d_%b'),('MMM_DD','%b_%d'),('DDD_DD_MMM','%a_%d_%b'),
      ('DDDD_DD_MMMM','%A_%d_%B'),('MonthYearShort','%b-%Y'),('MonthYearNumeric','%m-%Y'),('YearMonthCompact','%Y%m'),
      ('ISOYearWeek','%G-W%V'),('WeekdayShort','%a'),('WeekdayLong','%A'),('MonthNameShort','%b'),('MonthNameLong','%B')]
    for label,fmt in formats:add('Fmt_'+label,f"strftime(Date,'{fmt}')")

    # Period relative flags and labels.
    for n in range(1,13):
        add(f'IsLast{n}Months',f"Date>=current_date-INTERVAL {n} MONTH AND Date<=current_date")
        add(f'IsNext{n}Months',f"Date>current_date AND Date<=current_date+INTERVAL {n} MONTH")
    for n in range(1,9):
        add(f'IsLast{n}Weeks',f"Date>=current_date-INTERVAL {n} WEEK AND Date<=current_date")
        add(f'IsNext{n}Weeks',f"Date>current_date AND Date<=current_date+INTERVAL {n} WEEK")
    for n in range(1,6):
        add(f'IsLast{n}Years',f"Date>=current_date-INTERVAL {n} YEAR AND Date<=current_date")
        add(f'IsNext{n}Years',f"Date>current_date AND Date<=current_date+INTERVAL {n} YEAR")

    # Additional sort/display keys and business labels until the governed schema reaches exactly 360 fields.
    extras=[
      ('SemesterNumber','CASE WHEN month(Date)<=6 THEN 1 ELSE 2 END'),('Semester',"'H'||CAST(CASE WHEN month(Date)<=6 THEN 1 ELSE 2 END AS VARCHAR)"),
      ('SemesterYear',"'H'||CAST(CASE WHEN month(Date)<=6 THEN 1 ELSE 2 END AS VARCHAR)||' '||CAST(year(Date) AS VARCHAR)"),
      ('FourMonthPeriod','CEIL(month(Date)/4.0)::INTEGER'),('BimonthNumber','CEIL(month(Date)/2.0)::INTEGER'),
      ('WeekOfMonth','CEIL(day(Date)/7.0)::INTEGER'),('DayOfQuarter',"date_diff('day',date_trunc('quarter',Date),Date)+1"),
      ('DayOfMonthReverse','day(last_day(Date))-day(Date)+1'),('BusinessDayOfWeek',"CASE dayofweek(Date) WHEN 0 THEN 7 ELSE dayofweek(Date) END"),
      ('IsMonday',"strftime(Date,'%a')='Mon'"),('IsTuesday',"strftime(Date,'%a')='Tue'"),('IsWednesday',"strftime(Date,'%a')='Wed'"),
      ('IsThursday',"strftime(Date,'%a')='Thu'"),('IsFriday',"strftime(Date,'%a')='Fri'"),('IsSaturday',"strftime(Date,'%a')='Sat'"),('IsSunday',"strftime(Date,'%a')='Sun'"),
    ]
    for x in extras:add(*x)

    # Deterministic, meaningful rolling-window flags fill any remaining slots to 360.
    n=1
    while len(c)<360:
        add(f'IsRollingLast{n}Days',f'Date>=current_date-INTERVAL {n} DAY AND Date<=current_date')
        n+=1
    return c[:360]


def _calendar_group(alias:str)->str:
    if alias=='Date' or alias.startswith('Date') or alias.startswith('Fmt_'): return 'Core & Formats'
    if alias.startswith('Day') or alias.startswith('IsMonday') or alias.startswith('IsTuesday') or alias.startswith('IsWednesday') or alias.startswith('IsThursday') or alias.startswith('IsFriday') or alias.startswith('IsSaturday') or alias.startswith('IsSunday') or alias in ('IsWeekend','IsWeekday','BusinessDayOfWeek'): return 'Day'
    if alias.startswith('Week') or alias.startswith('ISOWeek') or alias.startswith('YearWeek') or 'WeekOfMonth' in alias or alias.startswith('IsCurrentWeek') or alias.startswith('IsPreviousWeek') or alias.startswith('IsNextWeek') or alias.startswith('WeekOffset') or 'Weeks' in alias: return 'Week'
    if alias.startswith('Month') or alias.startswith('YearMonth') or alias.startswith('IsCurrentMonth') or alias.startswith('IsPreviousMonth') or alias.startswith('IsNextMonth') or alias.startswith('MonthOffset') or 'Months' in alias or alias in ('DaysInMonth','IsMonthStart','IsMonthEnd'): return 'Month'
    if alias.startswith('Quarter') or alias.startswith('YearQuarter') or alias.startswith('IsCurrentQuarter') or alias.startswith('IsPreviousQuarter') or alias.startswith('IsNextQuarter') or alias.startswith('QuarterOffset') or alias in ('IsQuarterStart','IsQuarterEnd','DayOfQuarter'): return 'Quarter'
    if alias.startswith('Fiscal'): return 'Fiscal'
    if alias.startswith('Year') or alias.startswith('IsCurrentYear') or alias.startswith('IsPreviousYear') or alias.startswith('IsNextYear') or alias.startswith('YearOffset') or 'Years' in alias or alias in ('IsYearStart','IsYearEnd'): return 'Year'
    if alias.startswith('IsRolling') or alias in ('IsToday','IsYesterday','IsTomorrow','IsPast','IsFuture','DayOffset'): return 'Relative & Rolling'
    return 'Other'

def calendar_column_catalog():
    specs=_calendar_column_specs()
    recommended={
      'Date','DateKey','DateISO','Day','DayName','DayShort','DayOfWeek','DayOfYear',
      'WeekNumber','ISOWeekNumber','WeekStart','WeekEnd','WeekMonth','YearWeekKey','WeekOfMonth',
      'MonthNumber','MonthName','MonthShort','MonthYear','MonthYearSort','MonthStart','MonthEnd','YearMonthKey',
      'Quarter','QuarterNumber','QuarterYear','QuarterStart','QuarterEnd','YearQuarterKey',
      'Year','YearStart','YearEnd','IsWeekend','IsWeekday','IsToday','IsCurrentWeek','IsCurrentMonth','IsCurrentQuarter','IsCurrentYear',
      'DayOffset','WeekOffset','MonthOffset','QuarterOffset','YearOffset'
    }
    items=[{'name':a,'group':_calendar_group(a),'recommended':a in recommended} for a,_ in specs]
    groups=[]
    for g in ('Core & Formats','Day','Week','Month','Quarter','Year','Fiscal','Relative & Rolling','Other'):
        vals=[x for x in items if x['group']==g]
        if vals: groups.append({'name':g,'columns':vals})
    return {'count':len(items),'recommendedCount':sum(x['recommended'] for x in items),'groups':groups,'columns':items}

def _calendar_sql(start_sql:str,end_sql:str,selected_columns:list[str]|None=None):
    all_cols=_calendar_column_specs()
    lookup={a:(a,e) for a,e in all_cols}
    if selected_columns:
        wanted=[]
        for name in selected_columns:
            if name in lookup and name not in wanted:wanted.append(name)
        if 'Date' not in wanted:wanted.insert(0,'Date')
        cols=[lookup[n] for n in wanted]
    else:
        cols=all_cols
    projection=',\n      '.join(f'{expr} AS "{alias}"' if alias!='Date' else 'Date' for alias,expr in cols)
    return f"""
    WITH bounds AS (
      SELECT CAST({start_sql} AS DATE) AS start_date, CAST({end_sql} AS DATE) AS end_date
    ), dates AS (
      SELECT CAST(r.d AS DATE) AS Date
      FROM bounds b,
      range(b.start_date, b.end_date + INTERVAL 1 DAY, INTERVAL 1 DAY) r(d)
    )
    SELECT
      {projection}
    FROM dates
    ORDER BY Date
    """

def create_calendar_table(name:str,start_date:str|None=None,end_date:str|None=None,source_table:str|None=None,source_column:str|None=None,selected_columns:list[str]|None=None):
    ensure_analytics_ready()
    """Create a persisted ZSTD Parquet calendar table using the user-selected date attributes."""
    safe=''.join(c if c.isalnum() or c=='_' else '_' for c in (name or 'Calendar')).strip('_') or 'Calendar'
    if safe[0].isdigit():safe='Calendar_'+safe
    table='Calendar' if safe.lower()=='calendar' else ('Calendar_'+safe[:70] if not safe.startswith('Calendar_') else safe[:80])
    path=_parquet_path(table)
    con=connect()
    try:
        if source_table and source_column:
            st='"'+source_table.replace('"','""')+'"';sc='"'+source_column.replace('"','""')+'"'
            row=con.execute(f'SELECT MIN(TRY_CAST({sc} AS DATE)), MAX(TRY_CAST({sc} AS DATE)) FROM {st}').fetchone()
            if not row or not row[0] or not row[1]:raise ValueError('The selected source column does not contain a usable date range.')
            start_date=str(row[0]);end_date=str(row[1])
        if not start_date or not end_date:raise ValueError('Start Date and End Date are required.')
        if str(start_date)>str(end_date):raise ValueError('Start Date must be earlier than or equal to End Date.')
        sql=_calendar_sql(_sql_string(start_date),_sql_string(end_date),selected_columns)
        con.execute(f"COPY ({sql}) TO {_path_sql(path)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)")
        _create_view(con,table,path)
        rows=con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    finally:con.close()
    _record(table,rows,None,path.stat().st_size,path,'calendar')
    return {'table':table,'rows':rows,'startDate':start_date,'endDate':end_date,'columns':table_columns(table),'selectedColumns':selected_columns or [x[0] for x in _calendar_column_specs()]}
