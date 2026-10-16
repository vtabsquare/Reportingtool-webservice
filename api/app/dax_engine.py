from __future__ import annotations
import re
from dataclasses import dataclass
from functools import lru_cache

class DaxError(ValueError): pass

# One authoritative public capability registry. API health checks, diagnostics,
# AI prompting, and the editor all derive from this list so they cannot drift.
DAX_ENGINE_VERSION='5.0.23-dax-recovery-2'
SUPPORTED_DAX_FUNCTIONS=frozenset({
    'ABS','ADDCOLUMNS','ALL','AND','AVERAGE','AVERAGEX','BLANK','CALCULATE','CEILING',
    'COALESCE','CONCATENATE','CONTAINSSTRING','CONTAINSSTRINGEXACT','COUNT',
    'CONCATENATEX','COUNTROWS','DATE','DATEADD','DATEDIFF','DATESBETWEEN','DATESINPERIOD',
    'DATESMTD','DATESQTD','DATESYTD','DAY','DISTINCTCOUNT','DIVIDE','EDATE',
    'ENDOFMONTH','EOMONTH','FALSE','FILTER','FLOOR','IF','INT','ISBLANK',
    'KEEPFILTERS','LEFT','LEN','LOWER','MAX','MAXX','MEDIAN','MID','MIN',
    'MINX','MONTH','NOT','NOW','OR','POWER','REMOVEFILTERS','RIGHT','ROUND',
    'SAMEPERIODLASTYEAR','SELECTEDVALUE','SQRT','STARTOFMONTH','SUBSTITUTE',
    'SUM','SUMMARIZE','SUMX','SWITCH','TODAY','TOPN','TOTALMTD','TOTALQTD','TOTALYTD','TRIM',
    'TRUE','UPPER','VALUE','VALUES','YEAR',
})

# Known Power BI functions must never be treated as spelling mistakes merely
# because this engine does not support them yet. They receive an honest
# compatibility diagnostic instead of an unsafe automatic substitution.
KNOWN_DAX_FUNCTIONS=SUPPORTED_DAX_FUNCTIONS | frozenset({
    'CALCULATETABLE','CURRENTGROUP','DISTINCT','EXCEPT','GENERATE','GENERATEALL',
    'GROUPBY','INTERSECT','LOOKUPVALUE','NATURALINNERJOIN','NATURALLEFTOUTERJOIN',
    'RANKX','RELATED','RELATEDTABLE','SELECTCOLUMNS','TREATAS','UNION',
    'USERELATIONSHIP','VALUES','CROSSFILTER',
})

def _function_calls(text:str):
    """Return (start, end, uppercase_name) calls, excluding quoted content."""
    calls=[];i=0;quote=None
    while i<len(text):
        ch=text[i]
        if quote:
            if ch==quote and (i==0 or text[i-1]!='\\'):quote=None
            i+=1;continue
        if ch in ("'",'"'):quote=ch;i+=1;continue
        if ch.isalpha() or ch=='_':
            start=i;i+=1
            while i<len(text) and (text[i].isalnum() or text[i]=='_'):i+=1
            end=i
            while i<len(text) and text[i].isspace():i+=1
            if i<len(text) and text[i]=='(':calls.append((start,end,text[start:end].upper()))
            continue
        i+=1
    return calls

def _edit_distance(a:str,b:str):
    previous=list(range(len(b)+1))
    for i,left in enumerate(a,1):
        current=[i]
        for j,right in enumerate(b,1):
            current.append(min(current[-1]+1,previous[j]+1,previous[j-1]+(left!=right)))
        previous=current
    return previous[-1]

def _structure_issues(text:str):
    stack=[];quote=None;pairs={')':'(',']':'[','}':'{'}
    for index,char in enumerate(text):
        if quote:
            if char==quote and (index==0 or text[index-1]!='\\'):quote=None
            continue
        if char in ("'",'"'):quote=char;continue
        if char in '([{':stack.append((char,index))
        elif char in ')]}':
            if not stack or stack[-1][0]!=pairs[char]:return [f'Unexpected {char} at character {index+1}.']
            stack.pop()
    issues=[]
    if quote:issues.append('A quoted value or table name is not closed.')
    if stack:issues.append('One or more parentheses, brackets, or braces are not closed.')
    return issues

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

def repair_dax_definition(expression:str):
    """Apply only syntax-preserving repairs and report every change.

    These repairs handle common copy/paste and locale damage. They never rename
    fields, measures, tables, functions, or change business logic.
    """
    original=str(expression or '')
    text=original.replace('\r\n','\n').replace('\r','\n')
    repairs=[]
    translated=text.translate(str.maketrans({
        '\u201c':'"','\u201d':'"','\u201e':'"','\u00ab':'"','\u00bb':'"',
        '\u2018':"'",'\u2019':"'",'\u201a':"'",'\u00a0':' ',
    }))
    if translated!=text:
        text=translated;repairs.append('Normalized smart quotes and non-breaking spaces.')

    # Many regional DAX editors use semicolons as argument separators. Convert
    # them only outside quoted strings/table names.
    out=[];quote=None;changed=False
    for index,char in enumerate(text):
        if quote:
            out.append(char)
            if char==quote and (index==0 or text[index-1]!='\\'):quote=None
            continue
        if char in ("'",'"'):
            quote=char;out.append(char)
        elif char==';':
            out.append(',');changed=True
        else:out.append(char)
    if changed:
        text=''.join(out);repairs.append('Converted regional semicolon argument separators to commas.')

    # A surprisingly common paste artefact is an empty first argument: FILTER(,
    # Table,...). Removing only that empty delimiter cannot alter valid DAX.
    cleaned=re.sub(r'(?is)(\b(?:CALCULATE|FILTER|DIVIDE|IF|SWITCH|COALESCE|AND|OR)\s*\()\s*,',r'\1',text)
    if cleaned!=text:
        text=cleaned;repairs.append('Removed an empty first argument introduced during copy/paste.')

    # FILTER requires a table as its first argument. VALUE(column) is scalar,
    # while VALUES(column) is the unambiguous intended table expression here.
    fixed_values=re.sub(r'(?is)(\bFILTER\s*\(\s*)VALUE(\s*\()',r'\1VALUES\2',text)
    if fixed_values!=text:
        text=fixed_values;repairs.append('Corrected scalar VALUE to table-valued VALUES inside FILTER.')

    # Recover unambiguous one-character function-name typos. This is deliberately
    # conservative: multiple possible matches or larger changes remain diagnostics.
    replacements=[]
    for start,end,name in _function_calls(text):
        if name in KNOWN_DAX_FUNCTIONS:continue
        matches=[candidate for candidate in SUPPORTED_DAX_FUNCTIONS if _edit_distance(name,candidate)==1]
        if len(matches)==1:replacements.append((start,end,matches[0],name))
    for start,end,replacement,original_name in reversed(replacements):
        text=text[:start]+replacement+text[end:]
        repairs.append(f'Corrected function name {original_name} to {replacement}.')

    # CONCATENATE has exactly two scalar arguments. A three-or-more argument
    # call whose first argument is a table variable is unambiguously the common
    # CONCATENATEX spelling mistake; preserve intent rather than dropping args.
    for start,end,name in reversed(_function_calls(text)):
        if name!='CONCATENATE':continue
        open_pos=text.find('(',end);depth=0;quote=None;close_pos=None
        for index in range(open_pos,len(text)):
            char=text[index]
            if quote:
                if char==quote and text[index-1]!='\\':quote=None
                continue
            if char in ("'",'"'):quote=char;continue
            if char=='(':depth+=1
            elif char==')':
                depth-=1
                if depth==0:close_pos=index;break
        if close_pos is not None and len(split_top(text[open_pos+1:close_pos]))>=3:
            text=text[:start]+'CONCATENATEX'+text[end:]
            repairs.append('Corrected three-argument CONCATENATE to CONCATENATEX.')

    return {'expression':text.strip(),'changed':text.strip()!=original.strip(),'repairs':repairs}

def diagnose_dax_definition(expression:str):
    repair=repair_dax_definition(expression);text=repair['expression'];issues=_structure_issues(text)
    definition=parse_measure_definition(text)
    if not definition:
        issues.append('Start the formula with a measure name followed by =.')
    unknown=sorted({name for _,_,name in _function_calls(strip_assignment(text)) if name not in SUPPORTED_DAX_FUNCTIONS})
    suggestions={}
    for name in unknown:
        ranked=sorted(SUPPORTED_DAX_FUNCTIONS,key=lambda candidate:(_edit_distance(name,candidate),candidate))
        suggestions[name]=ranked[:3]
        issues.append(f'Unsupported DAX function {name}.')
    return {**repair,'issues':issues,'unknownFunctions':unknown,'suggestions':suggestions,
            'engineVersion':DAX_ENGINE_VERSION}

def _mapping_value(mapping,name):
    """DAX identifiers are case-insensitive, including VAR names."""
    if name in mapping:return mapping[name]
    lowered=str(name).lower()
    for key,value in mapping.items():
        if str(key).lower()==lowered:return value
    raise KeyError(name)

def strip_assignment(expression:str):
    text=expression.strip()
    definition=parse_measure_definition(text)
    return definition[1] if definition else text

def parse_measure_definition(expression:str):
    """Return ``(measure_name, dax_body)`` for ``Name = expression`` input.

    Measure authoring uses the Power BI convention where the text before the
    first top-level equals sign is the measure name.  Keeping this parser in the
    engine gives validation, save, AI, and bulk-create paths one authoritative
    interpretation instead of trusting a second UI name field.
    """
    text=str(expression or '').strip()
    # The first line before a *top-level* equals sign is opaque display text.
    # Comparisons inside CALCULATE/FILTER parentheses are never name separators.
    first_line=text.splitlines()[0] if text else ''
    depth=0;quote=None;separator=None
    for index,char in enumerate(first_line):
        if quote:
            if char==quote and (index==0 or first_line[index-1]!='\\'):quote=None
            continue
        if char in ("'",'"'):quote=char;continue
        if char in '([':depth+=1;continue
        if char in ')]':depth=max(0,depth-1);continue
        if char=='=' and depth==0:separator=index;break
    if separator is None:return None
    name=first_line[:separator].strip()
    body=(first_line[separator+1:]+'\n'+'\n'.join(text.splitlines()[1:])).strip()
    if not name or not body:return None
    if name.upper().startswith('VAR ') or name.upper() == 'VAR':return None
    return name,body

def normalize(s):return re.sub(r'[^a-z0-9]','',s.lower())

def resolve_table(model, table, column=None):
    """Resolve a DAX table name to a model table key.
    Tries exact match first, then fuzzy normalized matching,
    then column-based lookup, then single-table fallback.
    """
    tables = model.get('tables', {})
    # 1. Exact match
    if table in tables:
        return table
    # 2. Case-insensitive exact match
    tl = table.lower()
    for k in tables:
        if k.lower() == tl:
            return k
    # 3. Normalized substring match — 'sales' matches 'sales_dataset_100_rows_multi_year_1_Copy'
    norm_search = normalize(table)
    candidates = [k for k in tables if norm_search in normalize(k)]
    if len(candidates) == 1:
        return candidates[0]
    # 4. Normalized prefix match for ambiguous cases — pick longest match
    if candidates:
        return max(candidates, key=lambda k: len(normalize(k)))
    # 5. Column-based fallback — when AI uses a generic name like 'Table',
    #    find whichever table actually has the requested column
    if column:
        col_lower = column.strip().lower()
        col_matches = [
            k for k, t in tables.items()
            if any(c.lower() == col_lower for c in t.get('columns', {}))
        ]
        if len(col_matches) == 1:
            return col_matches[0]
        if col_matches:
            return col_matches[0]  # pick first match if ambiguous
    # 6. Last resort: if there's only one table in the model, use it
    if len(tables) == 1:
        return next(iter(tables))
    raise DaxError(f"Unknown table '{table}'")

def resolve_field(model,table,column,alias=None):
    table=table.strip();column=column.strip()
    table=resolve_table(model,table,column)
    cols=model['tables'][table].get('columns',{})
    if column not in cols:
        # Try case-insensitive column match
        col_lower = column.lower()
        matched = next((c for c in cols if c.lower() == col_lower), None)
        if matched:
            column = matched
        else:
            raise DaxError(f"Unknown column '{table}[{column}]'")
    return f'{qi(alias or table)}.{qi(cols[column])}'

def semantic_field(table,column):return f'{table.strip()}.{column.strip()}'

@dataclass
class DaxTable:
    sql:str
    table:str
    columns:dict[str,str]
    source_table:str|None=None
    group_columns:tuple[str,...]=()
    computed:tuple[tuple[str,str],...]=()
    remove_group_filters:bool=False

def _virtual_column(table:DaxTable,name:str):
    lowered=name.strip().lower()
    for key,value in table.columns.items():
        if key.lower()==lowered or value.lower()==lowered:return value
    return None

def _virtual_scalar(expr,table:DaxTable,model,measure_resolver=None,filters=None,as_condition=False):
    context_transition=re.fullmatch(r'(?is)CALCULATE\s*\((.*)\)',expr.strip())
    if context_transition and table.source_table and table.group_columns:
        args=split_top(context_transition.group(1))
        if len(args)==1:
            source=table.source_table;physical=model['tables'][source]['physical']
            base=_compile_simple(args[0],model,measure_resolver,filters)
            predicates=[]
            for column in table.group_columns:
                inner=resolve_field(model,source,column,source);outer=f'{qi("__row")}.{qi(column)}'
                predicates.append(f'{inner} IS NOT DISTINCT FROM {outer}')
            context=_context_predicate(model,source,filters or [],source)
            if context:predicates.append(context)
            aggregate=_attach_filter(base,' AND '.join(f'({item})' for item in predicates))
            return f'(SELECT {aggregate} FROM {qi(physical)} {qi(source)})'
    def replace_field(match):
        column=match.group(2).strip();actual=_virtual_column(table,column)
        if actual is None:raise DaxError(f"Virtual table does not contain column [{column}]")
        return f'__row[{actual}]'
    rewritten=re.sub(r"(?is)'?([A-Za-z_][\w ]*)'?\s*\[\s*([^\]]+)\s*\]",replace_field,expr)
    columns={value:value for value in table.columns.values()}
    virtual_model={**model,'tables':{**model.get('tables',{}),'__row':{'physical':'__virtual','columns':columns}}}
    def resolver(name):
        actual=_virtual_column(table,name)
        if actual is not None:return f'{qi("__row")}.{qi(actual)}'
        if measure_resolver:return measure_resolver(name)
        raise DaxError(f"Unknown virtual column or measure [{name}]")
    compiler=_condition if as_condition else _compile_simple
    return compiler(rewritten,virtual_model,resolver,filters or [])

def _render_group_table(source_table,group_columns,computed,model,filters,measure_resolver,remove_group_filters=False):
    source_table=resolve_table(model,source_table);physical=model['tables'][source_table]['physical'];alias=source_table
    group_sql=[];select_sql=[];columns={}
    for column in group_columns:
        field=resolve_field(model,source_table,column,alias);actual=parse_field(f'{source_table}[{column}]')[1]
        select_sql.append(f'{field} AS {qi(actual)}');group_sql.append(field);columns[actual]=actual
    for name,expression in computed:
        value=_compile_simple(expression,model,measure_resolver,filters)
        select_sql.append(f'{value} AS {qi(name)}');columns[name]=name
    active_filters=filters or []
    if remove_group_filters:
        removed={semantic_field(source_table,column).lower() for column in group_columns}
        active_filters=[item for item in active_filters if str(item.get('field','')).split('::',1)[0].lower() not in removed]
    predicate=_context_predicate(model,source_table,active_filters,alias)
    sql=f'SELECT {", ".join(select_sql)} FROM {qi(physical)} {qi(alias)}'
    if predicate:sql+=' WHERE '+predicate
    if group_sql:sql+=' GROUP BY '+', '.join(group_sql)
    return DaxTable(sql,source_table,columns,source_table,tuple(group_columns),tuple(computed),remove_group_filters)

def _compile_table_expr(expr,model,vars_sql,filters,measure_resolver=None):
    e=expr.strip()
    try:
        existing=_mapping_value(vars_sql,e)
        if isinstance(existing,DaxTable):return existing
    except KeyError:pass

    match=re.fullmatch(r"(?is)(ALL|VALUES)\s*\(\s*'?([A-Za-z_][\w ]*)'?\s*\[\s*([^\]]+)\]\s*\)",e)
    if match:
        kind,table,column=match.groups();table=resolve_table(model,table,column);field=resolve_field(model,table,column,table)
        physical=model['tables'][table]['physical'];column=column.strip()
        sql=f'SELECT DISTINCT {field} AS {qi(column)} FROM {qi(physical)} {qi(table)}'
        return DaxTable(sql,table,{column:column},table,(column,),(),kind.upper()=='ALL')

    match=re.fullmatch(r'(?is)SUMMARIZE\s*\((.*)\)',e)
    if match:
        args=split_top(match.group(1))
        if len(args)<2:raise DaxError('SUMMARIZE requires a table and at least one group-by column.')
        source=args[0].strip().strip("'");groups=[];computed=[];index=1
        while index<len(args):
            field=parse_field(args[index])
            if not field:break
            source=resolve_table(model,source or field[0],field[1]);groups.append(field[1]);index+=1
        while index<len(args):
            if index+1>=len(args):raise DaxError('SUMMARIZE calculated columns require a name and expression pair.')
            name=args[index].strip()
            if not (name.startswith('"') and name.endswith('"')):raise DaxError('SUMMARIZE calculated column name must be quoted.')
            computed.append((name[1:-1],args[index+1]));index+=2
        return _render_group_table(source,groups,computed,model,filters,measure_resolver)

    match=re.fullmatch(r'(?is)ADDCOLUMNS\s*\((.*)\)',e)
    if match:
        args=split_top(match.group(1))
        if len(args)<3 or len(args)%2==0:raise DaxError('ADDCOLUMNS requires a table followed by name/expression pairs.')
        base=_compile_table_expr(args[0],model,vars_sql,filters,measure_resolver)
        if base is None or base.source_table is None:raise DaxError('ADDCOLUMNS requires a supported table expression.')
        computed=list(base.computed)
        for index in range(1,len(args),2):
            name=args[index].strip()
            if not (name.startswith('"') and name.endswith('"')):raise DaxError('ADDCOLUMNS column name must be quoted.')
            computed.append((name[1:-1],args[index+1]))
        return _render_group_table(base.source_table,list(base.group_columns),computed,model,filters,measure_resolver,base.remove_group_filters)

    match=re.fullmatch(r'(?is)FILTER\s*\((.*)\)',e)
    if match:
        args=split_top(match.group(1))
        if len(args)!=2:return None
        base=_compile_table_expr(args[0],model,vars_sql,filters,measure_resolver)
        if base is None:return None
        predicate=_virtual_scalar(args[1],base,model,measure_resolver,filters,True)
        return DaxTable(f'SELECT * FROM ({base.sql}) {qi("__row")} WHERE {predicate}',base.table,base.columns,base.source_table,base.group_columns,base.computed,base.remove_group_filters)

    match=re.fullmatch(r'(?is)TOPN\s*\((.*)\)',e)
    if match:
        args=split_top(match.group(1))
        if len(args)<3:raise DaxError('TOPN requires row count, table, and at least one order expression.')
        try:limit=max(0,int(args[0].strip()))
        except ValueError:raise DaxError('TOPN row count must be an integer in this engine.')
        base=_compile_table_expr(args[1],model,vars_sql,filters,measure_resolver)
        if base is None:raise DaxError('TOPN requires a supported table expression.')
        order=[];index=2
        while index<len(args):
            value=_virtual_scalar(args[index],base,model,measure_resolver,filters);direction='DESC'
            if index+1<len(args) and args[index+1].strip().upper() in ('ASC','DESC'):
                direction=args[index+1].strip().upper();index+=1
            order.append(f'{value} {direction}');index+=1
        sql=f'SELECT * FROM ({base.sql}) {qi("__row")} ORDER BY {", ".join(order)} LIMIT {limit}'
        return DaxTable(sql,base.table,base.columns,base.source_table,base.group_columns,base.computed,base.remove_group_filters)
    return None

def parse_field(expr):
    m=re.fullmatch(r"\s*'?([A-Za-z_][\w ]*)'?\s*\[\s*([^\]]+)\]\s*",expr,re.S)
    return (m.group(1).strip(),m.group(2).strip()) if m else None

def _context_predicate(model,table,filters,alias):
    parts=[]
    table=resolve_table(model,table)
    table_meta=model.get('tables',{}).get(table,{})
    for f in filters or []:
        sf=f.get('field','')
        if '.' not in sf:continue
        t,c=sf.split('.',1);c=c.split('::',1)[0]
        try:
            resolved_t=resolve_table(model,t)
        except Exception:
            resolved_t=t
        if resolved_t!=table:continue
        cols=table_meta.get('columns',{})
        if c not in cols:
            matched=next((k for k in cols if k.lower()==c.lower()),None)
            if not matched:continue
            c=matched
        col=resolve_field(model,table,c,alias);op=f.get('operator','equals');val=f.get('value')
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
    table=resolve_table(model,table,column)
    tbl_meta=model.get('tables',{}).get(table,{})
    physical=tbl_meta.get('physical') or table
    alias='__ctx'
    col=resolve_field(model,table,column,alias)
    pred=_context_predicate(model,table,filters,alias)
    fn='AVG' if func=='AVERAGE' else func
    if fn=='DISTINCTCOUNT':
        sql=f'(SELECT COUNT(DISTINCT {col}) FROM {qi(physical)} {qi(alias)}'
    else:
        sql=f'(SELECT {fn}({col}) FROM {qi(physical)} {qi(alias)}'
    if pred:sql+=' WHERE '+pred
    return sql+')'

def _selected_bounds(model,table,column,filters):
    return (
        _selected_aggregate(model,'MIN',table,column,filters),
        _selected_aggregate(model,'MAX',table,column,filters)
    )

def _parse_vars(text):
    # Find VAR/RETURN keywords only at expression depth zero. This accepts both
    # Power BI's usual multiline layout and compact `VAR A=... VAR B=... RETURN ...`.
    source=text.replace('\r',' ');markers=[];depth=0;quote=None;i=0
    while i<len(source):
        ch=source[i]
        if quote:
            if ch==quote and (i==0 or source[i-1]!='\\'):quote=None
            i+=1;continue
        if ch in ("'",'"'):quote=ch;i+=1;continue
        if ch=='(':depth+=1;i+=1;continue
        if ch==')':depth=max(0,depth-1);i+=1;continue
        if depth==0 and (i==0 or not re.match(r'[A-Za-z0-9_]',source[i-1])):
            m=re.match(r'(?i)(VAR|RETURN)(?![A-Za-z0-9_])',source[i:])
            if m:markers.append((i,m.group(1).upper(),i+len(m.group(1))));i+=len(m.group(1));continue
        i+=1
    variables={};return_text=None
    for index,(start,kind,end) in enumerate(markers):
        stop=markers[index+1][0] if index+1<len(markers) else len(source)
        body=source[end:stop].strip()
        if kind=='RETURN':
            return_text=source[end:].strip();break
        m=re.fullmatch(r'(?is)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)',body)
        if not m:raise DaxError(f'Invalid VAR declaration: {body or "missing name/value"}')
        variables[m.group(1)]=m.group(2).strip()
    if return_text is None or not return_text:raise DaxError('VAR expression requires RETURN')
    return variables,return_text

def _compile_var_value(expr,model,vars_sql,filters,measure_resolver=None):
    """Compile a VAR assignment value. Supports all aggregate functions, DIVIDE, arithmetic,
    and measure references. Variable references are resolved before compilation."""
    expr=expr.strip()
    def var_aware_resolver(name):
        try:return _mapping_value(vars_sql,name)
        except KeyError:pass
        if measure_resolver:return measure_resolver(name)
        raise DaxError(f"Unknown measure or variable [{name}]")
    table_value=_compile_table_expr(expr,model,vars_sql,filters,var_aware_resolver)
    if table_value is not None:return table_value
    # Resolve variable references that appear directly as value
    try:return _mapping_value(vars_sql,expr)
    except KeyError:pass
    # MAX/MIN with context filter (date range subqueries)
    m=re.fullmatch(r"(?is)(MAX|MIN)\s*\(\s*(?:'?([A-Za-z_][\w ]*)'?\s*)?\[\s*([^\]]+)\]\s*\)",expr)
    if m:
        tbl = m.group(2).strip() if m.group(2) else resolve_table(model, '', m.group(3).strip())
        return _selected_aggregate(model,m.group(1).upper(),tbl,m.group(3).strip(),filters)

    # VAR dates commonly use IF(ISBLANK(MAX(...)), TODAY(), MAX(...)). Compile
    # every branch through the VAR-aware path so aggregates from another table
    # become scalar context subqueries instead of invalid cross-table columns.
    m=re.fullmatch(r'(?is)IF\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if len(args)<2:raise DaxError('IF requires a condition and a true result.')
        condition=args[0].strip()
        blank_match=re.fullmatch(r'(?is)ISBLANK\s*\((.*)\)',condition)
        not_blank_match=re.fullmatch(r'(?is)NOT\s+ISBLANK\s*\((.*)\)',condition)
        if blank_match:
            condition_sql=f'({_compile_var_value(blank_match.group(1),model,vars_sql,filters,measure_resolver)} IS NULL)'
        elif not_blank_match:
            condition_sql=f'({_compile_var_value(not_blank_match.group(1),model,vars_sql,filters,measure_resolver)} IS NOT NULL)'
        else:
            condition_sql=_condition(condition,model,var_aware_resolver,filters)
        true_sql=_compile_var_value(args[1],model,vars_sql,filters,measure_resolver)
        false_sql=_compile_var_value(args[2],model,vars_sql,filters,measure_resolver) if len(args)>2 else 'NULL'
        return f'CASE WHEN {condition_sql} THEN {true_sql} ELSE {false_sql} END'
    
    # Add support for StartDate = DATE ( YEAR(LastDataDate), MONTH(LastDataDate), 1 )
    m=re.fullmatch(r'(?is)DATE\s*\(\s*YEAR\s*\(\s*([A-Za-z_]\w*)\s*\)\s*,\s*MONTH\s*\(\s*([A-Za-z_]\w*)\s*\)\s*,\s*1\s*\)',expr)
    if m and m.group(1)==m.group(2):
        var=m.group(1)
        try:base=_mapping_value(vars_sql,var)
        except KeyError:base=var
        return f"date_trunc('month', CAST({base} AS DATE))"
  
    # Add support for VAR x = CALCULATE(...) nested structures
    m=re.fullmatch(r'(?is)CALCULATE\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if not args:raise DaxError('CALCULATE requires an expression.')
        base=_compile_simple(args[0],model,var_aware_resolver,filters)
        predicates=[]
        for item in args[1:]:
            pred,over=_compile_calculate_filter(item,model,vars_sql,filters,var_aware_resolver)
            if pred:predicates.append(pred)
        return _attach_filter(base,' AND '.join(f'({p})' for p in predicates))
    # EDATE
    m=re.fullmatch(r'(?is)EDATE\s*\(\s*([A-Za-z_]\w*)\s*,\s*(-?\d+)\s*\)\s*(?:\+\s*(\d+))?',expr)
    if m:
        var=m.group(1);months=int(m.group(2));days=int(m.group(3) or 0)
        try:base=_mapping_value(vars_sql,var)
        except KeyError:base=var
        out=f"(CAST({base} AS DATE) + INTERVAL '{months} months')"
        if days:out=f"({out} + INTERVAL '{days} day')"
        return out
    # EOMONTH
    m=re.fullmatch(r'(?is)EOMONTH\s*\(\s*([A-Za-z_]\w*)\s*,\s*(-?\d+)\s*\)\s*(?:\+\s*(\d+))?',expr)
    if m:
        var=m.group(1);months=int(m.group(2));days=int(m.group(3) or 0)
        try:base=_mapping_value(vars_sql,var)
        except KeyError:base=var
        out=f"last_day(CAST({base} AS DATE) + INTERVAL '{months} months')"
        if days:out=f"({out} + INTERVAL '{days} day')"
        return out
    if re.fullmatch(r'(?i)TODAY\s*\(\s*\)',expr):return 'current_date'
    if re.fullmatch(r'-?\d+(?:\.\d+)?',expr):return expr
    
    # For all other expressions, use _compile_simple
    try:
        return _compile_simple(expr,model,var_aware_resolver,filters,in_filter=True)
    except DaxError:
        raise DaxError(f'Unsupported VAR expression: {expr}')

def _compile_row_expr(expr,model,table):
    """Compile the per-row expression used by SUMX/AVERAGEX/MINX/MAXX.

    Iterator expressions are scalar DAX expressions, so nested DIVIDE and common
    numeric functions must be compiled recursively rather than treated as raw SQL.
    """
    e=expr.strip();table=resolve_table(model,table.strip().strip("'"))
    if _is_wrapped(e):return '('+_compile_row_expr(e[1:-1],model,table)+')'
    if re.fullmatch(r'-?\d+(?:\.\d+)?',e):return e
    if (e.startswith('"') and e.endswith('"')) or (e.startswith("'") and e.endswith("'")):return sql_literal(e[1:-1])
    if re.fullmatch(r'(?i)BLANK\s*\(\s*\)',e):return 'NULL'
    field=parse_field(e)
    if field:
        resolved=resolve_table(model,field[0],field[1])
        if resolved!=table:raise DaxError('Iterator row expression currently supports columns from its iterator table.')
        return resolve_field(model,resolved,field[1])

    match=re.fullmatch(r'(?is)DIVIDE\s*\((.*)\)',e)
    if match:
        args=split_top(match.group(1))
        if len(args)<2 or len(args)>3:raise DaxError('DIVIDE requires numerator, denominator, and an optional alternate result.')
        numerator=_compile_row_expr(args[0],model,table);denominator=_compile_row_expr(args[1],model,table)
        alternate=_compile_row_expr(args[2],model,table) if len(args)==3 else 'NULL'
        return f'COALESCE(({numerator})/NULLIF(({denominator}),0),{alternate})'

    match=re.fullmatch(r'(?is)COALESCE\s*\((.*)\)',e)
    if match:return 'COALESCE('+','.join(_compile_row_expr(arg,model,table) for arg in split_top(match.group(1)))+')'
    for dax_name,sql_name in [('ABS','ABS'),('INT','FLOOR'),('FLOOR','FLOOR'),('CEILING','CEIL'),('LEN','LENGTH'),('SQRT','SQRT')]:
        match=re.fullmatch(rf'(?is){dax_name}\s*\((.*)\)',e)
        if match:return f'{sql_name}({_compile_row_expr(match.group(1),model,table)})'
    match=re.fullmatch(r'(?is)ROUND\s*\((.*)\)',e)
    if match:
        args=split_top(match.group(1))
        if len(args)!=2 or not re.fullmatch(r'-?\d+',args[1].strip()):raise DaxError('ROUND requires an expression and an integer precision.')
        return f'ROUND({_compile_row_expr(args[0],model,table)},{int(args[1])})'
    match=re.fullmatch(r'(?is)POWER\s*\((.*)\)',e)
    if match:
        args=split_top(match.group(1))
        if len(args)!=2:raise DaxError('POWER requires a value and exponent.')
        return f'POWER({_compile_row_expr(args[0],model,table)},{_compile_row_expr(args[1],model,table)})'

    # Compile arithmetic only at expression depth zero, preserving nested calls.
    tokens=[];start=0;depth=0;quote=None
    for index,char in enumerate(e):
        if quote:
            if char==quote and (index==0 or e[index-1]!='\\'):quote=None
            continue
        if char in ("'",'"'):quote=char;continue
        if char=='(':depth+=1;continue
        if char==')':depth-=1;continue
        if depth==0 and char in '+-*/':
            prefix=e[start:index].strip()
            # A leading sign belongs to its numeric operand.
            if not prefix and char in '+-':continue
            tokens.append(_compile_row_expr(prefix,model,table));tokens.append(char);start=index+1
    if tokens:
        tail=e[start:].strip()
        if not tail:raise DaxError('Iterator arithmetic expression is incomplete.')
        tokens.append(_compile_row_expr(tail,model,table));return ' '.join(tokens)
    raise DaxError(f'Unsupported iterator expression: {expr}')

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

def _compile_simple(expr,model,measure_resolver=None,filters=None,in_filter=False):
    expr=expr.strip()
    if _is_wrapped(expr):
        return '(' + _compile_simple(expr[1:-1],model,measure_resolver,filters,in_filter=in_filter) + ')'
    if re.fullmatch(r'-?\d+(?:\.\d+)?',expr):return expr
    if (expr.startswith('"') and expr.endswith('"')) or (expr.startswith("'") and expr.endswith("'")):return sql_literal(expr[1:-1])
    if re.fullmatch(r'(?i)BLANK\s*\(\s*\)',expr):return 'NULL'
    if re.fullmatch(r'(?i)TRUE\s*\(\s*\)|TRUE',expr):return 'TRUE'
    if re.fullmatch(r'(?i)FALSE\s*\(\s*\)|FALSE',expr):return 'FALSE'
    if re.fullmatch(r'(?i)TODAY\s*\(\s*\)',expr):return 'current_date'
    if re.fullmatch(r'(?i)NOW\s*\(\s*\)',expr):return 'current_timestamp'
    m=re.fullmatch(r'(-?\d+(?:\.\d+)?)\s*%',expr)
    if m:return str(float(m.group(1))/100.0)
    m=re.fullmatch(r'\[([^\]]+)\]',expr)
    if m and measure_resolver:
        resolved = measure_resolver(m.group(1).strip())
        if in_filter and isinstance(resolved, str) and not resolved.strip().startswith('('):
            if re.match(r'(?is)^\s*(SUM|AVG|MIN|MAX|COUNT|MEDIAN)\s*\(', resolved):
                return f'(SELECT {resolved})'
        return resolved
    field_ref=parse_field(expr)
    if field_ref:return resolve_field(model,*field_ref)
    # Handle naked variables like _Occupied
    m=re.fullmatch(r'[A-Za-z_]\w*',expr)
    if m and measure_resolver:return measure_resolver(m.group(0))

    # Split top-level operators before matching function calls. Without this,
    # the greedy outer function pattern can swallow a chained expression such
    # as SUMX(...) + AVERAGEX(...) or EDATE(...) + 1.
    concat_parts=_split_logical(expr,'&')
    if concat_parts:
        return '('+' || '.join(f'CAST({_compile_simple(x,model,measure_resolver,filters,in_filter=in_filter)} AS VARCHAR)' for x in concat_parts)+')'
    tokens=[];start=0;depth=0;quote=None
    for i,ch in enumerate(expr):
        if quote:
            if ch==quote and (i==0 or expr[i-1]!='\\'):quote=None
            continue
        if ch in ("'",'"'):quote=ch;continue
        if ch=='(':depth+=1;continue
        if ch==')':depth-=1;continue
        if depth==0 and ch in '+-*/':
            left=expr[start:i].strip()
            if not left and ch in '+-':continue
            if not left:raise DaxError(f'Incomplete expression before {ch}.')
            tokens.append(_compile_simple(left,model,measure_resolver,filters,in_filter=in_filter));tokens.append(ch);start=i+1
    if tokens:
        tail=expr[start:].strip()
        if not tail:raise DaxError('Arithmetic expression is incomplete.')
        tokens.append(_compile_simple(tail,model,measure_resolver,filters,in_filter=in_filter))
        return ' '.join(tokens)

    m=re.fullmatch(r"(?is)(SUM|AVERAGE|AVG|MIN|MAX|COUNT|DISTINCTCOUNT|MEDIAN)\s*\(\s*(?:('[^']+'|[A-Za-z_][\w ]*)\s*)?\[\s*([^\]]+)\]\s*\)",expr)
    if m:
        fn,t,c=m.groups();fn=fn.upper();tbl=t.strip("'") if t else resolve_table(model,'',c.strip());col=c.strip()
        if in_filter:
            return _selected_aggregate(model,fn,tbl,col,filters)
        field=resolve_field(model,tbl,col)
        if fn=='AVERAGE':fn='AVG'
        if fn=='DISTINCTCOUNT':return f'COUNT(DISTINCT {field})'
        if fn=='MEDIAN':return f'MEDIAN({field})'
        return f'{fn}({field})'
    m=re.fullmatch(r'(?is)COUNTROWS\s*\(\s*(\'?.*?\'?)\s*\)',expr)
    if m:
        target=m.group(1).strip()
        if measure_resolver:
            try:
                table_value=measure_resolver(target)
                if isinstance(table_value,DaxTable):return f'(SELECT COUNT(*) FROM ({table_value.sql}) {qi("__row")})'
            except (DaxError,KeyError,ValueError):pass
        return 'COUNT(*)'

    m=re.fullmatch(r'(?is)(MINX|MAXX|CONCATENATEX)\s*\((.*)\)',expr)
    if m:
        fn=m.group(1).upper();args=split_top(m.group(2))
        required=3 if fn=='CONCATENATEX' else 2
        if len(args)<required:raise DaxError(f'{fn} requires at least {required} arguments.')
        table_value=None
        if measure_resolver:
            try:table_value=measure_resolver(args[0].strip())
            except (DaxError,KeyError,ValueError):pass
        if not isinstance(table_value,DaxTable):
            table_value=_compile_table_expr(args[0],model,{},filters or [],measure_resolver)
        if isinstance(table_value,DaxTable):
            value=_virtual_scalar(args[1],table_value,model,measure_resolver,filters)
            if fn in ('MINX','MAXX'):
                return f'(SELECT {fn[:-1]}({value}) FROM ({table_value.sql}) {qi("__row")})'
            delimiter=_virtual_scalar(args[2],table_value,model,measure_resolver,filters)
            order=''
            if len(args)>=4:
                order_value=_virtual_scalar(args[3],table_value,model,measure_resolver,filters)
                direction=args[4].strip().upper() if len(args)>=5 else 'ASC'
                if direction not in ('ASC','DESC'):raise DaxError('CONCATENATEX order direction must be ASC or DESC.')
                order=f' ORDER BY {order_value} {direction}'
            return f'(SELECT string_agg(CAST({value} AS VARCHAR), {delimiter}{order}) FROM ({table_value.sql}) {qi("__row")})'
    m=re.fullmatch(r'(?is)(SUMX|AVERAGEX|MINX|MAXX)\s*\(\s*(\'?.*?\'?)\s*,\s*(.*)\)',expr)
    if m:
        fn,table,rowexpr=m.groups();fn={'SUMX':'SUM','AVERAGEX':'AVG','MINX':'MIN','MAXX':'MAX'}[fn.upper()]
        tbl=table.strip().strip("'")
        return f'{fn}({_compile_row_expr(rowexpr,model,tbl)})'

    for fn,sqlfn in [('ABS','ABS'),('INT','FLOOR'),('FLOOR','FLOOR'),('CEILING','CEIL'),('LEN','LENGTH')]:
        m=re.fullmatch(rf'(?is){fn}\s*\((.*)\)',expr)
        if m:return f'{sqlfn}({_compile_simple(m.group(1),model,measure_resolver,filters)})'

    # Scalar text expressions are valid anywhere a scalar is accepted, including
    # nested FILTER predicates such as LOWER(TRIM(Table[Status])) = "converted".
    m=re.fullmatch(r'(?is)(LOWER|UPPER)\s*\((.*)\)',expr)
    if m:
        value=_compile_simple(m.group(2),model,measure_resolver,filters)
        return f'{m.group(1).upper()}(CAST({value} AS VARCHAR))'
    m=re.fullmatch(r'(?is)TRIM\s*\((.*)\)',expr)
    if m:
        value=_compile_simple(m.group(1),model,measure_resolver,filters)
        # DAX TRIM removes leading/trailing spaces and collapses repeated spaces.
        return f"regexp_replace(TRIM(CAST({value} AS VARCHAR)), '\\s+', ' ', 'g')"
    m=re.fullmatch(r'(?is)(LEFT|RIGHT)\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(2))
        if len(args)!=2:raise DaxError(f'{m.group(1).upper()} requires text and a character count.')
        value=_compile_simple(args[0],model,measure_resolver,filters)
        count=_compile_simple(args[1],model,measure_resolver,filters)
        return f'{m.group(1).upper()}(CAST({value} AS VARCHAR),CAST({count} AS INTEGER))'
    m=re.fullmatch(r'(?is)MID\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if len(args)!=3:raise DaxError('MID requires text, start position, and character count.')
        value,start,count=[_compile_simple(x,model,measure_resolver,filters) for x in args]
        return f'SUBSTR(CAST({value} AS VARCHAR),CAST({start} AS INTEGER),CAST({count} AS INTEGER))'
    m=re.fullmatch(r'(?is)(CONCATENATE|SUBSTITUTE)\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(2));name=m.group(1).upper()
        expected=2 if name=='CONCATENATE' else 3
        if len(args)!=expected:raise DaxError(f'{name} requires {expected} arguments in this engine.')
        values=[_compile_simple(x,model,measure_resolver,filters) for x in args]
        if name=='CONCATENATE':return f'(CAST({values[0]} AS VARCHAR) || CAST({values[1]} AS VARCHAR))'
        return f'REPLACE(CAST({values[0]} AS VARCHAR),CAST({values[1]} AS VARCHAR),CAST({values[2]} AS VARCHAR))'
    m=re.fullmatch(r'(?is)VALUE\s*\((.*)\)',expr)
    if m:return f'TRY_CAST({_compile_simple(m.group(1),model,measure_resolver,filters)} AS DOUBLE)'
    m=re.fullmatch(r'(?is)(CONTAINSSTRING|CONTAINSSTRINGEXACT)\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(2))
        if len(args)!=2:raise DaxError(f'{m.group(1).upper()} requires text and find_text.')
        hay=_compile_simple(args[0],model,measure_resolver,filters);needle=_compile_simple(args[1],model,measure_resolver,filters)
        if m.group(1).upper()=='CONTAINSSTRING':return f'(STRPOS(LOWER(CAST({hay} AS VARCHAR)),LOWER(CAST({needle} AS VARCHAR))) > 0)'
        return f'(STRPOS(CAST({hay} AS VARCHAR),CAST({needle} AS VARCHAR)) > 0)'
        
    m=re.fullmatch(r'(?is)ISBLANK\s*\((.*)\)',expr)
    if m:
        csql=_compile_simple(m.group(1),model,measure_resolver,filters,in_filter=in_filter)
        return f'({csql} IS NULL OR TRIM(CAST({csql} AS VARCHAR)) = \'\')'
    m=re.fullmatch(r'(?is)NOT\s*\((.*)\)',expr)
    if m:return f'(NOT ({_condition(m.group(1),model,measure_resolver,filters)}))'
    m=re.fullmatch(r'(?is)(POWER)\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(2))
        if len(args)!=2:raise DaxError('POWER requires value and exponent.')
        return f'POWER({_compile_simple(args[0],model,measure_resolver,filters)},{_compile_simple(args[1],model,measure_resolver,filters)})'
    m=re.fullmatch(r'(?is)SQRT\s*\((.*)\)',expr)
    if m:return f'SQRT({_compile_simple(m.group(1),model,measure_resolver,filters,in_filter=in_filter)})'
    m=re.fullmatch(r'(?is)DATE\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if len(args)!=3:raise DaxError('DATE requires year, month and day.')
        yy,mm,dd=[_compile_simple(a,model,measure_resolver,filters,in_filter=in_filter) for a in args]
        return f'make_date(CAST({yy} AS INTEGER),CAST({mm} AS INTEGER),CAST({dd} AS INTEGER))'
    m=re.fullmatch(r'(?is)(YEAR|MONTH|DAY)\s*\((.*)\)',expr)
    if m:
        part=m.group(1).lower();value=_compile_simple(m.group(2),model,measure_resolver,filters,in_filter=in_filter)
        return f'CAST(EXTRACT({part} FROM CAST({value} AS DATE)) AS INTEGER)'

    m=re.fullmatch(r'(?is)DATEDIFF\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if len(args)!=3:raise DaxError('DATEDIFF requires start date, end date and interval.')
        unit=args[2].strip().upper()
        if unit not in {'DAY','WEEK','MONTH','QUARTER','YEAR'}:
            raise DaxError('DATEDIFF interval must be DAY, WEEK, MONTH, QUARTER, or YEAR.')
        start=_compile_simple(args[0],model,measure_resolver,filters,in_filter=in_filter)
        end=_compile_simple(args[1],model,measure_resolver,filters,in_filter=in_filter)
        return f"date_diff('{unit.lower()}',CAST({start} AS DATE),CAST({end} AS DATE))"

    m=re.fullmatch(r'(?is)(EDATE|EOMONTH)\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(2))
        if len(args)!=2:raise DaxError(f'{m.group(1).upper()} requires a date and month offset.')
        base=_compile_simple(args[0],model,measure_resolver,filters,in_filter=in_filter)
        try:months=int(args[1].strip())
        except ValueError:raise DaxError(f'{m.group(1).upper()} month offset must be an integer.')
        shifted=f"(CAST({base} AS DATE) + INTERVAL '{months} months')"
        return f'last_day({shifted})' if m.group(1).upper()=='EOMONTH' else shifted

    m=re.fullmatch(r'(?is)(STARTOFMONTH|ENDOFMONTH)\s*\((.*)\)',expr)
    if m:
        base=_compile_simple(m.group(2),model,measure_resolver,filters,in_filter=in_filter)
        if m.group(1).upper()=='STARTOFMONTH':return f"date_trunc('month',CAST({base} AS DATE))"
        return f'last_day(CAST({base} AS DATE))'

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

    m=re.fullmatch(r'(?is)(TOTALYTD|TOTALMTD|TOTALQTD)\s*\((.*)\)',expr)
    if m:
        sql,_=_compile_total_period(m.group(1).upper(),m.group(2),model,measure_resolver,filters or [])
        return sql

    # CALCULATE is an expression, not only a top-level measure form. Supporting it
    # here is essential for SWITCH/IF branches and variables that return filtered
    # measures (a very common Power BI pattern).
    m=re.fullmatch(r'(?is)CALCULATE\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if not args:raise DaxError('CALCULATE requires an expression.')
        base=_compile_simple(args[0],model,measure_resolver,filters)
        predicates=[]
        for item in args[1:]:
            pred,_=_compile_calculate_filter(item,model,{},filters or [],measure_resolver)
            if pred:predicates.append(pred)
        return _attach_filter(base,' AND '.join(f'({p})' for p in predicates))

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

def _condition(expr,model,measure_resolver=None,filters=None,in_filter=False):
    e=expr.strip()
    if _is_wrapped(e):return '('+_condition(e[1:-1],model,measure_resolver,filters,in_filter=in_filter)+')'
    for op,sqlop in (('||','OR'),('&&','AND')):
        parts=_split_logical(e,op)
        if parts:return '('+f' {sqlop} '.join(_condition(x,model,measure_resolver,filters,in_filter=in_filter) for x in parts)+')'
    m=re.fullmatch(r'(?is)(AND|OR)\s*\((.*)\)',e)
    if m:
        args=split_top(m.group(2))
        if len(args)<2:raise DaxError(f'{m.group(1).upper()} requires at least two conditions.')
        return '('+f' {m.group(1).upper()} '.join(_condition(x,model,measure_resolver,filters,in_filter=in_filter) for x in args)+')'
    m=re.fullmatch(r'(?is)NOT\s*\((.*)\)',e)
    if m:return f'(NOT ({_condition(m.group(1),model,measure_resolver,filters,in_filter=in_filter)}))'
    m=re.fullmatch(r'(?is)NOT\s+(.+)',e)
    if m:return f'(NOT ({_condition(m.group(1),model,measure_resolver,filters,in_filter=in_filter)}))'
    m=re.fullmatch(r'(?is)ISBLANK\s*\((.*)\)',e)
    if m:
        csql=_compile_simple(m.group(1),model,measure_resolver,filters,in_filter=in_filter)
        return f'({csql} IS NULL OR TRIM(CAST({csql} AS VARCHAR)) = \'\')'
    # DAX membership syntax: Table[Column] IN {"A", "B"}
    m=re.fullmatch(r'(?is)(.*?)\s+IN\s*\{(.*)\}',e)
    if m:
        left=m.group(1).strip();values=split_top(m.group(2));lf=parse_field(left)
        lsql=resolve_field(model,*lf) if lf else _compile_simple(left,model,measure_resolver,filters,in_filter=in_filter)
        if not values:raise DaxError('IN requires one or more values.')
        return f"{lsql} IN ("+','.join(_compile_simple(v,model,measure_resolver,filters,in_filter=in_filter) for v in values)+')'
    if re.fullmatch(r'(?i)TRUE\s*\(\s*\)|TRUE',e):return 'TRUE'
    if re.fullmatch(r'(?i)FALSE\s*\(\s*\)|FALSE',e):return 'FALSE'
    if re.match(r'(?is)^CONTAINSSTRING(?:EXACT)?\s*\(',e):return _compile_simple(e,model,measure_resolver,filters,in_filter=in_filter)
    return _comparison(e,model,measure_resolver,filters,in_filter=in_filter)

def _is_date_sql(s):
    s_low = str(s).lower()
    return 'current_date' in s_low or 'as date' in s_low or 'make_date' in s_low or 'date_trunc' in s_low or 'interval' in s_low

def _comparison(expr,model,measure_resolver=None,filters=None,in_filter=False):
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
                    lsql=resolve_field(model,*lf) if lf else _compile_simple(left,model,measure_resolver,filters,in_filter=in_filter)
                    rsql=_compile_simple(right,model,measure_resolver,filters,in_filter=in_filter)
                    if _is_date_sql(rsql) and not _is_date_sql(lsql):
                        lsql = f'TRY_CAST({lsql} AS DATE)'
                    elif _is_date_sql(lsql) and not _is_date_sql(rsql):
                        rsql = f'TRY_CAST({rsql} AS DATE)'
                    return f'{lsql} {op} {rsql}'
    raise DaxError(f'Unsupported condition: {expr}')

def _compile_calculate_filter(expr,model,vars_sql,filters,measure_resolver=None):
    e=expr.strip()
    def resolve_filter_value(name):
        try:return _mapping_value(vars_sql,name)
        except KeyError:pass
        if measure_resolver:return measure_resolver(name)
        raise DaxError(f"Unknown variable [{name}] in CALCULATE filter")
    m=re.fullmatch(r'(?is)(REMOVEFILTERS|ALL)\s*\(\s*([A-Za-z_][\w ]*)\s*\[\s*([^\]]+)\]\s*\)',e)
    if m:return None,{semantic_field(m.group(2),m.group(3))}
    
    m=re.fullmatch(r'(?is)(REMOVEFILTERS|ALL)\s*\(\s*(\'?.*?\'?)\s*\)',e)
    if m:
        t=m.group(2).strip("'")
        return None,{t+'.*'}
        
    m=re.fullmatch(r'(?is)FILTER\s*\(\s*(?:ALL\s*\(\s*(\'?.*?\'?)\s*\)|(\'?.*?\'?))\s*,\s*(.*)\)',e)
    if m:
        t = (m.group(1) or m.group(2)).strip("'")
        cond = m.group(3).strip()
        return _condition(cond,model,resolve_filter_value,filters,in_filter=True), {t+'.*'} if m.group(1) else set()
        
    m=re.fullmatch(r'(?is)KEEPFILTERS\s*\((.*)\)',e)
    if m:return _condition(m.group(1),model,resolve_filter_value,filters,in_filter=True),set()
    m=re.fullmatch(r'(?is)DATESBETWEEN\s*\((.*)\)',e)
    if m:
        args=split_top(m.group(1))
        if len(args)!=3:raise DaxError('DATESBETWEEN requires a date column, start date, and end date.')
        field_ref=parse_field(args[0])
        if not field_ref:raise DaxError('DATESBETWEEN first argument must be Table[DateColumn].')
        t,c=field_ref;field=resolve_field(model,t,c)
        start=_compile_simple(args[1],model,resolve_filter_value,filters,in_filter=True)
        end=_compile_simple(args[2],model,resolve_filter_value,filters,in_filter=True)
        predicate=f'(CAST({start} AS DATE) IS NULL OR CAST({field} AS DATE) >= CAST({start} AS DATE)) AND (CAST({end} AS DATE) IS NULL OR CAST({field} AS DATE) <= CAST({end} AS DATE))'
        return predicate,{semantic_field(t,c)}
    m=re.fullmatch(r'(?is)DATESINPERIOD\s*\((.*)\)',e)
    if m:
        args=split_top(m.group(1))
        if len(args)!=4:raise DaxError('DATESINPERIOD requires a date column, anchor date, interval count, and interval.')
        field_ref=parse_field(args[0])
        if not field_ref:raise DaxError('DATESINPERIOD first argument must be Table[DateColumn].')
        try:num=int(args[2].strip())
        except ValueError:raise DaxError('DATESINPERIOD interval count must be an integer.')
        unit=args[3].strip().upper()
        if unit not in {'DAY','MONTH','QUARTER','YEAR'}:raise DaxError('DATESINPERIOD interval must be DAY, MONTH, QUARTER, or YEAR.')
        t,c=field_ref;field=resolve_field(model,t,c);anchor=_compile_simple(args[1],model,resolve_filter_value,filters,in_filter=True)
        sql_unit='month' if unit=='QUARTER' else unit.lower();sql_num=num*3 if unit=='QUARTER' else num
        shifted=f"(CAST({anchor} AS DATE) + INTERVAL '{sql_num} {sql_unit}')"
        lower,upper=(shifted,f'CAST({anchor} AS DATE)') if num<=0 else (f'CAST({anchor} AS DATE)',shifted)
        return f'CAST({field} AS DATE) BETWEEN {lower} AND {upper}',{semantic_field(t,c)}
    m=re.fullmatch(r'(?is)SAMEPERIODLASTYEAR\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*\)',e)
    if m:
        t,c=m.groups(); t = t.strip().strip("'"); c = c.strip()
        mn,mx=_selected_bounds(model,t,c,filters)
        field=resolve_field(model,t,c)
        return f"TRY_CAST({field} AS DATE) BETWEEN (TRY_CAST({mn} AS DATE)-INTERVAL '1 year') AND (TRY_CAST({mx} AS DATE)-INTERVAL '1 year')",{semantic_field(t,c)}
    m=re.fullmatch(r'(?is)(PREVIOUSMONTH|PREVIOUSYEAR|PREVIOUSQUARTER)\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*\)',e)
    if m:
        kind,t,c=m.groups(); t = t.strip().strip("'"); c = c.strip(); kind = kind.upper()
        mx=_selected_aggregate(model,'MAX',t,c,filters)
        field=resolve_field(model,t,c)
        if kind=='PREVIOUSMONTH':
            start=f"date_trunc('month', CAST({mx} AS DATE) - INTERVAL '1 month')"
            end=f"last_day(CAST({mx} AS DATE) - INTERVAL '1 month')"
        elif kind=='PREVIOUSQUARTER':
            start=f"date_trunc('quarter', CAST({mx} AS DATE) - INTERVAL '3 month')"
            end=f"(date_trunc('quarter', CAST({mx} AS DATE)) - INTERVAL '1 day')"
        else:
            start=f"date_trunc('year', CAST({mx} AS DATE) - INTERVAL '1 year')"
            end=f"(date_trunc('year', CAST({mx} AS DATE)) - INTERVAL '1 day')"
        return f"TRY_CAST({field} AS DATE) BETWEEN CAST({start} AS DATE) AND CAST({end} AS DATE)",{semantic_field(t,c)}
    m=re.fullmatch(r'(?is)PARALLELPERIOD\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*,\s*(-?\d+)\s*,\s*(YEAR|QUARTER|MONTH)\s*\)',e)
    if m:
        t,c,num,unit=m.groups(); t = t.strip().strip("'"); c = c.strip(); num = int(num); unit = unit.lower()
        mx=_selected_aggregate(model,'MAX',t,c,filters)
        field=resolve_field(model,t,c)
        sql_unit = 'month' if unit=='quarter' else unit
        mult = 3 if unit=='quarter' else 1
        shift_start = num * mult
        shift_end = (num + 1) * mult
        start=f"date_trunc('{unit}', CAST({mx} AS DATE) + INTERVAL '{shift_start} {sql_unit}')"
        end=f"(date_trunc('{unit}', CAST({mx} AS DATE) + INTERVAL '{shift_end} {sql_unit}') - INTERVAL '1 day')"
        return f"TRY_CAST({field} AS DATE) BETWEEN CAST({start} AS DATE) AND CAST({end} AS DATE)",{semantic_field(t,c)}
    m=re.fullmatch(r'(?is)DATEADD\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*,\s*(-?\d+)\s*,\s*(YEAR|QUARTER|MONTH|DAY)\s*\)',e)
    if m:
        t,c,num,unit=m.groups(); t = t.strip().strip("'"); c = c.strip(); num = int(num); unit = unit.lower()
        mn,mx=_selected_bounds(model,t,c,filters)
        field=resolve_field(model,t,c)
        return f"TRY_CAST({field} AS DATE) BETWEEN (TRY_CAST({mn} AS DATE) + INTERVAL '{num} {unit}') AND (TRY_CAST({mx} AS DATE) + INTERVAL '{num} {unit}')",{semantic_field(t,c)}
    m=re.fullmatch(r'(?is)(DATESYTD|DATESQTD|DATESMTD)\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*\)',e)
    if m:
        kind,t,c=m.groups(); t = t.strip().strip("'"); c = c.strip(); kind = kind.upper()
        mx=_selected_aggregate(model,'MAX',t,c,filters)
        field=resolve_field(model,t,c)
        if kind=='DATESYTD':start=f"date_trunc('year',CAST({mx} AS DATE))"
        elif kind=='DATESQTD':start=f"date_trunc('quarter',CAST({mx} AS DATE))"
        else:start=f"date_trunc('month',CAST({mx} AS DATE))"
        return f"TRY_CAST({field} AS DATE) BETWEEN CAST({start} AS DATE) AND CAST({mx} AS DATE)",{semantic_field(t,c)}
    m=re.fullmatch(r"(?is)FILTER\s*\(\s*'?([A-Za-z_][\w ]*)'?\s*,\s*(.*)\)",e)
    if m:
        table=m.group(1).strip();condition=m.group(2).strip()
        table=resolve_table(model,table)
        return _condition(condition,model,resolve_filter_value,filters,in_filter=True),set()
    # Direct Table[Column] comparison / logical condition.
    return _condition(e,model,resolve_filter_value,filters,in_filter=True),set()

def _attach_filter(base_sql,predicate):
    if not predicate:return base_sql
    # DuckDB/Postgres-style aggregate FILTER works for every aggregate generated by
    # this engine. Apply it to every aggregate in a composite/CASE expression so
    # CALCULATE([Measure], ...) and CALCULATE inside SWITCH/IF preserve filter context.
    aggregate=re.compile(r'(?i)\b(SUM|AVG|MIN|MAX|COUNT|MEDIAN)\s*\(')
    spans=[]
    for match in aggregate.finditer(base_sql):
        open_pos=base_sql.find('(',match.start());depth=0;quote=None;close_pos=None
        for i in range(open_pos,len(base_sql)):
            ch=base_sql[i]
            if quote:
                if ch==quote:quote=None
                continue
            if ch in ("'",'"'):quote=ch;continue
            if ch=='(':depth+=1
            elif ch==')':
                depth-=1
                if depth==0:close_pos=i;break
        if close_pos is None:continue
        tail=base_sql[close_pos+1:]
        if re.match(r'(?is)^\s*FILTER\s*\(',tail):continue
        spans.append(close_pos+1)
    if not spans:
        # Constants and already-scalar expressions are unaffected by row filters.
        return base_sql
    out=base_sql
    for pos in reversed(spans):out=out[:pos]+f' FILTER (WHERE {predicate})'+out[pos:]
    return out

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
    text=strip_assignment(repair_dax_definition(expression)['expression']);filters=filters or []
    # Simple expression.
    if not re.search(r'(?i)\b(VAR|RETURN|CALCULATE|TOTALYTD|TOTALMTD|TOTALQTD)\b',text):
        return DaxCompilation(_compile_simple(text,model,measure_resolver,filters),set())

    # Time total functions without VAR.
    for kind in ('TOTALYTD','TOTALMTD','TOTALQTD'):
        m=re.fullmatch(rf'(?is){kind}\s*\((.*)\)',text)
        if m:
            parts=split_top(m.group(1))
            # A greedy regex can also see `TOTALYTD(...) + TOTALMTD(...)` as one
            # call. Only take this fast path for a genuine two-argument call;
            # composite expressions are handled recursively by _compile_simple.
            if len(parts)==2 and parse_field(parts[1]):
                sql,over=_compile_total_period(kind,m.group(1),model,measure_resolver,filters)
                return DaxCompilation(sql,over)

    vars_sql={}
    ret=text
    if re.search(r'(?i)\bVAR\b',text):
        variables,ret=_parse_vars(text)
        for name,expr in variables.items():vars_sql[name]=_compile_var_value(expr,model,vars_sql,filters,measure_resolver)

    m=re.fullmatch(r'(?is)CALCULATE\s*\((.*)\)',ret.strip())
    
    def var_aware_resolver(name):
        try:return _mapping_value(vars_sql,name)
        except KeyError:pass
        if measure_resolver:return measure_resolver(name)
        raise DaxError(f"Unknown measure or variable [{name}]")

    if not m:
        # RETURN can be a complex expression (IF, MIN, DIVIDE, etc.)
        return DaxCompilation(_compile_simple(ret.strip(),model,var_aware_resolver,filters),set())
        
    args=split_top(m.group(1))
    if not args:raise DaxError('CALCULATE requires an expression.')
    base=_compile_simple(args[0],model,var_aware_resolver,filters)
    predicates=[];override=set()
    for item in args[1:]:
        pred,over=_compile_calculate_filter(item,model,vars_sql,filters,var_aware_resolver)
        if pred:predicates.append(pred)
        override.update(over)
    return DaxCompilation(_attach_filter(base,' AND '.join(f'({p})' for p in predicates)),override)

@lru_cache(maxsize=1)
def dax_engine_health():
    """Run a deterministic compiler smoke suite without project data or network."""
    model={
        'tables':{'Health':{'physical':'__dax_health','columns':{
            'Amount':'Amount','Quantity':'Quantity','Status':'Status','EventDate':'EventDate','Id':'Id'}}},
        'relationships':[],'columnTypes':{'Health.EventDate':'date'},
        'measures':{
            'Base Amount':'Base Amount = SUM ( Health[Amount] )',
            'Row Count':'Row Count = COUNTROWS ( Health )',
        },
    }
    def resolver(name):
        if name not in model['measures']:raise DaxError(f'Unknown health-check measure [{name}]')
        return compile_dax(model['measures'][name],model,measure_resolver=resolver).sql
    cases={
        'aggregates':'Health Aggregates = SUM(Health[Amount]) + AVERAGE(Health[Amount]) + MIN(Health[Amount]) + MAX(Health[Amount]) + COUNT(Health[Id]) + DISTINCTCOUNT(Health[Id]) + MEDIAN(Health[Amount])',
        'iterators':'Health Iterators = SUMX(Health,Health[Amount]) + AVERAGEX(Health,Health[Amount]) + MINX(Health,Health[Amount]) + MAXX(Health,Health[Amount])',
        'countrows':'Health Rows = COUNTROWS(Health)',
        'calculate-filter-all':'Health Filter = CALCULATE([Base Amount],FILTER(ALL(Health),LOWER(TRIM(Health[Status])) = "open"))',
        'filter-controls':'Health Controls = CALCULATE([Base Amount],KEEPFILTERS(Health[Status] = "open"),REMOVEFILTERS(Health[Status]))',
        'divide-selected':'Health Divide = DIVIDE([Base Amount],SELECTEDVALUE(Health[Quantity],1),0)',
        'null-logical':'Health Logic = IF(AND(NOT(ISBLANK([Base Amount])),OR(TRUE(),FALSE())),COALESCE([Base Amount],BLANK()),0)',
        'switch':'Health Switch = SWITCH(TRUE(),[Base Amount] > 0,1,0)',
        'numeric':'Health Numeric = ABS(-2) + ROUND(2.45,1) + INT(2.8) + FLOOR(2.8) + CEILING(2.1) + POWER(2,3) + SQRT(9)',
        'text-case-trim':'Health Text = CONCATENATE(UPPER(TRIM(Health[Status])),LOWER(Health[Status]))',
        'text-slices':'Health Slices = CONCATENATE(LEFT(Health[Status],2),RIGHT(MID(Health[Status],2,4),2))',
        'text-replace-value':'Health Replace = VALUE(SUBSTITUTE("1,200",",",""))',
        'text-search':'Health Search = IF(CONTAINSSTRING(Health[Status],"pen") && CONTAINSSTRINGEXACT(Health[Status],"Open"),LEN(Health[Status]),0)',
        'date-parts':'Health Date = DATE(YEAR(Health[EventDate]),MONTH(Health[EventDate]),DAY(Health[EventDate]))',
        'date-diff':'Health Date Diff = DATEDIFF(STARTOFMONTH(Health[EventDate]),ENDOFMONTH(Health[EventDate]),DAY)',
        'date-shifts':'Health Shift = EDATE(Health[EventDate],-1) + EOMONTH(Health[EventDate],0)',
        'clock':'Health Clock = IF(NOW() > TODAY(),1,0)',
        'dateadd':'Health DateAdd = CALCULATE([Base Amount],DATEADD(Health[EventDate],-1,YEAR))',
        'datesbetween':'Health Between = CALCULATE([Base Amount],DATESBETWEEN(Health[EventDate],DATE(2025,1,1),DATE(2025,12,31)))',
        'datesinperiod':'Health Period = CALCULATE([Base Amount],DATESINPERIOD(Health[EventDate],TODAY(),-3,MONTH))',
        'date-tables':'Health Date Tables = CALCULATE([Base Amount],DATESYTD(Health[EventDate]),DATESMTD(Health[EventDate]),DATESQTD(Health[EventDate]))',
        'prior-year':'Health Prior = CALCULATE([Base Amount],SAMEPERIODLASTYEAR(Health[EventDate]))',
        'totals':'Health Totals = TOTALYTD([Base Amount],Health[EventDate]) + TOTALMTD([Base Amount],Health[EventDate]) + TOTALQTD([Base Amount],Health[EventDate])',
        'variables':'Health Variables = VAR Current = [Base Amount] RETURN Current',
        'concat-operator':'Health Ampersand = LEFT(Health[Status],1) & RIGHT(Health[Status],1)',
        'virtual-topn':'''Health Top Status =
VAR StatusSummary =
    TOPN ( 1, FILTER ( ADDCOLUMNS ( ALL ( Health[Status] ), "ItemCount", [Row Count] ), NOT ISBLANK ( Health[Status] ) && TRIM ( Health[Status] ) <> "" ), [ItemCount], DESC, Health[Status], ASC )
RETURN
    CONCATENATEX ( StatusSummary, Health[Status], ", " )''',
        'virtual-summarize':'''Health Summary =
VAR SummaryTable = SUMMARIZE ( Health, Health[Status], "ItemCount", COUNTROWS ( Health ) )
RETURN MAXX ( SummaryTable, [ItemCount] )''',
        'values-context-transition':'''Health Most Frequent =
VAR StatusTable = FILTER ( VALUES ( Health[Status] ), NOT ISBLANK ( Health[Status] ) && Health[Status] <> "" )
VAR TopStatus = TOPN ( 1, StatusTable, CALCULATE ( [Row Count] ), DESC, Health[Status], ASC )
RETURN CONCATENATEX ( TopStatus, Health[Status], ", " )''',
    }
    failures=[];covered={'VAR','RETURN'}
    for case,expression in cases.items():
        covered.update(name for _,_,name in _function_calls(expression))
        try:compile_dax(expression,model,measure_resolver=resolver)
        except Exception as exc:failures.append({'case':case,'error':str(exc)})
    uncovered=sorted(SUPPORTED_DAX_FUNCTIONS-covered)
    if uncovered:failures.append({'case':'capability-registry','error':'No self-test coverage for: '+', '.join(uncovered)})
    return {'healthy':not failures,'engine':'VTAB DAX','engineVersion':DAX_ENGINE_VERSION,
            'checks':len(cases),'supportedFunctionCount':len(SUPPORTED_DAX_FUNCTIONS),
            'supportedFunctions':sorted(SUPPORTED_DAX_FUNCTIONS),'failures':failures}

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


def suggest_measure_from_prompt(prompt,model,validation_feedback=None):
    """Generate DAX grounded to the active semantic model and this engine's supported subset."""
    try:
        # Import only for the explicit AI path. Manual parsing, validation, saving,
        # and querying remain completely independent of Gemini configuration/network.
        from .gemini import generate_json
        entries=_field_entries(model)
        fields='; '.join(f"{x['table']}[{x['column']}] ({x['dtype'] or 'unknown type'})" for x in entries)
        relationships='; '.join(
            f"{r.get('fromTable')}[{r.get('fromColumn')}] -> {r.get('toTable')}[{r.get('toColumn')}]"
            for r in model.get('relationships',[]) if r.get('active',True)
        ) or 'none'
        measures='; '.join(f"[{name}] = {expression}" for name,expression in model.get('measures',{}).items()) or 'none'
        retry_note=f"\nThe previous expression failed VTAB validation with: {validation_feedback}. Correct that failure." if validation_feedback else ''
        result=generate_json(prompt+retry_note,(
            'You create one valid DAX measure definition for VTAB Reporting Studio. '
            'Use only the supplied active model; never invent a table, column, or measure. '
            'Available semantic fields: '+fields+'. Active relationships: '+relationships+'. Existing measures: '+measures+'. '
            'Supported scalar, aggregate, and table functions include VAR, RETURN, CALCULATE, FILTER, ALL, ADDCOLUMNS, SUMMARIZE, TOPN, CONCATENATEX, SUM, AVERAGE, MIN, MAX, COUNT, COUNTROWS, DISTINCTCOUNT, MEDIAN, SUMX, AVERAGEX, MINX, MAXX, DIVIDE, SELECTEDVALUE, COALESCE, ABS, ROUND, INT, FLOOR, CEILING, LEN, LOWER, UPPER, TRIM, LEFT, RIGHT, MID, CONCATENATE, SUBSTITUTE, VALUE, CONTAINSSTRING, CONTAINSSTRINGEXACT, IF, SWITCH, ISBLANK, BLANK, TODAY, NOW, DATE, YEAR, MONTH, DAY, EDATE, EOMONTH, STARTOFMONTH, ENDOFMONTH, DATEADD, DATESBETWEEN, DATESINPERIOD, DATESYTD, DATESMTD, DATESQTD, SAMEPERIODLASTYEAR, TOTALYTD, TOTALMTD, TOTALQTD, REMOVEFILTERS, KEEPFILTERS, IN, POWER, and SQRT. '
            'Use exact Table[Column] references. Prefer straightforward expressions supported by this list. Return JSON only: '
            '{"name":"short_measure_name","expression":"MeasureName =\\nDAX expression","explanation":"brief explanation"}.'
        ))
        name=str(result.get('name','')).strip();expression=str(result.get('expression','')).strip()
        if not name or not expression: raise DaxError('AI response was missing name or expression.')
        referenced=[]
        for table,definition in model.get('tables',{}).items():
            pattern=re.compile(r"'?"+re.escape(table)+r"'?\s*\[\s*([^\]]+)\s*\]",re.I)
            for match in pattern.finditer(expression):
                requested=match.group(1).strip()
                actual=next((column for column in definition.get('columns',{}) if column.lower()==requested.lower()),None)
                if actual is None:raise DaxError(f"Unknown column '{table}[{requested}]'")
                referenced.append(f'{table}[{actual}]')
        return {'name':re.sub(r'\s+','_',name)[:128],'expression':expression,'explanation':str(result.get('explanation','Generated by Gemini AI.')),'warnings':[],'confidence':0.95,'intent':'ai_generation','semanticChecks':{'modelGrounded':True,'referencedFields':referenced},'grounding':{'valueField':referenced[0] if referenced else None,'dateField':next((field for field in referenced if 'date' in field.lower()),None),'filterFields':referenced[1:]}}
    except Exception as ai_error:
        if not validation_feedback:
            try:
                fallback=_deterministic_suggest_measure(prompt,model)
                fallback.setdefault('warnings',[]).append(f'AI generation was unavailable; the model-grounded generator was used. Details: {ai_error}')
                return fallback
            except Exception:
                pass
        raise DaxError(f"AI generation failed: {ai_error}")
