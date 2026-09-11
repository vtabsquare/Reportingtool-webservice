from __future__ import annotations
import re
from .local_engine import connect, table_columns, table_types, materialize_query
from .gemini import generate_json

OPS={
    'equals':'=','not_equals':'<>','gt':'>','gte':'>=','lt':'<','lte':'<=',
    'contains':'LIKE','starts_with':'LIKE','ends_with':'LIKE'
}

def quote(x): return '"'+str(x).replace('"','""')+'"'

def _columns(table):
    return table_columns(table)

def _types(table):
    return table_types(table)

def _literal_or_column(cond, params):
    if cond.get('rightType')=='column': return quote(cond['rightValue'])
    params.append(cond.get('rightValue'))
    return '?'

def _condition_sql(cond, params):
    left=quote(cond['field']);op=cond.get('operator','equals')
    if op in ('is_null','is_blank'): return f'({left} IS NULL OR TRIM(CAST({left} AS TEXT)) = \'\')'
    if op in ('is_not_null','is_not_blank'): return f'({left} IS NOT NULL AND TRIM(CAST({left} AS TEXT)) <> \'\')'
    sqlop=OPS.get(op)
    if not sqlop: raise ValueError(f'Unsupported condition operator: {op}')
    value=cond.get('value',cond.get('rightValue'))
    if op=='contains': value=f'%{value}%'
    elif op=='starts_with': value=f'{value}%'
    elif op=='ends_with': value=f'%{value}'
    params.append(value)
    return f'{left} {sqlop} ?'

def _date_expr(field, fmt):
    q=quote(field);f=(fmt or 'auto').lower()
    if f in ('auto','yyyy-mm-dd','iso'):return f'TRY_CAST({q} AS DATE)'
    mapping={
      'dd/mm/yyyy':'%d/%m/%Y','dd-mm-yyyy':'%d-%m-%Y',
      'mm/dd/yyyy':'%m/%d/%Y','mm-dd-yyyy':'%m-%d-%Y','yyyymmdd':'%Y%m%d'
    }
    if f in mapping:return f"TRY_STRPTIME(CAST({q} AS VARCHAR), '{mapping[f]}')::DATE"
    return f'TRY_CAST({q} AS DATE)'

def _cast_expr(field, target, date_format='auto'):
    q = quote(field)
    t = str(target or 'text').lower()
    if t in ('text','string'):return f'CAST({q} AS TEXT)'
    if t in ('integer','whole','whole number','int'):return f'TRY_CAST({q} AS INTEGER)'
    if t in ('decimal','number','real','currency','numeric'):return f'TRY_CAST({q} AS DOUBLE)'
    if t in ('date',):return _date_expr(field,date_format)
    if t in ('datetime','date time'):return f'TRY_CAST({q} AS TIMESTAMP)'
    if t in ('boolean','bool'):return f"CASE WHEN lower(trim(CAST({q} AS TEXT))) IN ('true','1','yes','y') THEN 1 WHEN lower(trim(CAST({q} AS TEXT))) IN ('false','0','no','n') THEN 0 ELSE NULL END"
    return f'CAST({q} AS TEXT)'



ROW_FUNCTIONS = {
    'IF','COALESCE','NULLIF','UPPER','LOWER','TRIM','LTRIM','RTRIM','LENGTH','LEN',
    'CONCAT','CONCAT_WS','REPLACE','SPLIT_PART','SUBSTR','SUBSTRING','LEFT','RIGHT','ROUND','ABS',
    'FLOOR','CEIL','CEILING','GREATEST','LEAST','YEAR','QUARTER','MONTH','WEEK','DAY',
    'DAYOFWEEK','STRFTIME','DATE_DIFF','DATE_TRUNC','LAST_DAY','TRY_CAST','CAST'
}
ROW_KEYWORDS = {'CASE','WHEN','THEN','ELSE','END','AND','OR','NOT','AS','NULL','TRUE','FALSE','IN','LIKE','IS'}
FORBIDDEN_ROW_SQL = re.compile(r'(?i)\b(SELECT|FROM|JOIN|UNION|INTERSECT|EXCEPT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|COPY|PRAGMA|CALL|EXPORT|IMPORT)\b|;|--|/\*|\*/')
FORBIDDEN_NATIVE_SQL = re.compile(
    r'(?i)\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|COPY|EXPORT|IMPORT|INSTALL|LOAD|CALL|PRAGMA|VACUUM|CHECKPOINT|SET|USE)\b'
    r'|--|/\*|\*/|\b(read_csv|read_json|read_parquet|parquet_scan|csv_scan|glob|sqlite_scan|postgres_scan)\s*\('
)


def validate_native_query(sql: str) -> str:
    """Accept one read-only SELECT/CTE statement for the Advanced Query editor."""
    query = (sql or '').strip()
    if query.endswith(';'):
        query = query[:-1].rstrip()
    if not query:
        raise ValueError('Query text is required.')
    if len(query) > 100_000:
        raise ValueError('Query text is too long.')
    if ';' in query or FORBIDDEN_NATIVE_SQL.search(query):
        raise ValueError('Advanced Query accepts one read-only SELECT statement only.')
    if not re.match(r'(?is)^(SELECT|WITH)\b', query):
        raise ValueError('Advanced Query must start with SELECT or WITH.')
    return query

def compile_row_expression(expression:str, columns:list[str]):
    """Compile the VTAB row-expression DSL to a safe DuckDB scalar expression.

    Column references use [Column Name]. SQL table/query statements are rejected. The
    resulting expression is used only inside SELECT <expression> AS <new column>.
    """
    expr=(expression or '').strip()
    if not expr: raise ValueError('Calculated-column expression is required.')
    if FORBIDDEN_ROW_SQL.search(expr): raise ValueError('Calculated columns accept row-level expressions only, not SQL queries.')
    colset=set(columns)
    refs=re.findall(r'\[([^\]]+)\]',expr)
    for ref in refs:
        if ref not in colset: raise ValueError(f"Unknown column [{ref}].")
    expr=re.sub(r'\[([^\]]+)\]',lambda m: quote(m.group(1)),expr)
    # Friendly aliases.
    expr=re.sub(r'(?i)\bLEN\s*\(', 'LENGTH(', expr)
    expr=re.sub(r'(?i)\bCEILING\s*\(', 'CEIL(', expr)
    # Excel/DAX-style IF works natively in DuckDB as if(condition, true, false).
    # Convert single = comparisons to SQL = while preserving >= <= <> != ==.
    expr=re.sub(r'(?<![<>=!])==(?!=)', '=', expr)
    # Validate function identifiers. Plain identifiers are allowed only for CASE keywords,
    # SQL types following AS, or known functions. Column names have already been quoted.
    scrub=re.sub(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"",' ',expr)
    funcs={m.group(1).upper() for m in re.finditer(r'\b([A-Za-z_][A-Za-z0-9_]*)\s*\(',scrub)}
    unknown=sorted(f for f in funcs if f not in ROW_FUNCTIONS)
    if unknown: raise ValueError('Unsupported row function(s): '+', '.join(unknown))
    if len(expr)>6000: raise ValueError('Calculated-column expression is too long.')
    return expr

def suggest_calculated_column(prompt:str, columns:list[str]):
    """Ground a natural-language row-logic request to current transformation columns."""
    text=(prompt or '').strip(); low=text.lower()
    if not text: raise ValueError('Describe the row-level logic to generate.')
    if not columns: raise ValueError('No columns are available in this query.')
    def norm(s): return re.sub(r'[^a-z0-9]','',s.lower())
    n=norm(text)
    def best(keys=(), fallback=False):
        scored=[]
        words=[w for w in re.findall(r'[a-z0-9]+',low) if len(w)>=2]
        for c in columns:
            cn=norm(c); score=0
            if cn and cn in n: score+=120+len(cn)
            cwords=re.findall(r'[a-z0-9]+',c.lower())
            score+=sum(10 for w in words if any(x.startswith(w) or w.startswith(x) for x in cwords))
            score+=sum(15 for k in keys if k in c.lower())
            scored.append((score,c))
        scored.sort(reverse=True)
        if scored and (scored[0][0]>0 or fallback): return scored[0][1]
        return None
    def ref(c): return f'[{c}]'
    # Date difference.
    mentioned_datecols=[c for c in columns if norm(c) in n and any(k in c.lower() for k in ('date','created','updated','time'))]
    if any(x in low for x in ('days between','date difference','datediff')) or ('difference between' in low and len(mentioned_datecols)>=2):
        datecols=[c for c in columns if any(k in c.lower() for k in ('date','created','updated','time'))]
        mentioned=[c for c in datecols if norm(c) in n]
        a=mentioned[0] if mentioned else (datecols[0] if datecols else best(fallback=True))
        b=mentioned[1] if len(mentioned)>1 else (datecols[1] if len(datecols)>1 else best(('updated','end')))
        if not a or not b or a==b: raise ValueError('Please mention two date columns for a date-difference calculated column.')
        return {'name':'Days_Between_'+re.sub(r'\W+','_',a)+'_'+re.sub(r'\W+','_',b),'expression':f"DATE_DIFF('day', CAST({ref(a)} AS DATE), CAST({ref(b)} AS DATE))",'explanation':f'Calculates day difference between {a} and {b}.','grounding':[a,b]}
    # Fixed-length extraction from the left/right. Examples:
    #   "CustomerID 3 characters from left", "take first 4 of ProductID",
    #   "extract last 2 digits from OrderID".  Explicitly mentioned columns always win.
    mentioned=[c for c in columns if norm(c) in n]
    m=re.search(r'(?i)(\d+)\s*(?:digit|digits|character|characters|char|chars)?\s*from\s+(?:the\s+)?(left|right)\b', text)
    if not m:
        m=re.search(r'(?i)(first|last)\s+(\d+)\s*(?:digit|digits|character|characters|char|chars)?', text)
        if m:
            side='left' if m.group(1).lower()=='first' else 'right'; length=int(m.group(2))
        else:
            side=None; length=None
    else:
        length=int(m.group(1)); side=m.group(2).lower()
    if side and length:
        c=mentioned[0] if mentioned else best(fallback=False)
        if not c: raise ValueError('Please mention the source column for the left/right extraction.')
        if length<1 or length>4000: raise ValueError('Extraction length must be between 1 and 4000 characters.')
        fn='LEFT' if side=='left' else 'RIGHT'
        return {'name':re.sub(r'\W+','_',c)+f'_{side.title()}_{length}','expression':f'{fn}(CAST({ref(c)} AS VARCHAR), {length})','explanation':f'Extracts {length} character(s) from the {side} of {c}.','grounding':[c]}

    # Delimiter-based extraction. Examples: "CustomerID before -", "text after | from Notes".
    if any(x in low for x in ('before delimiter','after delimiter','text before','text after','split at','delimiter')):
        c=mentioned[0] if mentioned else best(fallback=False)
        if not c: raise ValueError('Please mention the source column for delimiter extraction.')
        dm=re.search(r'(?i)(?:delimiter|split at|before|after)\s*[=:]?\s*[\"\']?([^\s\"\']{1,5})[\"\']?', text)
        delim=(dm.group(1) if dm else '|').replace("'","''")
        before=('before' in low) or ('left of' in low)
        # DuckDB split_part is deterministic and safe for row-level materialization.
        expr=f"SPLIT_PART(CAST({ref(c)} AS VARCHAR), '{delim}', 1)" if before else f"SPLIT_PART(CAST({ref(c)} AS VARCHAR), '{delim}', 2)"
        return {'name':re.sub(r'\W+','_',c)+('_Before_Delimiter' if before else '_After_Delimiter'),'expression':expr,'explanation':f'Extracts text {"before" if before else "after"} delimiter {delim!r} from {c}.','grounding':[c]}

    # Null replacement / coalesce.
    if any(x in low for x in ('replace null','replace blank','if null','coalesce','null with')):
        c=mentioned[0] if mentioned else best(fallback=True); val='0' if re.search(r'\b0\b|zero',low) else "'Unknown'"
        return {'name':re.sub(r'\W+','_',c)+'_Filled','expression':f'COALESCE({ref(c)}, {val})','explanation':f'Replaces null {c} values.','grounding':[c]}
    # Text transformations.
    for needle,fn,suffix in [('uppercase','UPPER','Upper'),('upper case','UPPER','Upper'),('lowercase','LOWER','Lower'),('lower case','LOWER','Lower'),('trim','TRIM','Trimmed')]:
        if needle in low:
            c=best(fallback=True);return {'name':re.sub(r'\W+','_',c)+'_'+suffix,'expression':f'{fn}({ref(c)})','explanation':f'Applies {fn} to {c}.','grounding':[c]}
    # Date parts.
    for needle,fn in [('year','YEAR'),('quarter','QUARTER'),('month','MONTH'),('week','WEEK'),('day','DAY')]:
        if re.search(rf'\b{needle}\b',low) and any(x in low for x in ('from','extract','derive','create')):
            c=best(('date','updated','created'),True);return {'name':re.sub(r'\W+','_',c)+'_'+needle.title(),'expression':f'{fn}(CAST({ref(c)} AS DATE))','explanation':f'Extracts {needle} from {c}.','grounding':[c]}
    # Concatenate/combine fields.
    if any(x in low for x in ('combine','concat','concatenate','merge text')):
        mentioned=[c for c in columns if norm(c) in n]
        if len(mentioned)<2:
            mentioned=columns[:2]
        if len(mentioned)<2: raise ValueError('At least two columns are required to concatenate.')
        delim="' - '" if 'dash' in low or '-' in text else "' '"
        refs=', '.join(ref(c) for c in mentioned[:4])
        return {'name':'Combined_'+re.sub(r'\W+','_',mentioned[0])+'_'+re.sub(r'\W+','_',mentioned[1]),'expression':f'CONCAT_WS({delim}, {refs})','explanation':'Combines selected row values into one text column.','grounding':mentioned[:4]}
    # Arithmetic requests involving explicitly mentioned columns.
    mentioned=[c for c in columns if norm(c) in n]
    op=None
    if any(x in low for x in ('multiply','multiplied','multiplying','product','times',' * ')):op='*'
    elif any(x in low for x in ('divide','divided','dividing','ratio',' / ')):op='/'
    elif any(x in low for x in ('subtract','subtracted','subtracting','difference','minus',' - ')):op='-'
    elif any(x in low for x in ('add ','added','adding','sum of',' plus ',' + ')):op='+'
    if op and len(mentioned)>=2:
        a,b=mentioned[:2];expr=f'{ref(a)} {op} {ref(b)}'
        if op=='/':expr=f'{ref(a)} / NULLIF({ref(b)}, 0)'
        return {'name':re.sub(r'\W+','_',a)+'_Calc_'+re.sub(r'\W+','_',b),'expression':expr,'explanation':f'Applies row-level arithmetic between {a} and {b}.','grounding':[a,b]}
    # IF / ELSE: e.g. if Status is Done then Closed else Open
    m=re.search(r'(?i)if\s+(.+?)\s+(?:is|=|equals)\s+["\']?([^"\']+?)["\']?\s+then\s+["\']?([^"\']+?)["\']?\s+else\s+["\']?(.+?)["\']?$',text)
    if m:
        lhs=m.group(1).strip(); match=best(fallback=True)
        for c in columns:
            if norm(c)==norm(lhs) or norm(c) in norm(lhs):match=c;break
        test,yes,no=m.group(2).strip(),m.group(3).strip(),m.group(4).strip()
        esc=lambda s:"'"+s.replace("'","''")+"'"
        return {'name':re.sub(r'\W+','_',match)+'_Category','expression':f'IF({ref(match)} = {esc(test)}, {esc(yes)}, {esc(no)})','explanation':f'Creates row-level IF/ELSE logic using {match}.','grounding':[match]}
    # Deterministic rules remain preferred; Gemini is a controlled fallback for
    # otherwise-unrecognized, row-level requests.
    try:
        result=generate_json(text,(
            'You translate a natural-language request into one safe DuckDB row-level SQL expression. '
            'Available columns: '+', '.join(columns)+'. '
            'Use only those columns, referenced exactly as [Column Name]. '
            'Return JSON only: {"name":"short_name","expression":"DuckDB expression","explanation":"brief explanation"}.'
        ))
        name=str(result.get('name','')).strip();expression=str(result.get('expression','')).strip()
        if not name or not expression: raise ValueError('AI response was missing name or expression.')
        compile_row_expression(expression,columns)
        return {'name':re.sub(r'\s+','_',name)[:128],'expression':expression,'explanation':str(result.get('explanation','Generated by Gemini AI.')),'grounding':columns}
    except Exception as ai_error:
        c=mentioned[0] if mentioned else best(fallback=False)
        hint=f' The most likely referenced column is {c}.' if c else ''
        raise ValueError('I could not determine the requested row-level operation and AI generation failed ('+str(ai_error)+').'+hint+' Try a precise instruction such as: CustomerID first 3 characters from left; extract last 4 characters from OrderID; if Status is Done then Closed else Open; or days between OrderDate and ShipDate.')

def compile_steps(source, steps, preview_limit=200):
    params=[];ctes=[f's0 AS (SELECT * FROM {quote(source)})'];current='s0';cols=_columns(source);i=0
    folding=[]
    for pos,st in enumerate(steps):
        typ=st.get('type')
        if typ in (None,'source') or st.get('enabled',True) is False:
            if typ=='source': folding.append({'id':st.get('id'),'type':'source','status':'native','message':'Source table'})
            continue
        i+=1;nxt=f's{i}'
        status='pushdown';message='Compiled to source SQL'
        if typ=='native_query':
            if pos != len(steps)-1:
                raise ValueError('Advanced Query must be the final transformation step.')
            query = validate_native_query(st.get('sql',''))
            folding.append({'id':st.get('id'),'type':typ,'status':'native','message':'Read-only Advanced Query'})
            final = query
            if preview_limit:
                final = f'SELECT * FROM ({query}) AS "_vtab_advanced_query" LIMIT {int(preview_limit)}'
            return final,[],[],folding
        if typ=='select_columns':
            wanted=[c for c in st.get('columns',[]) if c in cols]
            if not wanted:raise ValueError('Select Columns requires one or more valid columns.')
            sql=f'SELECT {", ".join(quote(c) for c in wanted)} FROM {current}';cols=wanted
        elif typ=='remove_columns':
            remove=set(st.get('columns',[]));new=[c for c in cols if c not in remove]
            if not new:raise ValueError('Cannot remove every column.')
            sql=f'SELECT {", ".join(quote(c) for c in new)} FROM {current}';cols=new
        elif typ=='rename':
            old,new=st['field'],st['newName'].strip()
            if old not in cols:raise ValueError(f'Column {old} not found.')
            if not new:raise ValueError('New column name is required.')
            if new in cols and new!=old:raise ValueError(f'Column {new} already exists.')
            sql='SELECT '+', '.join(f'{quote(c)} AS {quote(new)}' if c==old else quote(c) for c in cols)+f' FROM {current}'
            cols=[new if c==old else c for c in cols]
        elif typ=='filter':
            field=st['field'];op=st.get('operator','equals')
            cond={'field':field,'operator':op,'value':st.get('value')}
            sql=f'SELECT * FROM {current} WHERE {_condition_sql(cond,params)}'
        elif typ=='sort':
            specs=st.get('sorts') or [{'field':st['field'],'direction':st.get('direction','asc')}]
            order=', '.join(f'{quote(s["field"])} {"DESC" if s.get("direction")=="desc" else "ASC"}' for s in specs)
            sql=f'SELECT * FROM {current} ORDER BY {order}'
        elif typ=='top_n':sql=f'SELECT * FROM {current} LIMIT {min(max(int(st.get("value",100)),1),5000)}'
        elif typ=='distinct':sql=f'SELECT DISTINCT * FROM {current}'
        elif typ=='replace':
            field=st['field'];old=st.get('oldValue');new=st.get('newValue');mode=st.get('mode','value')
            expr=[]
            for c in cols:
                if c==field:
                    if mode=='null':
                        expr.append(f'CASE WHEN {quote(c)} IS NULL OR TRIM(CAST({quote(c)} AS TEXT))=\'\' THEN ? ELSE {quote(c)} END AS {quote(c)}');params.append(new)
                    else:
                        expr.append(f'CASE WHEN {quote(c)} = ? THEN ? ELSE {quote(c)} END AS {quote(c)}');params += [old,new]
                else:expr.append(quote(c))
            sql='SELECT '+', '.join(expr)+f' FROM {current}'
        elif typ=='change_type':
            field=st['field'];target=st.get('dataType','text');datefmt=st.get('dateFormat','auto')
            sql='SELECT '+', '.join(f'{_cast_expr(c,target,datefmt)} AS {quote(c)}' if c==field else quote(c) for c in cols)+f' FROM {current}'
        elif typ=='bulk_change_type':
            mappings={m.get('field'):m for m in st.get('mappings',[]) if m.get('field') in cols}
            if not mappings: raise ValueError('Bulk Data Types requires at least one column mapping.')
            expressions=[]
            for c in cols:
                m=mappings.get(c)
                if m:
                    expressions.append(f'{_cast_expr(c,m.get("dataType","text"),m.get("dateFormat","auto"))} AS {quote(c)}')
                else:
                    expressions.append(quote(c))
            sql='SELECT '+', '.join(expressions)+f' FROM {current}'
            message=f'Converted {len(mappings)} columns in one pushdown step'
        elif typ=='text_transform':
            field=st['field'];op=st.get('operation','trim');q=quote(field);arg=st.get('argument','');arg2=st.get('argument2','')
            lit=lambda x: "'"+str(x).replace("'","''")+"'"
            mapping={
              'trim':f'TRIM(CAST({q} AS VARCHAR))','lower':f'LOWER(CAST({q} AS VARCHAR))','upper':f'UPPER(CAST({q} AS VARCHAR))',
              'clean':f"REGEXP_REPLACE(CAST({q} AS VARCHAR), '[[:cntrl:]]+', ' ', 'g')",
              'length':f'LENGTH(CAST({q} AS VARCHAR))','reverse':f'REVERSE(CAST({q} AS VARCHAR))',
              'remove_spaces':f'REPLACE(CAST({q} AS VARCHAR), ' ', '')'
            }
            if op in ('capitalize','proper'):
                expr=f'UPPER(substr(TRIM(CAST({q} AS VARCHAR)),1,1)) || LOWER(substr(TRIM(CAST({q} AS VARCHAR)),2))'
            elif op=='replace':expr=f'REPLACE(CAST({q} AS VARCHAR), {lit(arg)}, {lit(arg2)})'
            elif op=='index':expr=f'POSITION({lit(arg)} IN CAST({q} AS VARCHAR))'
            elif op=='contains':expr=f'POSITION({lit(arg)} IN CAST({q} AS VARCHAR)) > 0'
            elif op=='starts_with':expr=f'STARTS_WITH(CAST({q} AS VARCHAR), {lit(arg)})'
            elif op=='ends_with':expr=f'ENDS_WITH(CAST({q} AS VARCHAR), {lit(arg)})'
            elif op=='before_delimiter':expr=f'SPLIT_PART(CAST({q} AS VARCHAR), {lit(arg)}, 1)'
            elif op=='after_delimiter':expr=f'NULLIF(SPLIT_PART(CAST({q} AS VARCHAR), {lit(arg)}, 2), '')'
            elif op=='pad_start':expr=f'LPAD(CAST({q} AS VARCHAR), {int(arg or 0)}, {lit(arg2 or " ")})'
            elif op=='pad_end':expr=f'RPAD(CAST({q} AS VARCHAR), {int(arg or 0)}, {lit(arg2 or " ")})'
            elif op=='prefix':expr=f'{lit(arg)} || CAST({q} AS VARCHAR)'
            elif op=='suffix':expr=f'CAST({q} AS VARCHAR) || {lit(arg)}'
            elif op=='extract_start':expr=f'SUBSTR(CAST({q} AS VARCHAR), 1, {int(arg or 1)})'
            elif op=='extract_end':expr=f'RIGHT(CAST({q} AS VARCHAR), {int(arg or 1)})'
            elif op=='range':expr=f'SUBSTR(CAST({q} AS VARCHAR), {int(arg or 1)}, {int(arg2 or 1)})'
            else:expr=mapping.get(op)
            if not expr:raise ValueError('Unsupported text transformation.')
            output=st.get('outputName') or field
            if output!=field and output in cols:raise ValueError(f'Column {output} already exists.')
            pieces=[]
            for c in cols:
                pieces.append(quote(c))
                if c==field and output!=field:pieces.append(f'{expr} AS {quote(output)}')
                elif c==field:pieces[-1]=f'{expr} AS {quote(field)}'
            sql='SELECT '+', '.join(pieces)+f' FROM {current}'
            if output!=field:cols=[x for c in cols for x in ([c,output] if c==field else [c])]
        elif typ=='split_delimiter':
            field=st['field'];delimiter=st.get('delimiter',',');mode=st.get('occurrence','first');leftname=st.get('leftName') or field+'_1';rightname=st.get('rightName') or field+'_2'
            if delimiter=='':raise ValueError('Delimiter cannot be empty.')
            d="'"+delimiter.replace("'","''")+"'"
            left=f"split_part(CAST({quote(field)} AS VARCHAR), {d}, 1)"
            right=f"NULLIF(split_part(CAST({quote(field)} AS VARCHAR), {d}, 2),'')"
            pieces=[]
            for c in cols:
                if c==field:
                    pieces += [f'{left} AS {quote(leftname)}',f'{right} AS {quote(rightname)}']
                else:pieces.append(quote(c))
            sql='SELECT '+', '.join(pieces)+f' FROM {current}';cols=[leftname,rightname] if cols==[field] else [x for c in cols for x in ([leftname,rightname] if c==field else [c])]
            if mode!='first':message='Current local engine uses first-occurrence split; additional split modes remain available through dialect extensions.'
        elif typ=='merge_columns':
            fields=[x for x in st.get('fields',[]) if x in cols];name=st.get('name','Merged');delimiter=st.get('delimiter',' ')
            if len(fields)<2:raise ValueError('Merge requires at least two columns.')
            params.append(delimiter)
            # COALESCE each field to text and join with a parameterized delimiter.
            concat=(' || ? || ').join(f'COALESCE(CAST({quote(f)} AS TEXT),\'\')' for f in fields)
            keep=[c for c in cols if c not in fields] if st.get('removeOriginals',False) else list(cols)
            sql='SELECT '+', '.join([quote(c) for c in keep]+[f'{concat} AS {quote(name)}'])+f' FROM {current}';cols=keep+[name]
            # concat uses delimiter N-1 times
            params[-1:]=[delimiter]*(len(fields)-1)
        elif typ=='date_parse':
            field=st['field'];fmt=st.get('format','auto');expr=_date_expr(field,fmt)
            sql='SELECT '+', '.join(f'{expr} AS {quote(c)}' if c==field else quote(c) for c in cols)+f' FROM {current}'
        elif typ=='date_part':
            field=st['field'];part=st.get('part','year');name=st.get('name') or f'{field}_{part}'
            d=f'TRY_CAST({quote(field)} AS DATE)'
            if part=='year':expr=f'year({d})'
            elif part=='quarter':expr=f"'Q' || CAST(quarter({d}) AS VARCHAR)"
            elif part=='month':expr=f'month({d})'
            elif part=='day':expr=f'day({d})'
            elif part=='week':expr=f'week({d})'
            elif part=='weekday':expr=f'dayofweek({d})'
            elif part=='month_name':expr=f"strftime({d}, '%b')"
            elif part=='start_of_month':expr=f"date_trunc('month',{d})::DATE"
            elif part=='end_of_month':expr=f"last_day({d})"
            else:raise ValueError('Unsupported date part.')
            sql=f'SELECT *, {expr} AS {quote(name)} FROM {current}';cols=cols+[name]
        elif typ=='conditional_column':
            name=st['name'];clauses=[]
            for rule in st.get('rules',[]):
                conds=rule.get('conditions',[]);joiner=' OR ' if rule.get('logic','and')=='or' else ' AND '
                if not conds:continue
                condsql=joiner.join(_condition_sql(c,params) for c in conds)
                params.append(rule.get('result'))
                clauses.append(f'WHEN {condsql} THEN ?')
            params.append(st.get('elseValue'))
            case='CASE '+' '.join(clauses)+' ELSE ? END'
            sql=f'SELECT *, {case} AS {quote(name)} FROM {current}';cols=cols+[name]
        elif typ=='calculated_column':
            name=(st.get('name') or 'Calculated Column').strip()
            if not name: raise ValueError('Calculated column name is required.')
            if name in cols: raise ValueError(f'Column {name} already exists.')
            if st.get('expression'):
                calc=compile_row_expression(st['expression'],cols)
            else:
                # Backward compatibility with the earlier arithmetic builder.
                left=quote(st['left']);op=st.get('operator','-')
                if op not in ('+','-','*','/'):raise ValueError('Calculated column supports + - * /.')
                right=quote(st['rightField']) if st.get('rightField') else '?'
                if not st.get('rightField'):params.append(st.get('rightValue',0))
                calc=f'({left} {op} NULLIF({right},0))' if op=='/' else f'({left} {op} {right})'
            sql=f'SELECT *, {calc} AS {quote(name)} FROM {current}';cols=cols+[name]
            message='Row-level calculated column compiled to DuckDB SQL pushdown'
        elif typ=='join':
            other=st['otherTable'];kind=st.get('joinType','left').lower();keys=st.get('keys') or [{'leftField':st.get('leftField'),'rightField':st.get('rightField')}]
            join_map={'left':'LEFT','inner':'INNER','right':'RIGHT','full':'FULL OUTER'};join_sql=join_map.get(kind,'LEFT')
            if kind in ('right','full'):message='Native DuckDB RIGHT/FULL join pushdown.'
            othercols=_columns(other);right_select=[];newcols=list(cols)
            for c in othercols:
                if any(c==k.get('rightField') for k in keys):continue
                alias=c if c not in newcols else f'{other}_{c}'
                right_select.append(f'r.{quote(c)} AS {quote(alias)}');newcols.append(alias)
            extra=(', '+', '.join(right_select)) if right_select else ''
            on=' AND '.join(f'l.{quote(k["leftField"])} = r.{quote(k["rightField"])}' for k in keys)
            sql=f'SELECT l.*{extra} FROM {current} l {join_sql} JOIN {quote(other)} r ON {on}';cols=newcols
        elif typ=='append':
            tables=st.get('tables') or [st.get('otherTable')];tables=[t for t in tables if t]
            query_outputs=st.get('queryOutputs') or []
            compiled_outputs=[]
            for output in query_outputs:
                other_sql,other_params,other_cols,_=compile_steps(output.get('source'),output.get('steps') or [],None)
                compiled_outputs.append((other_sql,other_cols))
                params.extend(other_params)
            allcols=[set(_columns(t)) for t in tables]+[set(x[1]) for x in compiled_outputs]
            common=[c for c in cols if all(c in x for x in allcols)]
            if not common:raise ValueError('No common columns found to append.')
            expr=', '.join(quote(c) for c in common)
            parts=[f'SELECT {expr} FROM {current}']+[f'SELECT {expr} FROM {quote(t)}' for t in tables]
            parts += [f'SELECT {expr} FROM ({other_sql}) AS {quote("append_query_"+str(index))}' for index,(other_sql,_) in enumerate(compiled_outputs)]
            sql=' UNION ALL '.join(parts)
            cols=common
        elif typ=='unpivot':
            unpivot_cols=st.get('columns',[])
            if not unpivot_cols:raise ValueError('No columns selected to transpose/unpivot.')
            name_col=st.get('nameColumn','Attribute')
            val_col=st.get('valueColumn','Value')
            unpivot_str=', '.join(quote(c) for c in unpivot_cols)
            sql=f'UNPIVOT {current} ON {unpivot_str} INTO NAME {quote(name_col)} VALUE {quote(val_col)}'
        elif typ=='group_by':
            groups=st.get('groupFields',[]);aggs=st.get('aggregations')
            if not aggs:aggs=[{'field':st['field'],'aggregation':st.get('aggregation','sum'),'alias':st.get('alias')}]
            parts=[quote(g) for g in groups];newcols=list(groups)
            for a in aggs:
                field=a['field'];agg=a.get('aggregation','sum').lower();alias=a.get('alias') or f'{agg}_{field}'
                if agg=='distinctcount':expr=f'COUNT(DISTINCT {quote(field)})'
                else:
                    fn={'sum':'SUM','avg':'AVG','min':'MIN','max':'MAX','count':'COUNT'}.get(agg)
                    if not fn:raise ValueError('Unsupported aggregation')
                    expr=f'{fn}({quote(field)})'
                parts.append(f'{expr} AS {quote(alias)}');newcols.append(alias)
            sql=f'SELECT {", ".join(parts)} FROM {current}'
            if groups:sql+=' GROUP BY '+', '.join(quote(g) for g in groups)
            cols=newcols
        else:raise ValueError(f'Unsupported transformation: {typ}')
        ctes.append(f'{nxt} AS ({sql})');current=nxt;folding.append({'id':st.get('id'),'type':typ,'status':status,'message':message})
    final=f'WITH {", ".join(ctes)} SELECT * FROM {current}'
    if preview_limit:final+=f' LIMIT {int(preview_limit)}'
    return final,params,cols,folding

def _rows(con,sql,params):
    cur=con.execute(sql,params)
    cols=[d[0] for d in cur.description]
    return [dict(zip(cols,r)) for r in cur.fetchall()]

def preview(source,steps,limit=200):
    sql,p,cols,folding=compile_steps(source,steps,limit);c=connect()
    try:return _rows(c,sql,p),sql,cols,folding
    finally:c.close()

def materialize(source,steps,output_table):
    sql,p,cols,_=compile_steps(source,steps,None)
    out=re.sub(r'[^A-Za-z0-9_]+','_',output_table).strip('_') or 'TransformedData'
    if out[0].isdigit():out='T_'+out
    out='ETL_'+out[:70] if not out.startswith('ETL_') else out[:74]
    count,_=materialize_query(sql,p,out)
    return out,count,cols

def join_profile(source,steps,other_table,keys):
    base_sql,p,_,_=compile_steps(source,steps,None)
    on=' AND '.join(f'l.{quote(k["leftField"])}=r.{quote(k["rightField"])}' for k in keys)
    c=connect()
    try:
        left=c.execute(f'SELECT COUNT(*) FROM ({base_sql}) l',p).fetchone()[0]
        matched=c.execute(f'SELECT COUNT(*) FROM ({base_sql}) l WHERE EXISTS (SELECT 1 FROM {quote(other_table)} r WHERE {on})',p).fetchone()[0]
        right=c.execute(f'SELECT COUNT(*) FROM {quote(other_table)}').fetchone()[0]
        right_unmatched=c.execute(f'SELECT COUNT(*) FROM {quote(other_table)} r WHERE NOT EXISTS (SELECT 1 FROM ({base_sql}) l WHERE {on})',p).fetchone()[0]
        return {'leftRows':left,'matchedLeftRows':matched,'unmatchedLeftRows':max(left-matched,0),'matchRate':round((matched/left*100) if left else 0,2),'rightRows':right,'unmatchedRightRows':right_unmatched}
    finally:c.close()

def ai_suggestions(source,steps):
    rows,_,cols,_=preview(source,steps,100)
    suggestions=[]
    if not rows:return suggestions
    for col in cols:
        vals=[r.get(col) for r in rows]
        strings=[v for v in vals if isinstance(v,str)]
        if strings and any(v!=v.strip() for v in strings):
            suggestions.append({'title':f'Trim {col}','reason':'Leading/trailing spaces detected','step':{'type':'text_transform','label':f'Trim {col}','field':col,'operation':'trim'}})
        nulls=sum(v is None or (isinstance(v,str) and not v.strip()) for v in vals)
        if nulls>0:
            suggestions.append({'title':f'Handle blanks in {col}','reason':f'{nulls} blank/null values found in preview','step':{'type':'replace','label':f'Replace blank {col}','field':col,'mode':'null','newValue':'Unknown'}})
        name=col.lower()
        if 'date' in name or name.endswith('dt'):
            if strings:
                suggestions.append({'title':f'Convert {col} to Date','reason':'Column name and sample values suggest a date','step':{'type':'date_parse','label':f'Parse {col} as date','field':col,'format':'auto'}})
            elif any(v is not None and hasattr(v,'isoformat') for v in vals):
                suggestions.append({'title':f'Date column {col} recognized','reason':'The source already supplies a typed date; keep the explicit date type for modeling and hierarchies','step':{'type':'change_type','label':f'Keep {col} as date','field':col,'dataType':'date'}})
    keys=[tuple(r.get(c) for c in cols) for r in rows]
    if len(set(keys))<len(keys):
        suggestions.append({'title':'Remove duplicate rows','reason':'Duplicate rows detected in the preview','step':{'type':'distinct','label':'Remove Duplicates'}})
    return suggestions[:8]
