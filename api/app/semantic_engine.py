from __future__ import annotations
import re, json, hashlib, time, threading
from collections import OrderedDict
from .dax_engine import strip_assignment
from .dax_v2 import analyze_measure as analyze_dax_v2
from .dax_v2.storage_adapter import compile_for_duckdb
from .local_engine import connect, ensure_analytics_ready

def q(x):return '"'+str(x).replace('"','""')+'"'
def resolve_table_name(model,name):
    raw=str(name or '').strip().strip("'\"")
    return next((table for table in model.get('tables',{}) if table.casefold()==raw.casefold()),raw)
def fld(model,dotted):
    t,c=dotted.split('.',1);part=None
    if '::' in c:c,part=c.rsplit('::',1)
    t = t.strip().strip("'\"")
    c = c.strip().strip("'\"")
    tables=model["tables"]
    actual_t=resolve_table_name(model,t)
    tcols=tables[actual_t]["columns"]
    actual_c=next((k for k in tcols if k.lower()==c.lower()),c)
    physical=tcols[actual_c];base=f'{q(actual_t)}.{q(physical)}'
    if not part:return base
    d=f'TRY_CAST({base} AS DATE)';p=part.lower()
    if p=='year':return f'year({d})'
    if p=='quarter':return f"CAST(year({d}) AS VARCHAR) || 'Q' || CAST(quarter({d}) AS VARCHAR)"
    if p=='month':return f"strftime({d}, '%Y-%m')"
    if p=='week':return f"strftime({d}, '%Y-W%W')"
    if p=='day':return f'CAST({d} AS DATE)'
    raise ValueError(f'Unsupported date hierarchy part: {part}')

def _measure_name_key(value):
    """Power BI-friendly lookup key for legacy underscore/case variants."""
    return re.sub(r'[\s_-]+','',str(value or '')).casefold()

def normalize_binding_name(value):
    """Normalize field-well payloads from current and legacy report versions."""
    raw=str(value or '').strip()
    # Drag payload prefixes should normally be removed by the UI.  Treat the API
    # as the compatibility boundary as imported/older reports can retain them.
    raw=re.sub(r'(?i)^(?:field|numericfield|hierarchy|measure):','',raw).strip()
    return raw

def resolve_measure_name(name,measures):
    """Resolve an exact measure name first, then a unique friendly alias.

    Older VTAB editors converted spaces to underscores.  Keeping this alias
    lookup lets [Total Discount], [total_discount], and [TOTAL-DISCOUNT]
    reference the same saved measure without weakening exact-name behavior.
    """
    name=normalize_binding_name(name)
    if len(name)>=2 and name[0]=='[' and name[-1]==']':name=name[1:-1].strip()
    if name in measures:return name
    short_name = str(name or '').split('.', 1)[1] if '.' in str(name or '') else None
    if short_name and short_name in measures: return short_name
    folded=str(name or '').casefold()
    case_matches=[candidate for candidate in measures if str(candidate).casefold()==folded]
    if len(case_matches)==1:return case_matches[0]
    if short_name:
        short_folded = short_name.casefold()
        short_matches = [candidate for candidate in measures if str(candidate).casefold()==short_folded]
        if len(short_matches)==1:return short_matches[0]
    key=_measure_name_key(name)
    alias_matches=[candidate for candidate in measures if _measure_name_key(candidate)==key]
    if len(alias_matches)==1:return alias_matches[0]
    if short_name:
        key_short = _measure_name_key(short_name)
        alias_short = [candidate for candidate in measures if _measure_name_key(candidate)==key_short]
        if len(alias_short)==1:return alias_short[0]
    if len(alias_matches)>1:
        raise ValueError(f"Ambiguous measure reference [{name}]. Use the exact saved measure name.")
    return None

def _expression_references_table(expression,table):
    """Return True when DAX references a semantic table, quoted or unquoted.

    Power BI commonly emits 'Table Name'[Column].  The relationship planner used
    to detect only Table[Column], so measure-only cards could compile a valid
    expression whose table alias was missing from FROM.
    """
    text=str(expression or '')
    escaped=re.escape(str(table))
    quoted=re.escape("'"+str(table).replace("'","''")+"'")
    column_reference=re.search(r'(?i)(?:'+quoted+r'|(?<![A-Za-z0-9_])'+escaped+r')\s*\[',text)
    # Table iterators and COUNTROWS reference a table without a [Column].  They
    # still determine the FROM table and relationship path for a visual query.
    table_argument=re.search(
        r'(?i)\b(?:COUNTROWS|SUMX|AVERAGEX|MINX|MAXX|FILTER)\s*\(\s*'
        r'(?:'+quoted+r'|(?<![A-Za-z0-9_])'+escaped+r')\s*(?:,|\))',
        text,
    )
    return bool(column_reference or table_argument)

def _measure_dependency_names(model,requested):
    measures=model.get('measures',{})
    names=set()
    for requested_name in requested:
        resolved=resolve_measure_name(requested_name,measures)
        if resolved is not None:names.add(resolved)
    changed=True
    while changed:
        changed=False
        for name in list(names):
            expression=str(measures.get(name,'') or '')
            for ref in re.findall(r'(?<![A-Za-z0-9_])\[([^]]+)\]',expression):
                resolved=resolve_measure_name(ref,measures)
                if resolved is not None and resolved not in names:
                    names.add(resolved);changed=True
    return names

def _aggregate_reference_tables(model,expression):
    """Tables that provide values to an aggregate, excluding filter-only tables."""
    text=str(expression or '')
    owners=set()
    functions=r'(?:SUM|AVERAGE|AVG|MIN|MAX|COUNT|DISTINCTCOUNT|MEDIAN|STDEV\.P|STDEV\.S|VAR\.P|VAR\.S|SUMX|AVERAGEX|MINX|MAXX)'
    for table in model.get('tables',{}):
        escaped=re.escape(table);quoted=re.escape("'"+table.replace("'","''")+"'")
        table_token=r'(?:'+quoted+r'|(?<![A-Za-z0-9_])'+escaped+r')'
        if re.search(r'(?i)\b'+functions+r'\s*\(\s*'+table_token+r'\s*\[',text):owners.add(table)
        if re.search(r'(?i)\bCOUNTROWS\s*\(\s*'+table_token+r'\s*\)',text):owners.add(table)
    return owners

def _sql_reference_tables(model,sql):
    """Use compiled SQL as the authoritative table-lineage source."""
    text=str(sql or '')
    return {table for table in model.get('tables',{}) if re.search(r'"'+re.escape(table)+r'"\s*\.',text,re.I)}

def _sql_aggregate_reference_tables(model,sql):
    """Find semantic tables feeding SQL aggregate calls.

    This complements DAX-text lineage for iterator/variable expressions.  The
    compiler output is definitive and avoids guessing from how a valid DAX
    expression happens to be formatted.
    """
    text=str(sql or '');owners=set()
    aggregate=re.compile(r'(?i)\b(?:SUM|AVG|AVERAGE|MIN|MAX|COUNT|MEDIAN|STDDEV(?:_POP|_SAMP)?|VAR(?:_POP|_SAMP)?|VARIANCE|ANY_VALUE)\s*\(')
    for match in aggregate.finditer(text):
        open_pos=text.find('(',match.start());depth=0;quote=None;close_pos=None;index=open_pos
        while index<len(text):
            char=text[index]
            if quote:
                if char==quote:
                    if index+1<len(text) and text[index+1]==quote:index+=2;continue
                    quote=None
                index+=1;continue
            if char in ("'",'"'):quote=char
            elif char=='(':depth+=1
            elif char==')':
                depth-=1
                if depth==0:close_pos=index;break
            index+=1
        if close_pos is not None:owners.update(_sql_reference_tables(model,text[open_pos+1:close_pos]))
    return owners

def _strip_unreachable_filter_clauses(sql,unreachable):
    """Remove aggregate FILTER clauses that target disconnected tables.

    DAX permits a filter on a disconnected table; it simply cannot propagate to
    the aggregate table. SQL cannot reference an alias that is absent from FROM,
    so retaining such a predicate caused DuckDB Binder/API 400 errors. Removing
    only the disconnected FILTER clause matches DAX filter-propagation semantics
    while preserving filters on connected tables.
    """
    blocked={str(table) for table in unreachable if table}
    if not blocked or 'FILTER' not in sql.upper():return sql
    marker=re.compile(r'(?i)\s+FILTER\s*\(\s*WHERE\s+')
    output=sql;offset=0
    while True:
        match=marker.search(output,offset)
        if not match:break
        open_pos=output.find('(',match.start());depth=0;quote=None;close_pos=None
        for index in range(open_pos,len(output)):
            char=output[index]
            if quote:
                if char==quote:
                    if index+1<len(output) and output[index+1]==quote:
                        continue
                    quote=None
                continue
            if char in ("'",'"'):quote=char;continue
            if char=='(':depth+=1
            elif char==')':
                depth-=1
                if depth==0:close_pos=index;break
        if close_pos is None:break
        predicate=output[open_pos+1:close_pos]
        references_blocked=any(re.search(r'"'+re.escape(table)+r'"\s*\.',predicate,re.I) for table in blocked)
        if references_blocked:
            output=output[:match.start()]+output[close_pos+1:]
            offset=max(0,match.start()-1)
        else:
            offset=close_pos+1
    return output

def measure(name,model,stack=None,context_filters=None,with_meta=False):
    stack=stack or []
    name=normalize_binding_name(name)
    agg_suffix = None
    if '::' in name:
        name, agg_suffix = name.split('::', 1)

    measures=model.get('measures',{})
    resolved_name=resolve_measure_name(name,measures)
    if resolved_name is not None:name=resolved_name
    if name in stack:
        raise ValueError('Circular measure dependency: '+' -> '.join(stack+[name]))

    if resolved_name is None:
        # Auto-aggregate raw column references (e.g. "Finance Data.LOAN AMOUNT")
        # that were dragged from the numeric fields pane directly into Values.
        if '.' in name:
            try:
                parts=name.split('.',1)
                t,c=parts[0].strip(),parts[1].strip()
                if t in model.get('tables',{}) and c in model['tables'][t].get('columns',{}):
                    field_sql = fld(model,name)
                    sql_agg = 'SUM'
                    if agg_suffix:
                        s = agg_suffix.strip().lower().replace('-','_').replace(' ','_')
                        suffix_map = {
                            'count': 'COUNT',
                            'min': 'MIN',
                            'max': 'MAX',
                            'avg': 'AVG',
                            'average': 'AVG',
                            'count_distinct': 'COUNT(DISTINCT ',
                            'distinctcount': 'COUNT(DISTINCT ',
                            'distinct_count': 'COUNT(DISTINCT ',
                            'countdistinct': 'COUNT(DISTINCT ',
                        }
                        sql_agg = suffix_map.get(s, 'SUM')
                    
                    # COUNT and DISTINCTCOUNT apply to text, dates, and numbers in
                    # DAX.  The former implementation converted every dragged
                    # column to DOUBLE first, silently turning names/IDs into NULL
                    # and producing incorrect counts.  Numeric conversion is only
                    # appropriate for arithmetic aggregations.
                    if sql_agg == 'COUNT(DISTINCT ':
                        sql = f"{sql_agg}{field_sql})"
                    elif sql_agg == 'COUNT':
                        sql = f"COUNT({field_sql})"
                    else:
                        numeric_sql = f'TRY_CAST({field_sql} AS DOUBLE)'
                        sql = f"{sql_agg}({numeric_sql})"
                    return (sql,set()) if with_meta else sql
            except Exception:
                pass
        raise ValueError(f"Unknown measure [{name}]")
    # Saved measures may contain the Power BI-style ``Name = expression`` form.
    # Every compiler route must consume only the right-hand expression. The DAX
    # route already stripped it, but the legacy dotted-column route did not,
    # producing SQL such as ``Measure_One = SUM(...) AS Measure_One`` that passed
    # editor validation and failed only when a visual executed it.
    saved_source=measures[name].strip()
    definition_source=saved_source if strip_assignment(saved_source)!=saved_source else f'{name} = {saved_source}'
    semantic=analyze_dax_v2(definition_source,model)
    if not semantic.valid:
        errors=[item for item in semantic.diagnostics if item.severity.value=='error']
        legacy_row_value=not model.get('measureDefinitions',{}).get(name) and errors and all(item.code=='DAX1013' for item in errors)
        if not legacy_row_value:
            first=errors[0] if errors else None
            raise ValueError(first.message if first else f'Measure [{name}] is not semantically valid.')
    # Visual execution consumes the exact canonical definition produced by the
    # same v2 parser/binder used by Validate and Save. This closes the historical
    # editor-valid/visual-fails split while DuckDB remains the storage adapter.
    exp=strip_assignment(semantic.canonical_source)

    def resolve_measure(ref):
        return measure(ref,model,stack+[name],context_filters,False)

    # Every validated canonical measure must pass through the storage adapter.
    # The previous heuristic bypassed compilation for scalar formulas without
    # field references (notably BLANK()), leaking DAX function names directly
    # into DuckDB and causing a visual-only API 400 after successful validation.
    c=compile_for_duckdb(exp,model,context_filters or [],resolve_measure)
    return (c.sql,c.override_fields) if with_meta else c.sql

def inline(exp,model,stack,context_filters=None):
    # Single quotes are valid in DAX table names e.g. SUM('Sales'[Amount])
    # Only block genuine SQL injection characters: semicolons, double quotes, backticks
    if re.search(r'[;"`]',exp):
        raise ValueError('Unsafe measure expression')
    out=exp
    for ref in re.findall(r'\[([^\]]+)\]',exp):
        out=out.replace(f'[{ref}]',f'({measure(ref,model,stack,context_filters,False)})')
    return out

def required(model,dims,measures,rls,filters=()):
    # Every field referenced by a visual dimension, slicer/cross-filter, page/report filter,
    # or RLS predicate must participate in relationship-path planning.  Previously filter
    # tables were omitted, so a Customers[CustomerName] slicer could be compiled into the
    # WHERE clause while only the Sales table existed in FROM, producing a DuckDB Binder Error.
    req={resolve_table_name(model,d.split('.',1)[0]) for d in dims}
    for f in filters or ():
        field=f.get('field') if isinstance(f,dict) else None
        if field and '.' in field:
            table=resolve_table_name(model,field.split('.',1)[0])
            if table in model.get('tables',{}):
                req.add(table)
    # Raw-column measures (e.g. "CHENNAI.Discount") are NOT in model["measures"] but still
    # carry a table prefix.  Without this block, their table never enters the FROM clause
    # and DuckDB raises "Binder Error: Referenced table '...' not found".
    for m in measures:
        if '.' in m and m not in model.get('measures',{}):
            t=resolve_table_name(model,m.split('.',1)[0])
            if t in model.get('tables',{}):
                req.add(t)
    names=_measure_dependency_names(model,measures)
    txt=' '.join(model.get('measures',{}).get(n,'') for n in names)
    for t in model['tables']:
        if t+'.' in txt or _expression_references_table(txt,t):req.add(t)
    for r in rls:req.add(resolve_table_name(model,r['table']))
    return req

_AGG_FUNC_RE = re.compile(r'\b(sum|count|avg|min|max|any_value|median|stddev|variance|first|last|approx_count_distinct)\s*\(', re.IGNORECASE)

def _ensure_aggregated(msql: str, groups: list) -> str:
    if not groups:
        return msql
    clean = msql.strip()
    if clean.startswith('(') and clean.endswith(')') and clean[1:].lstrip().upper().startswith('SELECT'):
        return msql
    if ' OVER ' in clean.upper() or ' OVER(' in clean.upper():
        return msql
    if _AGG_FUNC_RE.search(clean):
        return msql
    return f'ANY_VALUE({clean})'

def compile_query(model,req,rls=()):
    dims=list(dict.fromkeys(normalize_binding_name(x) for x in (req.get('dimensions',[]) or []) if normalize_binding_name(x)))
    meas=list(dict.fromkeys(normalize_binding_name(x) for x in (req.get('measures',[]) or []) if normalize_binding_name(x)))
    filters=req.get('filters',[]) or []
    # Older reports and flexible visuals can persist a measure in a dimension
    # well (notably Map Color/Label). Normalize it before relationship planning;
    # doing this later left the measure's source table out of FROM and surfaced as
    # an API 400 even though the measure itself was valid.
    normalized_dims=[]
    for dimension in dims:
        candidate=dimension.split('::',1)[0]
        if resolve_measure_name(candidate,model.get('measures',{})) is not None:
            if dimension not in meas:meas.append(dimension)
        else:
            normalized_dims.append(dimension)
    dims=normalized_dims
    needed=set(required(model,dims,meas,rls,filters))
    if not model.get('tables'):
        raise ValueError('The Unified Data Model has no tables.')

    # Compile measures before planning FROM/JOIN.  A formula can validate in
    # isolation yet expand to table references that simple DAX-text heuristics
    # miss (nested variables, iterators and dependent measures).  Planning from
    # the compiled SQL closes that gap for every visual type using this endpoint.
    compiled_measures=[]
    sql_reference_tables=set();sql_aggregate_tables=set()
    for m in meas:
        msql,mover=measure(m,model,context_filters=filters,with_meta=True)
        compiled_measures.append((m,msql,mover))
        sql_reference_tables.update(_sql_reference_tables(model,msql))
        sql_aggregate_tables.update(_sql_aggregate_reference_tables(model,msql))
    needed.update(sql_reference_tables)

    # Prefer the table that owns a measure, then a raw-value column, then a dimension.
    # This keeps fact-table aggregation stable while still allowing slicers/dimensions to
    # join through one or more bridge tables.
    dependency_names=_measure_dependency_names(model,meas)
    measure_text=' '.join(str(model.get('measures',{}).get(m,'') or '') for m in dependency_names)
    preferred=[]
    # When a measure combines an aggregate from a fact table with a date-table
    # filter, start from the aggregate owner. Starting from Calendar was able to
    # emit SUM("Lead CRM"."Revenue") without ever adding Lead CRM to FROM.
    text_aggregate_tables=_aggregate_reference_tables(model,measure_text)
    # DAX lineage is more precise for time-intelligence functions because their
    # compiled SQL also contains MAX(date) context subqueries. Fall back to SQL
    # lineage only for iterator/variable shapes the text classifier cannot see.
    aggregate_tables=text_aggregate_tables or sql_aggregate_tables
    for table in model.get('tables',{}):
        if table in needed and table in aggregate_tables:preferred.append(table)
    for table in model.get('tables',{}):
        if table in needed and table not in preferred and (table+'.' in measure_text or _expression_references_table(measure_text,table)):
            preferred.append(table)
    if not preferred:
        for m in meas:
            if '.' in m and m not in model.get('measures',{}):
                t=m.split('.',1)[0]
                if t in needed and t not in preferred: preferred.append(t)
    if not preferred:
        for d in dims:
            t=d.split('.',1)[0]
            if t in needed and t not in preferred: preferred.append(t)
    base=preferred[0] if preferred else ('Sales' if 'Sales' in needed else next(iter(needed or model['tables'])))

    # Build an undirected graph from active relationships and find a path from the
    # base table to every required table. The previous implementation only joined a
    # relationship when the immediately-adjacent table was itself required. That
    # failed for A -> Bridge -> C and left C referenced in SELECT/WHERE without C in
    # FROM, which DuckDB reported as a Binder Error / API 400.
    relationships=[r for r in model.get('relationships',[]) if r.get('active',True) is not False]
    graph={t:[] for t in model.get('tables',{})}
    for idx,r in enumerate(relationships):
        a=resolve_table_name(model,r.get('fromTable'));b=resolve_table_name(model,r.get('toTable'))
        if a in graph and b in graph:
            graph[a].append((b,idx));graph[b].append((a,idx))

    def path_to(target):
        if target==base:return []
        queue=[base];parent={base:None};edge_used={}
        for cur in queue:
            for nxt,edge_idx in graph.get(cur,[]):
                if nxt in parent:continue
                parent[nxt]=cur;edge_used[nxt]=edge_idx
                if nxt==target:
                    queue=[];break
                queue.append(nxt)
            else:
                continue
            break
        if target not in parent:return None
        path=[];node=target
        while node!=base:
            prev=parent[node];path.append((prev,node,edge_used[node]));node=prev
        path.reverse();return path

    joined={base};joins=[];unreachable=set()
    for target in sorted(needed):
        if target in joined:continue
        path=path_to(target)
        if path is None:
            unreachable.add(target);continue
        for prev,nxt,edge_idx in path:
            if nxt in joined:continue
            r=relationships[edge_idx];a=resolve_table_name(model,r['fromTable']);b=resolve_table_name(model,r['toTable'])
            # Both aliases use their semantic table names, so the relationship
            # expression is direction-independent.
            if nxt not in model['tables']:
                raise ValueError(f"Relationship references unknown table '{nxt}'.")
            joins.append(
                f'LEFT JOIN {q(model["tables"][nxt].get("physical") or nxt)} {q(nxt)} ON '
                f'{fld(model,a+"."+r["fromColumn"])}={fld(model,b+"."+r["toColumn"])}'
            )
            joined.add(nxt)

    # A disconnected filter can be ignored (same behavior as before), but a
    # dimension/measure/RLS table must be reachable or the query would otherwise
    # reference a missing alias and fail with a Binder Error.
    critical={resolve_table_name(model,d.split('.',1)[0]) for d in dims if '.' in d}
    # A filter-only table inside CALCULATE/TOTALMTD is not critical when it is
    # disconnected: DAX does not propagate that filter to the fact table. Only
    # aggregate-owner tables must be reachable for a measure-only visual.
    critical.update(aggregate_tables)
    critical.update(resolve_table_name(model,r.get('table')) for r in rls if r.get('table'))
    blocked=unreachable & critical
    if blocked:
        raise ValueError('No active relationship path connects the selected visual fields: '+', '.join(sorted(blocked)))

    sel=[];groups=[];override_fields=set()
    for d in dims:
        if '.' not in d:
            found = False
            for t_name, t_def in model.get('tables', {}).items():
                if d in t_def.get('columns', {}):
                    d = f'{t_name}.{d}'
                    found = True
                    break
            if not found:
                if d in model.get('measures', {}) and d not in meas:
                    meas.append(d)
                continue
        if resolve_table_name(model,d.split('.',1)[0]) in unreachable:continue
        x=fld(model,d);sel.append(f'{x} AS {q(d)}');groups.append(x)
    for m,msql,mover in compiled_measures:
        override_fields.update(mover)
        msql=_strip_unreachable_filter_clauses(msql,unreachable)
        msql=_ensure_aggregated(msql, groups)
        sel.append(f'{msql} AS {q(m)}')
    if not sel:
        # Slicers normally provide a dimension; this protects malformed empty requests.
        sel=['1 AS "Value"']
    bt=model['tables'][base];base_phys=bt.get('physical') or base;sql=f'SELECT {", ".join(sel)} FROM {q(base_phys)} {q(base)}'
    if joins:sql+=' '+' '.join(joins)

    wh=[];params=[]
    for f in filters:
        f_field=f.get('field','')
        if not f_field or '.' not in f_field:continue
        t_name = resolve_table_name(model,f_field.split('.')[0])
        if f_field in override_fields or f"{t_name}.*" in override_fields:continue
        if t_name in unreachable:continue
        field_sql=fld(model,f_field)
        
        def get_cond(op, val, field_sql):
            if op == 'is_blank': return f"({field_sql} IS NULL OR TRIM(CAST({field_sql} AS VARCHAR)) = '')", []
            if op == 'is_not_blank': return f"({field_sql} IS NOT NULL AND TRIM(CAST({field_sql} AS VARCHAR)) <> '')", []
            if op == 'contains': return f"{field_sql} LIKE ?", [f"%{val}%"]
            if op == 'does_not_contain': return f"{field_sql} NOT LIKE ?", [f"%{val}%"]
            if op == 'starts_with': return f"{field_sql} LIKE ?", [f"{val}%"]
            if op == 'ends_with': return f"{field_sql} LIKE ?", [f"%{val}"]
            if op == 'between' and isinstance(val,(list,tuple)) and len(val)==2: return f"{field_sql} BETWEEN ? AND ?", [val[0], val[1]]
            if op == 'in':
                vals = val if isinstance(val,(list,tuple)) else [x.strip() for x in str(val).split(',') if x.strip()]
                if not vals: return '1=0', []
                return f"{field_sql} IN (" + ','.join('?' for _ in vals) + ")", list(vals)
            if op == 'top_n':
                try: limit_n = min(5000, max(1, int(val)))
                except: raise ValueError('Top N requires a positive whole-number item count.')
                direction = str(f.get('rankingDirection') or 'top').lower()
                if direction not in ('top','bottom'):
                    raise ValueError('Top N direction must be Top or Bottom.')
                sort_dir = 'asc' if direction == 'bottom' else 'desc'
                ranking_field = f.get('rankingField')
                if not ranking_field:
                    raise ValueError('Top N requires a numeric field or measure in By value.')
                
                sub_filters = [of for of in filters if of is not f and of.get('operator') != 'top_n']
                sub_req = {
                    'dimensions': [f_field],
                    'measures': [ranking_field],
                    'filters': sub_filters,
                    'sort': [],
                    'limit': 50000
                }
                sub_sql, sub_params = compile_query(model, sub_req, rls)
                alias = f"__topn_{len(wh)}"
                # Rank aggregated dimension members inside the current filter
                # context. Null ranking values are excluded. Ties at the Nth
                # position are resolved by the dimension ascending, retaining
                # exactly N members without changing the visual's display sort.
                ranked = (
                    f"SELECT {q(f_field)} FROM ({sub_sql}) {alias} "
                    f"WHERE {q(ranking_field)} IS NOT NULL "
                    f"ORDER BY {q(ranking_field)} {sort_dir.upper()}, {q(f_field)} ASC "
                    f"LIMIT {limit_n}"
                )
                return f"{field_sql} IN ({ranked})", sub_params
            if op in ('relative_date', 'relative_time'):
                v = val if isinstance(val, dict) else {}
                direction = str(v.get('direction', 'last')).lower()
                amount = int(v.get('amount', 30))
                unit = str(v.get('unit', 'day')).lower()
                inc = bool(v.get('includeToday', False))
                if unit.endswith('s'): unit = unit[:-1]
                base = 'CURRENT_DATE' if op == 'relative_date' else 'NOW()'
                
                if direction == 'last':
                    start_expr = f"{base} - INTERVAL '{amount} {unit}'"
                    if op == 'relative_date': start_expr = f"CAST(DATE_TRUNC('{unit}', {start_expr}) AS DATE)"
                    else: start_expr = f"DATE_TRUNC('{unit}', {start_expr})"
                    if inc:
                        end_expr = f"CAST(DATE_TRUNC('day', {base}) + INTERVAL '1 day' - INTERVAL '1 microsecond' AS TIMESTAMP)" if op == 'relative_time' else base
                        return f"({field_sql} >= {start_expr} AND {field_sql} <= {end_expr})", []
                    else:
                        end_expr = f"CAST(DATE_TRUNC('day', {base}) AS TIMESTAMP)" if op == 'relative_time' else f"CAST(DATE_TRUNC('day', {base}) AS DATE)"
                        return f"({field_sql} >= {start_expr} AND {field_sql} < {end_expr})", []
                elif direction == 'next':
                    start_expr = base if inc else f"CAST(DATE_TRUNC('day', {base}) + INTERVAL '1 day' AS {'TIMESTAMP' if op == 'relative_time' else 'DATE'})"
                    end_expr = f"{base} + INTERVAL '{amount} {unit}'"
                    return f"({field_sql} >= {start_expr} AND {field_sql} <= {end_expr})", []
                elif direction == 'this':
                    start_expr = f"DATE_TRUNC('{unit}', {base})"
                    end_expr = f"({start_expr} + INTERVAL '1 {unit}')"
                    return f"({field_sql} >= {start_expr} AND {field_sql} < {end_expr})", []
            ops = {'equals':'=','not_equals':'<>','gt':'>','gte':'>=','lt':'<','lte':'<='}
            if op in ops: return f"{field_sql} {ops[op]} ?", [val]
            raise ValueError(f"Unsupported filter operator: {op}")

        cond1, params1 = get_cond(f.get('operator', 'equals'), f.get('value'), field_sql)
        op2 = f.get('operator2')
        if op2:
            cond2, params2 = get_cond(op2, f.get('value2'), field_sql)
            logic = f.get('condition', 'AND').upper()
            wh.append(f"({cond1} {logic} {cond2})")
            params.extend(params1 + params2)
        else:
            wh.append(cond1)
            params.extend(params1)
    # Rules inside a role are ANDed; separately assigned roles are unioned (OR),
    # matching Power BI's additive multi-role semantics.  The role id is trusted
    # metadata added by the server-side security resolver, never by the browser.
    role_groups={}
    for r in rls:role_groups.setdefault(str(r.get('_roleId') or '__single__'),[]).append(r)
    role_sql=[];role_params=[]
    for _,rules in role_groups.items():
        parts=[];part_params=[]
        for r in rules:
            op=r.get('operator','equals')
            if op=='deny_all':parts.append('1=0');continue
            if r.get('table') in unreachable:
                raise ValueError('RLS table is not connected to the visual query: '+str(r.get('table')))
            field_sql=fld(model,r['table']+'.'+r['column']);val=r.get('value')
            ops={'equals':'=','not_equals':'<>','gt':'>','gte':'>=','lt':'<','lte':'<='}
            if op=='contains':parts.append(field_sql+' LIKE ?');part_params.append('%'+str(val)+'%')
            elif op=='in':
                vals=val if isinstance(val,(list,tuple)) else [x.strip() for x in str(val).split(',') if x.strip()]
                if not vals:parts.append('1=0')
                else:parts.append(field_sql+' IN ('+','.join('?' for _ in vals)+')');part_params.extend(vals)
            elif op in ops:parts.append(field_sql+' '+ops[op]+' ?');part_params.append(val)
            else:raise ValueError('Unsupported RLS operator: '+str(op))
        role_sql.append('('+' AND '.join(parts or ['1=0'])+')');role_params.extend(part_params)
    if role_sql:wh.append('('+' OR '.join(role_sql)+')');params.extend(role_params)
    if wh:sql+=' WHERE '+' AND '.join(wh)
    if meas or req.get('distinct'):
        if groups:sql+=' GROUP BY '+', '.join(groups)
    sort=req.get('sort',[]) or []
    if sort:
        valid_aliases=set(dims+meas)
        safe_sort=[x for x in sort if x.get('field') in valid_aliases]
        if safe_sort:sql+=' ORDER BY '+', '.join(q(x['field'])+' '+('DESC' if x.get('direction')=='desc' else 'ASC') for x in safe_sort)
    elif meas or dims:
        fallback_sort=[]
        if meas:fallback_sort.append(q(meas[0])+' DESC')
        fallback_sort.extend(q(field)+' ASC' for field in dims)
        if fallback_sort:sql+=' ORDER BY '+', '.join(fallback_sort)
    sql+=' LIMIT '+str(min(max(int(req.get('limit',200)),1),50000))
    # Fail at the semantic boundary with an actionable planner error instead of
    # leaking a generic DuckDB Binder Error as "API 400" to every visual.
    bound_aliases=set(re.findall(r'(?i)(?:FROM|JOIN)\s+"[^"]+"\s+"([^"]+)"',sql))
    missing_aliases=_sql_reference_tables(model,sql)-bound_aliases
    if missing_aliases:
        raise ValueError('Visual query planning could not bind semantic table(s): '+', '.join(sorted(missing_aliases))+'. Check active model relationships.')
    return sql,params

def semantic_query_health():
    """Self-test the measure-to-visual planner used by every query endpoint."""
    model={
        'tables':{
            'Calendar':{'physical':'__health_calendar','columns':{'Date':'Date'}},
            'Sales Fact':{'physical':'__health_sales','columns':{'Date':'Date','Region':'Region','Revenue':'Revenue'}},
        },
        'relationships':[{'fromTable':'Calendar','fromColumn':'Date','toTable':'Sales Fact','toColumn':'Date','active':True}],
        'measures':{
            'Total Revenue':"SUM('Sales Fact'[Revenue])",
            'Current Revenue':"TOTALMTD([Total Revenue],Calendar[Date])",
        },
    }
    cases={
        'card':{'dimensions':[],'measures':['measure:Current Revenue']},
        'bar':{'dimensions':['Sales Fact.Region'],'measures':['Current Revenue']},
        'line':{'dimensions':['Calendar.Date::month'],'measures':['Current Revenue']},
    }
    disconnected={**model,'relationships':[]}
    failures=[]
    for name,request in cases.items():
        try:
            sql,_=compile_query(model,request)
            if '"Sales Fact".' not in sql:raise ValueError('fact table missing from compiled query')
        except Exception as exc:failures.append({'case':'visual-'+name,'error':str(exc)})
    try:
        sql,_=compile_query(disconnected,{'dimensions':[],'measures':['Current Revenue']})
        if '"Calendar".' in sql:raise ValueError('disconnected date filter leaked into fact query')
    except Exception as exc:failures.append({'case':'visual-disconnected-filter','error':str(exc)})
    return {'healthy':not failures,'checks':len(cases)+1,'failures':failures,'plannerVersion':'2026.10.21.2'}

_CACHE=OrderedDict()
_CACHE_LOCK=threading.Lock()
_CACHE_HITS=0
_CACHE_MISSES=0
_CACHE_MAX=256
_CACHE_TTL=45.0
# Separate lock to serialize DuckDB DDL (CREATE OR REPLACE VIEW).
# DuckDB single-file mode does not allow concurrent catalog writes,
# which causes TransactionContext write-conflict errors when multiple
# published-report visuals fire queries at the same time.
_DDL_LOCK=threading.Lock()

def _cache_key(model,req,rls):
    payload=json.dumps({'model':model,'req':req,'rls':list(rls)},sort_keys=True,separators=(',',':'),default=str)
    return hashlib.sha256(payload.encode()).hexdigest()

def cache_stats():
    with _CACHE_LOCK:
        return {'entries':len(_CACHE),'hits':_CACHE_HITS,'misses':_CACHE_MISSES,'ttlSeconds':_CACHE_TTL,'maxEntries':_CACHE_MAX}

def clear_cache():
    with _CACHE_LOCK:_CACHE.clear()

def execute(model,req,rls=()):
    global _CACHE_HITS,_CACHE_MISSES
    # Semantic queries are the first operation for some desktop sessions. Make
    # sure persisted Parquet views and bundled reference tables are available.
    ensure_analytics_ready()
    key=_cache_key(model,req,rls);now=time.time()
    with _CACHE_LOCK:
        hit=_CACHE.get(key)
        if hit and now-hit[0]<_CACHE_TTL:
            _CACHE.move_to_end(key);_CACHE_HITS+=1
            return hit[1],hit[2]
        _CACHE_MISSES+=1
    sql,p=compile_query(model,req,rls);c=connect()
    try:
        from .local_engine import _sql_string
        with _DDL_LOCK:
            for t_name, t_def in model.get('tables', {}).items():
                source_url = t_def.get('sourceUrl')
                if source_url:
                    physical_name = t_def.get('physical', t_name)
                    view_name = physical_name.replace('"', '""')
                    c.execute(f"CREATE OR REPLACE VIEW \"{view_name}\" AS SELECT * FROM read_parquet({_sql_string(source_url)})")
            cur=c.execute(sql,p);cols=[d[0] for d in cur.description]
            rows=[dict(zip(cols,r)) for r in cur.fetchall()]
    finally:c.close()
    with _CACHE_LOCK:
        _CACHE[key]=(now,rows,sql);_CACHE.move_to_end(key)
        while len(_CACHE)>_CACHE_MAX:_CACHE.popitem(last=False)
    return rows,sql
