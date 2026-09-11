from __future__ import annotations
import re
from dataclasses import dataclass
from .gemini import generate_json

class DaxError(ValueError): pass

def qi(x:str)->str:return '"'+str(x).replace('"','""')+'"'
def sql_literal(v):
    if v is None:return 'NULL'
    if isinstance(v,bool):return 'TRUE' if v else 'FALSE'
    if isinstance(v,(int,float)):return str(v)
    return "'"+str(v).replace("'","''")+"'"

def split_top(s:str):
    out=[];start=0;depth=0;quote=None
    for i,ch in enumerate(s):
        if quote:
            if ch==quote and (i==0 or s[i-1]!='\\'):quote=None
            continue
        if ch in ("'",'"'):quote=ch
        elif ch=='(':depth+=1
        elif ch==')':depth-=1
        elif ch==',' and depth==0:out.append(s[start:i].strip());start=i+1
    out.append(s[start:].strip())
    return [x for x in out if x]

def strip_assignment(expression:str):
    text=expression.strip()
    m=re.match(r'^([A-Za-z_][A-Za-z0-9_ ]*)\s*=\s*(.*)$',text,re.S)
    return m.group(2).strip() if m else text

def normalize(s):return re.sub(r'[^a-z0-9]','',s.lower())

def resolve_field(model,table,column,alias=None):
    table=table.strip();column=column.strip()
    if table not in model.get('tables',{}):raise DaxError(f"Unknown table '{table}'")
    cols=model['tables'][table].get('columns',{})
    if column not in cols:raise DaxError(f"Unknown column '{table}[{column}]'")
    return f'{qi(alias or table)}.{qi(cols[column])}'

def semantic_field(table,column):return f'{table.strip()}.{column.strip()}'

def parse_field(expr):
    m=re.fullmatch(r"\s*'?([A-Za-z_][\w ]*)'?\s*\[\s*([^\]]+)\]\s*",expr,re.S)
    return (m.group(1).strip(),m.group(2).strip()) if m else None

def _context_predicate(model,table,filters,alias):
    parts=[]
    for f in filters or []:
        sf=f.get('field','')
        if '.' not in sf:continue
        t,c=sf.split('.',1);c=c.split('::',1)[0]
        if t!=table or c not in model['tables'][table].get('columns',{}):continue
        col=resolve_field(model,t,c,alias);op=f.get('operator','equals');val=f.get('value')
        if op=='equals':parts.append(f'{col}={sql_literal(val)}')
        elif op=='not_equals':parts.append(f'{col}<>{sql_literal(val)}')
        elif op=='gt':parts.append(f'{col}>{sql_literal(val)}')
        elif op=='gte':parts.append(f'{col}>={sql_literal(val)}')
        elif op=='lt':parts.append(f'{col}<{sql_literal(val)}')
        elif op=='lte':parts.append(f'{col}<={sql_literal(val)}')
        elif op=='contains':parts.append(f'{col} LIKE {sql_literal("%"+str(val)+"%")}')
        elif op=='between' and isinstance(val,(list,tuple)) and len(val)==2:
            parts.append(f'{col} BETWEEN {sql_literal(val[0])} AND {sql_literal(val[1])}')
    return ' AND '.join(parts)

def _selected_aggregate(model,func,table,column,filters):
    alias='__ctx';physical=model['tables'][table]['physical'];col=resolve_field(model,table,column,alias)
    pred=_context_predicate(model,table,filters,alias)
    sql=f'(SELECT {func}({col}) FROM {qi(physical)} {qi(alias)}'
    if pred:sql+=' WHERE '+pred
    return sql+')'

def _selected_bounds(model,table,column,filters):
    return (
        _selected_aggregate(model,'MIN',table,column,filters),
        _selected_aggregate(model,'MAX',table,column,filters)
    )

def _parse_vars(text):
    lines=text.replace('\r','').split('\n');variables={};ret=[];current=None;buf=[];in_return=False
    def flush():
        nonlocal current,buf
        if current is not None:variables[current]=' '.join(x.strip() for x in buf).strip()
        current=None;buf=[]
    for line in lines:
        st=line.strip()
        if not st:continue
        m=re.match(r'(?i)^VAR\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$',st)
        if m and not in_return:flush();current=m.group(1);buf=[m.group(2)];continue
        if re.match(r'(?i)^RETURN\b',st):
            flush();in_return=True;tail=re.sub(r'(?i)^RETURN\b','',st,count=1).strip()
            if tail:ret.append(tail)
            continue
        (ret if in_return else buf).append(st)
    flush()
    if not ret:raise DaxError('VAR expression requires RETURN')
    return variables,' '.join(ret)

def _compile_var_value(expr,model,vars_sql,filters,measure_resolver=None):
    """Compile a VAR assignment value. Supports all aggregate functions, DIVIDE, arithmetic,
    and measure references. Variable references are resolved before compilation."""
    expr=expr.strip()
    # Resolve variable references that appear directly as value
    if expr in vars_sql:return vars_sql[expr]
    # MAX/MIN with context filter (date range subqueries)
    m=re.fullmatch(r'(?is)(MAX|MIN)\s*\(\s*([A-Za-z_][\w ]*)\s*\[\s*([^\]]+)\]\s*\)',expr)
    if m:return _selected_aggregate(model,m.group(1).upper(),m.group(2).strip(),m.group(3).strip(),filters)
    # EDATE
    m=re.fullmatch(r'(?is)EDATE\s*\(\s*([A-Za-z_]\w*)\s*,\s*(-?\d+)\s*\)\s*(?:\+\s*(\d+))?',expr)
    if m:
        var=m.group(1);months=int(m.group(2));days=int(m.group(3) or 0)
        base=vars_sql[var] if var in vars_sql else var
        out=f"(CAST({base} AS DATE) + INTERVAL '{months} months')"
        if days:out=f"({out} + INTERVAL '{days} day')"
        return out
    # EOMONTH
    m=re.fullmatch(r'(?is)EOMONTH\s*\(\s*([A-Za-z_]\w*)\s*,\s*(-?\d+)\s*\)\s*(?:\+\s*(\d+))?',expr)
    if m:
        var=m.group(1);months=int(m.group(2));days=int(m.group(3) or 0)
        base=vars_sql[var] if var in vars_sql else var
        out=f"last_day(CAST({base} AS DATE) + INTERVAL '{months} months')"
        if days:out=f"({out} + INTERVAL '{days} day')"
        return out
    if re.fullmatch(r'(?i)TODAY\s*\(\s*\)',expr):return 'current_date'
    if re.fullmatch(r'-?\d+(?:\.\d+)?',expr):return expr
    
    # For all other expressions, use _compile_simple
    def var_aware_resolver(name):
        if name in vars_sql:return vars_sql[name]
        if measure_resolver:return measure_resolver(name)
        raise DaxError(f"Unknown measure or variable [{name}]")
        
    try:
        return _compile_simple(expr,model,var_aware_resolver,filters)
    except DaxError:
        raise DaxError(f'Unsupported VAR expression: {expr}')

def _compile_row_expr(expr,model,table):
    out=expr.strip()
    for t,c in re.findall(r'([A-Za-z_][\w ]*)\s*\[([^\]]+)\]',out):
        if t.strip()!=table:raise DaxError('Iterator row expression currently supports columns from its iterator table.')
        out=out.replace(f'{t}[{c}]',resolve_field(model,t,c))
    if re.search(r'[^A-Za-z0-9_."+\-*/() \t]',out):raise DaxError('Unsupported iterator expression.')
    return out

def _is_wrapped(expr):
    if not (expr.startswith('(') and expr.endswith(')')): return False
    depth = 0; quote = None
    for i, ch in enumerate(expr):
        if quote:
            if ch==quote: quote=None
            continue
        if ch in ("'", '"'): quote=ch
        elif ch == '(': depth += 1
        elif ch == ')': depth -= 1
        if depth == 0 and i < len(expr) - 1: return False
    return depth == 0

def _compile_simple(expr,model,measure_resolver=None,filters=None):
    expr=expr.strip()
    if _is_wrapped(expr):
        return '(' + _compile_simple(expr[1:-1],model,measure_resolver,filters) + ')'
    if re.fullmatch(r'-?\d+(?:\.\d+)?',expr):return expr
    if (expr.startswith('"') and expr.endswith('"')) or (expr.startswith("'") and expr.endswith("'")):return sql_literal(expr[1:-1])
    if re.fullmatch(r'(?i)BLANK\s*\(\s*\)',expr):return 'NULL'
    if re.fullmatch(r'(?i)TRUE\s*\(\s*\)|TRUE',expr):return 'TRUE'
    if re.fullmatch(r'(?i)FALSE\s*\(\s*\)|FALSE',expr):return 'FALSE'
    m=re.fullmatch(r'(-?\d+(?:\.\d+)?)\s*%',expr)
    if m:return str(float(m.group(1))/100.0)
    m=re.fullmatch(r'\[([^\]]+)\]',expr)
    if m and measure_resolver:return measure_resolver(m.group(1).strip())
    # Handle naked variables like _Occupied
    m=re.fullmatch(r'[A-Za-z_]\w*',expr)
    if m and measure_resolver:return measure_resolver(m.group(0))

    m=re.fullmatch(r'(?is)(SUM|AVERAGE|AVG|MIN|MAX|COUNT|DISTINCTCOUNT|MEDIAN)\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*\)',expr)
    if m:
        fn,t,c=m.groups();fn=fn.upper();field=resolve_field(model,t.strip("'"),c)
        if fn=='AVERAGE':fn='AVG'
        if fn=='DISTINCTCOUNT':return f'COUNT(DISTINCT {field})'
        if fn=='MEDIAN':return f'MEDIAN({field})'
        return f'{fn}({field})'
    m=re.fullmatch(r'(?is)COUNTROWS\s*\(\s*(\'?.*?\'?)\s*\)',expr)
    if m:return 'COUNT(*)'
    m=re.fullmatch(r'(?is)(SUMX|AVERAGEX|MINX|MAXX)\s*\(\s*(\'?.*?\'?)\s*,\s*(.*)\)',expr)
    if m:
        fn,table,rowexpr=m.groups();fn={'SUMX':'SUM','AVERAGEX':'AVG','MINX':'MIN','MAXX':'MAX'}[fn.upper()]
        tbl=table.strip().strip("'")
        return f'{fn}({_compile_row_expr(rowexpr,model,tbl)})'

    for fn,sqlfn in [('ABS','ABS'),('INT','FLOOR'),('FLOOR','FLOOR'),('CEILING','CEIL'),('LEN','LENGTH')]:
        m=re.fullmatch(rf'(?is){fn}\s*\((.*)\)',expr)
        if m:return f'{sqlfn}({_compile_simple(m.group(1),model,measure_resolver,filters)})'
        
    m=re.fullmatch(r'(?is)ISBLANK\s*\((.*)\)',expr)
    if m:return f'({_compile_simple(m.group(1),model,measure_resolver,filters)} IS NULL)'
    m=re.fullmatch(r'(?is)NOT\s*\((.*)\)',expr)
    if m:return f'(NOT ({_condition(m.group(1),model,measure_resolver,filters)}))'
    m=re.fullmatch(r'(?is)(POWER)\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(2))
        if len(args)!=2:raise DaxError('POWER requires value and exponent.')
        return f'POWER({_compile_simple(args[0],model,measure_resolver,filters)},{_compile_simple(args[1],model,measure_resolver,filters)})'
    m=re.fullmatch(r'(?is)SQRT\s*\((.*)\)',expr)
    if m:return f'SQRT({_compile_simple(m.group(1),model,measure_resolver,filters)})'
    m=re.fullmatch(r'(?is)DATE\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if len(args)!=3:raise DaxError('DATE requires year, month and day.')
        yy,mm,dd=[_compile_simple(a,model,measure_resolver,filters) for a in args]
        return f'make_date(CAST({yy} AS INTEGER),CAST({mm} AS INTEGER),CAST({dd} AS INTEGER))'
    m=re.fullmatch(r'(?is)(YEAR|MONTH|DAY)\s*\((.*)\)',expr)
    if m:
        part=m.group(1).lower();value=_compile_simple(m.group(2),model,measure_resolver,filters)
        return f'CAST(EXTRACT({part} FROM CAST({value} AS DATE)) AS INTEGER)'

    m=re.fullmatch(r'(?is)(MIN|MAX)\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(2))
        if len(args)==2:
            sqlfn = 'LEAST' if m.group(1).upper() == 'MIN' else 'GREATEST'
            a=_compile_simple(args[0],model,measure_resolver,filters)
            b=_compile_simple(args[1],model,measure_resolver,filters)
            return f'{sqlfn}({a}, {b})'
            
    m=re.fullmatch(r'(?is)ROUND\s*\((.*),\s*(-?\d+)\s*\)',expr)
    if m:return f'ROUND({_compile_simple(m.group(1),model,measure_resolver,filters)},{int(m.group(2))})'
    m=re.fullmatch(r'(?is)DIVIDE\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if len(args)<2:raise DaxError('DIVIDE requires numerator and denominator.')
        a=_compile_simple(args[0],model,measure_resolver,filters);b=_compile_simple(args[1],model,measure_resolver,filters)
        alt=_compile_simple(args[2],model,measure_resolver,filters) if len(args)>2 else 'NULL'
        return f'COALESCE(({a})/NULLIF(({b}),0),{alt})'
    m=re.fullmatch(r'(?is)COALESCE\s*\((.*)\)',expr)
    if m:return 'COALESCE('+','.join(_compile_simple(x,model,measure_resolver,filters) for x in split_top(m.group(1)))+')'
    m=re.fullmatch(r'(?is)SELECTEDVALUE\s*\(\s*([A-Za-z_][\w ]*)\s*\[\s*([^\]]+)\]\s*(?:,\s*(.*))?\)',expr)
    if m:
        t,c,alt=m.groups();physical=model['tables'][t.strip()]['physical'];alias='__sel'
        field=resolve_field(model,t,c,alias);pred=_context_predicate(model,t.strip(),filters or [],alias)
        alt_sql=_compile_simple(alt,model,measure_resolver,filters) if alt else 'NULL'
        sql=f'(SELECT CASE WHEN COUNT(DISTINCT {field})=1 THEN MAX({field}) ELSE {alt_sql} END FROM {qi(physical)} {qi(alias)}'
        if pred:sql+=' WHERE '+pred
        return sql+')'

    m=re.fullmatch(r'(?is)IF\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if len(args)<2:raise DaxError('IF requires a condition and a true result.')
        cond=_condition(args[0],model,measure_resolver,filters)
        true_res=_compile_simple(args[1],model,measure_resolver,filters)
        false_res=_compile_simple(args[2],model,measure_resolver,filters) if len(args)>2 else 'NULL'
        return f'CASE WHEN {cond} THEN {true_res} ELSE {false_res} END'

    m=re.fullmatch(r'(?is)SWITCH\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if len(args)<3:raise DaxError('SWITCH requires an expression and at least one match/result pair.')
        switch_expr=args[0].strip();pairs=args[1:]
        fallback='NULL' if len(pairs)%2==0 else _compile_simple(pairs[-1],model,measure_resolver,filters)
        if len(pairs)%2==1:pairs=pairs[:-1]
        clauses=[]
        if re.fullmatch(r'(?i)TRUE\s*\(\s*\)|TRUE',switch_expr):
            for i in range(0,len(pairs),2):clauses.append(f'WHEN {_condition(pairs[i],model,measure_resolver,filters)} THEN {_compile_simple(pairs[i+1],model,measure_resolver,filters)}')
            return 'CASE '+' '.join(clauses)+f' ELSE {fallback} END'
        base=_compile_simple(switch_expr,model,measure_resolver,filters)
        for i in range(0,len(pairs),2):clauses.append(f'WHEN {base} = {_compile_simple(pairs[i],model,measure_resolver,filters)} THEN {_compile_simple(pairs[i+1],model,measure_resolver,filters)}')
        return 'CASE '+' '.join(clauses)+f' ELSE {fallback} END'

    tokens = []
    start = 0; depth = 0; quote = None
    for i, ch in enumerate(expr):
        if quote:
            if ch==quote: quote=None
            continue
        if ch in ("'", '"'): quote=ch
        elif ch=='(': depth+=1
        elif ch==')': depth-=1
        elif ch in '+-*/' and depth==0:
            left = expr[start:i].strip()
            if left: tokens.append(_compile_simple(left, model, measure_resolver, filters))
            tokens.append(ch)
            start = i+1
    if start > 0:
        right = expr[start:].strip()
        if right: tokens.append(_compile_simple(right, model, measure_resolver, filters))
        return ' '.join(tokens)

    raise DaxError(f'Unsupported expression: {expr}')

def _split_logical(expr,operator):
    depth=0;quote=None;start=0;parts=[];i=0
    while i<len(expr):
        ch=expr[i]
        if quote:
            if ch==quote:quote=None
            i+=1;continue
        if ch in ("'",'"'):quote=ch;i+=1;continue
        if ch=='(':depth+=1
        elif ch==')':depth-=1
        if depth==0 and expr.startswith(operator,i):
            parts.append(expr[start:i].strip());start=i+len(operator);i=start;continue
        i+=1
    if parts:parts.append(expr[start:].strip())
    return parts

def _condition(expr,model,measure_resolver=None,filters=None):
    e=expr.strip()
    if _is_wrapped(e):return '('+_condition(e[1:-1],model,measure_resolver,filters)+')'
    for op,sqlop in (('||','OR'),('&&','AND')):
        parts=_split_logical(e,op)
        if parts:return '('+f' {sqlop} '.join(_condition(x,model,measure_resolver,filters) for x in parts)+')'
    m=re.fullmatch(r'(?is)(AND|OR)\s*\((.*)\)',e)
    if m:
        args=split_top(m.group(2))
        if len(args)<2:raise DaxError(f'{m.group(1).upper()} requires at least two conditions.')
        return '('+f' {m.group(1).upper()} '.join(_condition(x,model,measure_resolver,filters) for x in args)+')'
    m=re.fullmatch(r'(?is)NOT\s*\((.*)\)',e)
    if m:return f'(NOT ({_condition(m.group(1),model,measure_resolver,filters)}))'
    m=re.fullmatch(r'(?is)ISBLANK\s*\((.*)\)',e)
    if m:return f'({_compile_simple(m.group(1),model,measure_resolver,filters)} IS NULL)'
    # DAX membership syntax: Table[Column] IN {"A", "B"}
    m=re.fullmatch(r'(?is)(.*?)\s+IN\s*\{(.*)\}',e)
    if m:
        left=m.group(1).strip();values=split_top(m.group(2));lf=parse_field(left)
        lsql=resolve_field(model,*lf) if lf else _compile_simple(left,model,measure_resolver,filters)
        if not values:raise DaxError('IN requires one or more values.')
        return f"{lsql} IN ("+','.join(_compile_simple(v,model,measure_resolver,filters) for v in values)+')'
    if re.fullmatch(r'(?i)TRUE\s*\(\s*\)|TRUE',e):return 'TRUE'
    if re.fullmatch(r'(?i)FALSE\s*\(\s*\)|FALSE',e):return 'FALSE'
    return _comparison(e,model,measure_resolver,filters)

def _comparison(expr,model,measure_resolver=None,filters=None):
    depth=0;quote=None
    for i,ch in enumerate(expr):
        if quote:
            if ch==quote:quote=None
            continue
        if ch in ("'",'"'):quote=ch;continue
        if ch=='(':depth+=1
        elif ch==')':depth-=1
        elif depth==0:
            for op in ('>=','<=','<>','>','<','='):
                if expr.startswith(op,i):
                    left=expr[:i].strip();right=expr[i+len(op):].strip()
                    lf=parse_field(left)
                    lsql=resolve_field(model,*lf) if lf else _compile_simple(left,model,measure_resolver,filters)
                    rsql=_compile_simple(right,model,measure_resolver,filters)
                    return f'{lsql} {op} {rsql}'
    raise DaxError(f'Unsupported condition: {expr}')

def _compile_calculate_filter(expr,model,vars_sql,filters):
    e=expr.strip()
    m=re.fullmatch(r'(?is)(REMOVEFILTERS|ALL)\s*\(\s*([A-Za-z_][\w ]*)\s*\[\s*([^\]]+)\]\s*\)',e)
    if m:return None,{semantic_field(m.group(2),m.group(3))}
    m=re.fullmatch(r'(?is)KEEPFILTERS\s*\((.*)\)',e)
    if m:return _condition(m.group(1),model,None,filters),set()
    m=re.fullmatch(r'(?is)DATESBETWEEN\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*,\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)',e)
    if m:
        t,c,s,en=m.groups(); t = t.strip("'")
        if s not in vars_sql or en not in vars_sql:raise DaxError('DATESBETWEEN requires defined start/end variables.')
        field=resolve_field(model,t,c)
        return f'CAST({field} AS DATE) BETWEEN CAST({vars_sql[s]} AS DATE) AND CAST({vars_sql[en]} AS DATE)',{semantic_field(t,c)}
    m=re.fullmatch(r'(?is)DATESINPERIOD\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*,\s*([A-Za-z_]\w*)\s*,\s*(-?\d+)\s*,\s*(DAY|MONTH|QUARTER|YEAR)\s*\)',e)
    if m:
        t,c,endvar,num,unit=m.groups(); t = t.strip("'")
        if endvar not in vars_sql:raise DaxError('DATESINPERIOD anchor variable is not defined.')
        field=resolve_field(model,t,c);num=int(num);unit=unit.lower()
        start=f"(CAST({vars_sql[endvar]} AS DATE) + INTERVAL '{num} {unit}')"
        return f'CAST({field} AS DATE) BETWEEN {start} AND CAST({vars_sql[endvar]} AS DATE)',{semantic_field(t,c)}
    m=re.fullmatch(r'(?is)SAMEPERIODLASTYEAR\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*\)',e)
    if m:
        t,c=m.groups();mn,mx=_selected_bounds(model,t.strip(),c.strip(),filters)
        field=resolve_field(model,t,c)
        return f"CAST({field} AS DATE) BETWEEN (CAST({mn} AS DATE)-INTERVAL '1 year') AND (CAST({mx} AS DATE)-INTERVAL '1 year')",{semantic_field(t,c)}
    m=re.fullmatch(r"(?is)FILTER\s*\(\s*'?([A-Za-z_][\w ]*)'?\s*,\s*(.*)\)",e)
    if m:
        table=m.group(1).strip();condition=m.group(2).strip()
        if table not in model.get('tables',{}):raise DaxError(f"Unknown table '{table}'")
        return _condition(condition,model,None,filters),set()
    # Direct Table[Column] comparison / logical condition.
    return _condition(e,model,None,filters),set()

def _attach_filter(base_sql,predicate):
    if not predicate:return base_sql
    # DuckDB/Postgres-style aggregate FILTER works for all aggregate forms generated above.
    if re.match(r'(?is)^(SUM|AVG|MIN|MAX|COUNT|MEDIAN)\s*\(',base_sql):
        return f'{base_sql} FILTER (WHERE {predicate})'
    raise DaxError('CALCULATE filter currently requires an aggregate base expression.')

def _compile_total_period(kind,args,model,measure_resolver,filters):
    parts=split_top(args)
    if len(parts)<2:raise DaxError(f'{kind} requires expression and date column.')
    base=_compile_simple(parts[0],model,measure_resolver,filters)
    field_ref=parse_field(parts[1])
    if not field_ref:raise DaxError(f'{kind} date argument must be Table[DateColumn].')
    t,c=field_ref;mx=_selected_aggregate(model,'MAX',t,c,filters);field=resolve_field(model,t,c)
    if kind=='TOTALYTD':start=f"date_trunc('year',CAST({mx} AS DATE))"
    elif kind=='TOTALQTD':start=f"date_trunc('quarter',CAST({mx} AS DATE))"
    else:start=f"date_trunc('month',CAST({mx} AS DATE))"
    pred=f'CAST({field} AS DATE) BETWEEN CAST({start} AS DATE) AND CAST({mx} AS DATE)'
    return _attach_filter(base,pred),{semantic_field(t,c)}

@dataclass
class DaxCompilation:
    sql:str
    override_fields:set[str]
    kind:str='dax'

def compile_dax(expression,model,filters=None,measure_resolver=None):
    text=strip_assignment(expression);filters=filters or []
    # Simple expression.
    if not re.search(r'(?i)\b(VAR|RETURN|CALCULATE|TOTALYTD|TOTALMTD|TOTALQTD)\b',text):
        return DaxCompilation(_compile_simple(text,model,measure_resolver,filters),set())

    # Time total functions without VAR.
    for kind in ('TOTALYTD','TOTALMTD','TOTALQTD'):
        m=re.fullmatch(rf'(?is){kind}\s*\((.*)\)',text)
        if m:
            sql,over=_compile_total_period(kind,m.group(1),model,measure_resolver,filters)
            return DaxCompilation(sql,over)

    vars_sql={}
    ret=text
    if re.search(r'(?i)\bVAR\b',text):
        variables,ret=_parse_vars(text)
        for name,expr in variables.items():vars_sql[name]=_compile_var_value(expr,model,vars_sql,filters,measure_resolver)

    m=re.fullmatch(r'(?is)CALCULATE\s*\((.*)\)',ret.strip())
    if not m:
        # RETURN can be a complex expression (IF, MIN, DIVIDE, etc.)
        def var_aware_resolver(name):
            if name in vars_sql:return vars_sql[name]
            if measure_resolver:return measure_resolver(name)
            raise DaxError(f"Unknown measure or variable [{name}]")
        return DaxCompilation(_compile_simple(ret.strip(),model,var_aware_resolver,filters),set())
        
    args=split_top(m.group(1))
    if not args:raise DaxError('CALCULATE requires an expression.')
    base=_compile_simple(args[0],model,measure_resolver,filters)
    predicates=[];override=set()
    for item in args[1:]:
        pred,over=_compile_calculate_filter(item,model,vars_sql,filters)
        if pred:predicates.append(pred)
        override.update(over)
    return DaxCompilation(_attach_filter(base,' AND '.join(f'({p})' for p in predicates)),override)

def _field_entries(model):
    out=[]
    for table,t in model.get('tables',{}).items():
        for col in t.get('columns',{}):
            dtype=str(model.get('columnTypes',{}).get(f'{table}.{col}','')).lower()
            out.append({'table':table,'column':col,'dtype':dtype,'norm':normalize(col),'fullnorm':normalize(table+' '+col)})
    return out

def _best_field(prompt,entries,predicate,prefer=()):
    n=normalize(prompt);cands=[x for x in entries if predicate(x)]
    if not cands:return None
    # Explicit field-name fragments have highest weight.
    scored=[]
    for x in cands:
        score=0
        if x['norm'] and x['norm'] in n:score+=100+len(x['norm'])
        words=re.findall(r'[A-Za-z0-9_]+',prompt.lower())
        colwords=re.findall(r'[A-Za-z0-9_]+',x['column'].lower())
        score+=sum(8 for w in words if len(w)>=2 and any(cw.startswith(w) or w.startswith(cw) for cw in colwords))
        score+=sum(5 for k in prefer if k in x['column'].lower())
        scored.append((score,x))
    return max(scored,key=lambda z:z[0])[1]

def _explicit_fields(prompt,model):
    """Return exact Table[Column] references mentioned by the user, in prompt order."""
    hits=[]
    for table,t in model.get('tables',{}).items():
        # Match known semantic table names exactly so preceding prose (e.g. "overall")
        # cannot become part of the table name.
        pattern=re.compile(re.escape(table)+r'\s*\[\s*([^\]]+)\s*\]',re.I)
        for m in pattern.finditer(prompt):
            requested=m.group(1).strip()
            actual=next((c for c in t.get('columns',{}) if c.lower()==requested.lower()),None)
            if actual is None:continue
            dtype=str(model.get('columnTypes',{}).get(f'{table}.{actual}','')).lower()
            hits.append((m.start(),{'table':table,'column':actual,'dtype':dtype,'norm':normalize(actual),'fullnorm':normalize(table+' '+actual),'explicit':True}))
    return [x for _,x in sorted(hits,key=lambda z:z[0])]

def _is_identifier(field):
    name=field['column'].lower().replace(' ','').replace('_','')
    return bool(re.search(r'(id|key|code|number|no)$',name)) or name in ('id','key')

def _is_numeric_field(field):
    dtype=field.get('dtype','')
    if any(x in dtype for x in ('int','decimal','numeric','double','float','real','currency','number')):return True
    n=field['column'].lower().replace(' ','')
    return any(k in n for k in ('amount','revenue','sales','cost','profit','quantity','qty','points','days','price','margin','discount','value'))

def _semantic_measure_check(prompt,result,explicit):
    """Fail closed when generated DAX loses an explicitly named field."""
    expr=result.get('expression','')
    missing=[]
    for f in explicit:
        ref=f"{f['table']}[{f['column']}]"
        if ref not in expr:missing.append(ref)
    if missing:
        raise DaxError('Semantic verification failed: generated measure did not use the explicitly requested field(s): '+', '.join(missing))
    return True

def _prompt_filter_specs(prompt,explicit):
    """Extract simple, deterministic filter conditions that are explicitly attached to Table[Column] refs."""
    specs=[]
    stop=r'(?=\s+(?:and|using|with|for|where|during|last|ytd|mtd|qtd|year\s+to\s+date|month\s+to\s+date|quarter\s+to\s+date)\b|[,;\n]|$)'
    for f in explicit:
        ref=f"{f['table']}[{f['column']}]"
        mref=re.search(re.escape(ref),prompt,re.I)
        if not mref:continue
        tail=prompt[mref.end():mref.end()+140]
        patterns=[
          ('not_equals',rf'^\s*(?:<>|!=|not\s+equals?|not\s+equal\s+to|excluding?|exclude)\s+[\"\']?(.+?)[\"\']?{stop}'),
          ('gte',rf'^\s*(?:>=|at\s+least|greater\s+than\s+or\s+equal\s+to)\s+[\"\']?(.+?)[\"\']?{stop}'),
          ('lte',rf'^\s*(?:<=|at\s+most|less\s+than\s+or\s+equal\s+to)\s+[\"\']?(.+?)[\"\']?{stop}'),
          ('gt',rf'^\s*(?:>|greater\s+than|above)\s+[\"\']?(.+?)[\"\']?{stop}'),
          ('lt',rf'^\s*(?:<|less\s+than|below)\s+[\"\']?(.+?)[\"\']?{stop}'),
          ('equals',rf'^\s*(?:=|equals?|is)\s+[\"\']?(.+?)[\"\']?{stop}'),
        ]
        for op,pat in patterns:
            m=re.search(pat,tail,re.I)
            if not m:continue
            raw=m.group(1).strip().strip('"\'')
            if not raw:break
            if re.fullmatch(r'-?\d+(?:\.\d+)?',raw):value=float(raw) if '.' in raw else int(raw)
            elif raw.lower() in ('true','false'):value=raw.lower()=='true'
            else:value=raw
            specs.append((f,op,value));break
    return specs

def _dax_filter_line(field,op,value):
    symbol={'equals':'=','not_equals':'<>','gte':'>=','lte':'<=','gt':'>','lt':'<'}[op]
    literal=str(value).upper() if isinstance(value,bool) else str(value) if isinstance(value,(int,float)) else '"'+str(value).replace('"','""')+'"'
    return f"    {field['table']}[{field['column']}] {symbol} {literal}"

def _deterministic_suggest_measure(prompt,model):
    text=prompt.strip();low=text.lower();entries=_field_entries(model)
    if not entries:raise DaxError('The semantic model has no fields. Add processed data to Model first.')
    explicit=_explicit_fields(text,model)
    filter_specs=_prompt_filter_specs(text,explicit)
    filter_refs={(f['table'],f['column']) for f,_,_ in filter_specs}

    date_explicit=next((x for x in explicit if 'date' in x['column'].lower() or 'time' in x['column'].lower() or x['dtype'] in ('date','datetime','timestamp')),None)
    datef=date_explicit or _best_field(text,entries,lambda x:'date' in x['column'].lower() or 'time' in x['column'].lower() or x['dtype'] in ('date','datetime','timestamp'),('date','updated','created'))

    # Explicit columns are role-classified: date/filter columns must never accidentally become the KPI value.
    explicit_values=[x for x in explicit if x is not date_explicit and (x['table'],x['column']) not in filter_refs]
    keyf=next((x for x in explicit_values if _is_identifier(x)),None) or _best_field(text,entries,lambda x:_is_identifier(x),('customerid','orderid','key','id'))
    numeric_explicit=[x for x in explicit_values if _is_numeric_field(x)]
    amount=(numeric_explicit[0] if numeric_explicit else _best_field(text,entries,lambda x:_is_numeric_field(x),('salesamount','revenue','amount','profit','quantity')))

    is_count=bool(re.search(r'\b(count|number of|how many|distinct count|unique count|customers|orders|records|rows)\b',low))
    is_avg=bool(re.search(r'\b(average|avg|mean)\b',low))
    is_min=bool(re.search(r'\b(min|minimum|lowest)\b',low))
    is_max=bool(re.search(r'\b(max|maximum|highest)\b',low))
    is_sum=bool(re.search(r'\b(sum|total|overall|sales|revenue|amount|quantity|profit)\b',low))
    wants_distinct=bool(re.search(r'\b(distinct|unique)\b',low))
    wants_difference=bool(re.search(r'\b(difference|minus|subtract|variance|profit)\b',low)) and len(numeric_explicit)>=2
    wants_ratio=bool(re.search(r'\b(ratio|percentage|percent|margin|rate)\b',low)) and len(numeric_explicit)>=2

    # Deterministic two-column business arithmetic when the prompt explicitly names both numeric fields.
    if wants_ratio or wants_difference:
        a,b=numeric_explicit[:2];aref=f"{a['table']}[{a['column']}]";bref=f"{b['table']}[{b['column']}]"
        if filter_specs:raise DaxError('For a ratio/difference with filters, create the base filtered measures first and reference them in the derived measure.')
        if wants_ratio:
            base=f"DIVIDE ( SUM ( {aref} ), SUM ( {bref} ), 0 )";base_name='Ratio_'+re.sub(r'\W+','_',a['column']).strip('_')+'_to_'+re.sub(r'\W+','_',b['column']).strip('_');intent='ratio'
        else:
            base=f"SUM ( {aref} ) - SUM ( {bref} )";base_name='Difference_'+re.sub(r'\W+','_',a['column']).strip('_')+'_Minus_'+re.sub(r'\W+','_',b['column']).strip('_');intent='difference'
        result={'name':base_name,'expression':f'{base_name} =\n{base}','explanation':f'Verified semantic intent: {intent} using {aref} and {bref}.','warnings':[],'confidence':1.0,'intent':intent,'semanticChecks':{'explicitFieldLock':True,'aggregation':intent,'identifierProtectedFromSum':True},'grounding':{'valueField':aref,'secondaryValueField':bref,'dateField':None,'filterFields':[]}}
        _semantic_measure_check(text,result,[a,b]);return result

    primary=(keyf if is_count and keyf in explicit_values else (explicit_values[0] if explicit_values else None))
    if primary:value=primary
    elif is_count and keyf:value=keyf
    elif amount:value=amount
    elif keyf:value=keyf
    else:raise DaxError('I could not determine the requested value field. Type or select a field such as Table[Column].')

    ref=f"{value['table']}[{value['column']}]";identifier=_is_identifier(value);numeric=_is_numeric_field(value)
    if is_avg:
        if not numeric:raise DaxError(f"AVERAGE is not appropriate for identifier/text field {ref}. Please choose a numeric field.")
        base=f"AVERAGE ( {ref} )";base_name='Average_'+re.sub(r'\W+','_',value['column']).strip('_');intent='average'
    elif is_min:
        base=f"MIN ( {ref} )";base_name='Minimum_'+re.sub(r'\W+','_',value['column']).strip('_');intent='minimum'
    elif is_max:
        base=f"MAX ( {ref} )";base_name='Maximum_'+re.sub(r'\W+','_',value['column']).strip('_');intent='maximum'
    elif is_count or identifier or (primary and not numeric):
        distinct=wants_distinct or identifier or not numeric;base=f"{'DISTINCTCOUNT' if distinct else 'COUNT'} ( {ref} )";base_name=('Distinct_Count_' if distinct else 'Count_')+re.sub(r'\W+','_',value['column']).strip('_');intent='distinct_count' if distinct else 'count'
    elif is_sum or numeric:
        if not numeric:raise DaxError(f"SUM is not appropriate for {ref}. Please specify Count/Distinct Count or choose a numeric field.")
        base=f"SUM ( {ref} )";base_name='Total_'+re.sub(r'\W+','_',value['column']).strip('_');intent='sum'
    else:raise DaxError(f"The aggregation for {ref} is ambiguous. Please say Total, Average, Count, Distinct Count, Minimum, or Maximum.")

    filter_lines=[_dax_filter_line(*spec) for spec in filter_specs]
    expression=None;name=base_name
    if 'last month' in low:
        if not datef:raise DaxError('A Date/DateTime field is required for "last month". Please select the exact date field.')
        dref=f"{datef['table']}[{datef['column']}]";name=base_name+'_Last_Month'
        lines=[f'{name} =','VAR MaxSelectedDate =',f'    MAX ( {dref} )','','VAR StartDate =','    EOMONTH ( MaxSelectedDate, -2 ) + 1','','VAR EndDate =','    EOMONTH ( MaxSelectedDate, -1 )','','RETURN','CALCULATE (',f'    {base},']
        lines += [x+',' for x in filter_lines]
        lines+=['    DATESBETWEEN (',f'        {dref},','        StartDate,','        EndDate','    )',')'];expression='\n'.join(lines)
    else:
        mm=re.search(r'last\s+(\d+)\s+months?',low)
        if mm:
            if not datef:raise DaxError('A Date/DateTime field is required for rolling-month logic. Please select the exact date field.')
            months=int(mm.group(1));dref=f"{datef['table']}[{datef['column']}]";name=base_name+f'_Last_{months}_Months'
            lines=[f'{name} =','VAR MaxSelectedDate =',f'    MAX ( {dref} )','','VAR StartDate =',f'    EDATE ( MaxSelectedDate, -{months} ) + 1','','RETURN','CALCULATE (',f'    {base},']
            lines += [x+',' for x in filter_lines]
            lines+=['    DATESBETWEEN (',f'        {dref},','        StartDate,','        MaxSelectedDate','    )',')'];expression='\n'.join(lines)
        elif re.search(r'\b(ytd|year to date)\b',low):
            if not datef:raise DaxError('A Date/DateTime field is required for YTD. Please select the exact date field.')
            if filter_lines:raise DaxError('YTD with additional row filters is not supported by the deterministic generator yet. Create the filtered base measure first, then apply YTD.')
            dref=f"{datef['table']}[{datef['column']}]";name=base_name+'_YTD';expression=f'{name} =\nTOTALYTD ( {base}, {dref} )'
        elif re.search(r'\b(mtd|month to date)\b',low):
            if not datef:raise DaxError('A Date/DateTime field is required for MTD. Please select the exact date field.')
            if filter_lines:raise DaxError('MTD with additional row filters is not supported by the deterministic generator yet. Create the filtered base measure first, then apply MTD.')
            dref=f"{datef['table']}[{datef['column']}]";name=base_name+'_MTD';expression=f'{name} =\nTOTALMTD ( {base}, {dref} )'
        elif re.search(r'\b(qtd|quarter to date)\b',low):
            if not datef:raise DaxError('A Date/DateTime field is required for QTD. Please select the exact date field.')
            if filter_lines:raise DaxError('QTD with additional row filters is not supported by the deterministic generator yet. Create the filtered base measure first, then apply QTD.')
            dref=f"{datef['table']}[{datef['column']}]";name=base_name+'_QTD';expression=f'{name} =\nTOTALQTD ( {base}, {dref} )'
    if expression is None:
        if filter_lines:
            name=base_name+'_Filtered';expression=f'{name} =\nCALCULATE (\n    {base},\n'+',\n'.join(filter_lines)+'\n)'
        else:expression=f'{name} =\n{base}'

    used_explicit=[value]
    if datef in explicit and ('last' in low or 'ytd' in low or 'mtd' in low or 'qtd' in low):used_explicit.append(datef)
    used_explicit += [f for f,_,_ in filter_specs if f not in used_explicit]
    result={'name':name,'expression':expression,'explanation':f"Verified semantic intent: {intent} of {ref}"+(f" using {datef['table']}[{datef['column']}] for time context" if datef and ('last' in low or 'ytd' in low or 'mtd' in low or 'qtd' in low) else '')+(f" with {len(filter_specs)} explicit filter condition(s)" if filter_specs else '')+'.','warnings':[],'confidence':1.0 if explicit else 0.85,'intent':intent,'semanticChecks':{'explicitFieldLock':bool(explicit),'aggregation':intent,'identifierProtectedFromSum':identifier,'filterCount':len(filter_specs)},'grounding':{'valueField':ref,'dateField':f"{datef['table']}[{datef['column']}]" if datef else None,'filterFields':[f"{f['table']}[{f['column']}]" for f,_,_ in filter_specs]}}
    _semantic_measure_check(text,result,used_explicit)
    return result


def suggest_measure_from_prompt(prompt,model):
    """Use verified rules first, then Gemini for genuinely unresolved prompts."""
    try:
        result=_deterministic_suggest_measure(prompt,model)
        low=(prompt or '').lower()
        if not result['grounding'].get('filterFields') and any(word in low for word in (' where ',' excluding ',' exclude ',' only ',' with ','>', '<', '=')):
            raise DaxError('The deterministic generator did not resolve the requested filter.')
        return result
    except Exception as deterministic_error:
        try:
            entries=_field_entries(model)
            fields=', '.join(f"{x['table']}[{x['column']}]" for x in entries)
            result=generate_json(prompt,(
                'You create one valid DAX measure definition for VTAB Reporting Studio. '
                'Available semantic fields: '+fields+'. '
                'Use only those fields in Table[Column] form. Return JSON only: '
                '{"name":"short_measure_name","expression":"MeasureName =\\nDAX expression","explanation":"brief explanation"}.'
            ))
            name=str(result.get('name','')).strip();expression=str(result.get('expression','')).strip()
            if not name or not expression: raise DaxError('AI response was missing name or expression.')
            # The measure endpoint compiles the result before it can be saved.
            return {'name':re.sub(r'\s+','_',name)[:128],'expression':expression,'explanation':str(result.get('explanation','Generated by Gemini AI.')),'warnings':[],'confidence':0.9,'intent':'ai_fallback','semanticChecks':{},'grounding':{'valueField':None,'dateField':None,'filterFields':[]}}
        except Exception as ai_error:
            raise DaxError(f'I could not determine the requested DAX measure and AI generation failed ({ai_error}). Original error: {deterministic_error}')
