from __future__ import annotations
import re
from dataclasses import dataclass
from functools import lru_cache
from .dax_registry import (
    DAX_FUNCTION_REGISTRY,
    canonical_function_name,
    executable_function_names,
    function_registry_payload,
    known_function_names,
)

class DaxError(ValueError): pass

# One authoritative public capability registry. API health checks, diagnostics,
# AI prompting, and the editor all derive from this list so they cannot drift.
DAX_ENGINE_VERSION='6.1.4-duckdb-storage-adapter-1'
SUPPORTED_DAX_FUNCTIONS=executable_function_names()

# Known Power BI functions must never be treated as spelling mistakes merely
# because this engine does not support them yet. They receive an honest
# compatibility diagnostic instead of an unsafe automatic substitution.
KNOWN_DAX_FUNCTIONS=known_function_names()

def _function_calls(text:str):
    """Return (start, end, uppercase_name) calls, excluding quoted content."""
    calls=[];i=0;quote=None;bracket_depth=0
    while i<len(text):
        ch=text[i]
        if quote:
            if ch==quote and (i==0 or text[i-1]!='\\'):quote=None
            i+=1;continue
        if ch in ("'",'"'):quote=ch;i+=1;continue
        # Bracketed content is a field or measure identifier. Parentheses in a
        # column name such as [VALUE OF AMT. ISSUED (J$)] are not function calls.
        if ch=='[':bracket_depth+=1;i+=1;continue
        if ch==']' and bracket_depth:
            if i+1<len(text) and text[i+1]==']':i+=2;continue
            bracket_depth-=1;i+=1;continue
        if bracket_depth:i+=1;continue
        if ch.isalpha() or ch=='_':
            start=i;i+=1
            while i<len(text) and (text[i].isalnum() or text[i]=='_'):i+=1
            end=i
            while i<len(text) and text[i].isspace():i+=1
            if i<len(text) and text[i]=='(':calls.append((start,end,text[start:end].upper()))
            continue
        i+=1
    return calls

def _function_invocations(text:str):
    """Yield balanced function calls as ``(name, argument_text)``.

    This is a structural scanner rather than a regex parser.  It understands
    nested parentheses and quoted table/string content, which is sufficient for
    signature validation before the existing SQL compiler builds its AST-like
    table/scalar objects.
    """
    invocations=[]
    for start,end,raw_name in _function_calls(text):
        open_pos=end
        while open_pos<len(text) and text[open_pos].isspace():open_pos+=1
        if open_pos>=len(text) or text[open_pos]!='(':continue
        depth=0;quote=None;close_pos=None;index=open_pos
        while index<len(text):
            char=text[index]
            if quote:
                if char==quote:
                    # DAX escapes a quote by doubling it.
                    if index+1<len(text) and text[index+1]==quote:index+=2;continue
                    quote=None
                index+=1;continue
            if char in ("'",'"'):quote=char
            elif char=='(':depth+=1
            elif char==')':
                depth-=1
                if depth==0:close_pos=index;break
            index+=1
        if close_pos is not None:
            invocations.append((canonical_function_name(raw_name),text[open_pos+1:close_pos]))
    return invocations

def _validate_function_signatures(text:str,mode:str='measure'):
    errors=[]
    for name,argument_text in _function_invocations(text):
        spec=DAX_FUNCTION_REGISTRY.get(name)
        if spec is None:
            continue
        if spec.status=='unsupported':
            if name in {'EARLIER','EARLIEST'} and mode=='measure':
                errors.append(
                    f'{name} requires calculated-column row context, which this measure editor does not create. '
                    'Create the derived column in Transform Data, or rewrite the logic with FILTER/ADDCOLUMNS and an iterator.'
                )
            else:
                errors.append(f'Unsupported DAX function {name}. {spec.notes}'.strip())
            continue
        args=split_top(argument_text,keep_empty=True)
        # Empty text means a genuine zero-argument invocation. Interior empty
        # arguments are retained for legal forms such as RANKX(..., , DESC).
        count=0 if not argument_text.strip() else len(args)
        if count<spec.min_args or (spec.max_args is not None and count>spec.max_args):
            expected=(str(spec.min_args) if spec.max_args==spec.min_args else
                      f'{spec.min_args} to {spec.max_args}' if spec.max_args is not None else
                      f'at least {spec.min_args}')
            errors.append(f'{name} expects {expected} argument(s); received {count}.')
    return errors

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

def split_top(s:str,keep_empty:bool=False):
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
    return out if keep_empty else [x for x in out if x]

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

def diagnose_dax_definition(expression:str,mode:str='measure'):
    repair=repair_dax_definition(expression);text=repair['expression'];issues=_structure_issues(text)
    definition=parse_measure_definition(text)
    if not definition:
        issues.append('Start the formula with a measure name followed by =.')
    body=strip_assignment(text)
    calls={canonical_function_name(name) for _,_,name in _function_calls(body)}
    unsupported=sorted(name for name in calls if name in KNOWN_DAX_FUNCTIONS and name not in SUPPORTED_DAX_FUNCTIONS)
    unknown=sorted(name for name in calls if name not in KNOWN_DAX_FUNCTIONS)
    suggestions={}
    for name in unknown:
        ranked=sorted(SUPPORTED_DAX_FUNCTIONS,key=lambda candidate:(_edit_distance(name,candidate),candidate))
        suggestions[name]=ranked[:3]
        issues.append(f'Unknown DAX function {name}.'+(f' Did you mean {", ".join(ranked[:3])}?' if ranked else ''))
    issues.extend(_validate_function_signatures(body,mode))
    if mode=='measure' and parse_field(body):
        table,column=parse_field(body)
        issues.append(
            f"'{table}'[{column}] is a column and cannot be returned directly by a measure. "
            'Wrap it in an aggregation such as SUM/MIN/MAX, use SELECTEDVALUE, or create a calculated column in Transform Data.'
        )
    return {**repair,'issues':list(dict.fromkeys(issues)),
            'unknownFunctions':unknown,'unsupportedFunctions':unsupported,
            'suggestions':suggestions,'functionRegistry':function_registry_payload(),
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
    row_predicates:tuple[str,...]=()

def _virtual_column(table:DaxTable,name:str):
    lowered=name.strip().lower()
    for key,value in table.columns.items():
        if key.lower()==lowered or value.lower()==lowered:return value
    return None

def _virtual_scalar(expr,table:DaxTable,model,measure_resolver=None,filters=None,as_condition=False):
    if as_condition:
        for operator,sql_operator in (('||','OR'),('&&','AND')):
            parts=_split_logical(expr,operator)
            if parts:
                return '('+f' {sql_operator} '.join(
                    _virtual_scalar(part,table,model,measure_resolver,filters,True) for part in parts
                )+')'
        depth=0;quote=None;index=0
        while index<len(expr):
            char=expr[index]
            if quote:
                if char==quote and (index==0 or expr[index-1]!='\\'):quote=None
                index+=1;continue
            if char in ("'",'"'):quote=char;index+=1;continue
            if char=='(':depth+=1;index+=1;continue
            if char==')':depth-=1;index+=1;continue
            if depth==0:
                for operator in ('>=','<=','<>','>','<','='):
                    if expr.startswith(operator,index):
                        left=expr[:index].strip();right=expr[index+len(operator):].strip()
                        return (f'{_virtual_scalar(left,table,model,measure_resolver,filters)} {operator} '
                                f'{_virtual_scalar(right,table,model,measure_resolver,filters)}')
            index+=1
    datediff=re.fullmatch(r'(?is)DATEDIFF\s*\((.*)\)',expr.strip())
    if datediff:
        args=split_top(datediff.group(1))
        if len(args)!=3:raise DaxError('DATEDIFF requires start date, end date and interval.')
        unit=args[2].strip().upper()
        if unit not in {'SECOND','MINUTE','HOUR','DAY','WEEK','MONTH','QUARTER','YEAR'}:
            raise DaxError('DATEDIFF interval must be SECOND, MINUTE, HOUR, DAY, WEEK, MONTH, QUARTER, or YEAR.')
        start=_virtual_scalar(args[0],table,model,measure_resolver,filters)
        end=_virtual_scalar(args[1],table,model,measure_resolver,filters)
        return f"date_diff('{unit.lower()}',CAST({start} AS TIMESTAMP),CAST({end} AS TIMESTAMP))"
    context_transition=re.fullmatch(r'(?is)CALCULATE\s*\((.*)\)',expr.strip())
    if context_transition and table.source_table:
        args=split_top(context_transition.group(1))
        source=table.source_table;physical=model['tables'][source]['physical']
        removes_source=any(
            re.fullmatch(rf"(?is)REMOVEFILTERS\s*\(\s*'?{re.escape(source)}'?\s*\)",item.strip())
            for item in args[1:]
        )
        if removes_source:
            base=_compile_simple(args[0],model,measure_resolver,[])
            predicates=[]
            for item in args[1:]:
                predicate,_=_compile_calculate_filter(item,model,{},[],measure_resolver)
                if predicate:predicates.append(predicate)
            sql=f'(SELECT {base} FROM {qi(physical)} {qi(source)}'
            if predicates:sql+=' WHERE '+' AND '.join(f'({item})' for item in predicates)
            return sql+')'
        if len(args)==1 and table.group_columns:
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

def _render_group_table(source_table,group_columns,computed,model,filters,measure_resolver,remove_group_filters=False,extra_predicates=()):
    source_table=resolve_table(model,source_table);physical=model['tables'][source_table]['physical'];alias=source_table
    group_sql=[];select_sql=[];columns={};calculated_scalars={}
    grouped_names={re.sub(r'[^a-z0-9]','',str(column).casefold()) for column in group_columns}
    for column in group_columns:
        field=resolve_field(model,source_table,column,alias);actual=parse_field(f'{source_table}[{column}]')[1]
        select_sql.append(f'{field} AS {qi(actual)}');group_sql.append(field);columns[actual]=actual
    for name,expression in computed:
        # SUMMARIZE extension columns are evaluated in group context. Measures
        # produced by the AI commonly define aggregate aliases first, for example
        # "AdmissionDate", MIN(Table[Admission Date]), and then use the original
        # field spelling inside DATEDIFF. Compiling that last expression as a raw
        # column leaks it into a grouped SQL SELECT and DuckDB raises the large
        # "must appear in GROUP BY" API error.
        #
        # Resolve a raw field to an earlier calculated scalar when their names
        # match after removing spaces/punctuation. Otherwise use SELECTEDVALUE-
        # style scalarization: a single distinct value is returned, while an
        # ambiguous group becomes BLANK/NULL.
        placeholders={}
        def grouped_field(match):
            requested_table=match.group(1).strip();column=match.group(2).strip()
            try:actual_table=resolve_table(model,requested_table,column)
            except DaxError:return match.group(0)
            key=re.sub(r'[^a-z0-9]','',column.casefold())
            if actual_table!=source_table or key in grouped_names:return match.group(0)
            scalar=calculated_scalars.get(key)
            if scalar is None:
                field=resolve_field(model,source_table,column,alias)
                scalar=f'(CASE WHEN COUNT(DISTINCT {field}) = 1 THEN ANY_VALUE({field}) ELSE NULL END)'
            placeholder=f'__vtab_group_scalar_{len(placeholders)}'
            placeholders[placeholder]=scalar
            return placeholder
        contains_aggregate=re.search(
            r"(?is)\b(?:SUM|AVERAGE|AVG|MIN|MAX|COUNT|DISTINCTCOUNT|MEDIAN)\s*\(",
            expression,
        )
        rewritten=(expression if contains_aggregate else re.sub(
            r"(?is)'?([A-Za-z_][\w ]*)'?\s*\[\s*([^\]]+)\s*\]",
            grouped_field,
            expression,
        ))
        def grouped_resolver(reference):
            if reference in placeholders:return placeholders[reference]
            # Bracket-only references inside a later SUMMARIZE/ADDCOLUMNS
            # expression can target an extension column defined earlier in the
            # same virtual row (for example [AdmissionDate] in DATEDIFF). They
            # are row-scoped virtual columns, not persisted measures.
            calculated=calculated_scalars.get(re.sub(r'[^a-z0-9]','',str(reference).casefold()))
            if calculated is not None:return calculated
            if measure_resolver:return measure_resolver(reference)
            raise DaxError(f"Unknown measure or grouped scalar [{reference}]")
        value=_compile_simple(rewritten,model,grouped_resolver,filters)
        select_sql.append(f'{value} AS {qi(name)}');columns[name]=name
        calculated_scalars[re.sub(r'[^a-z0-9]','',str(name).casefold())]=value
    active_filters=filters or []
    if remove_group_filters:
        removed={semantic_field(source_table,column).lower() for column in group_columns}
        active_filters=[item for item in active_filters if str(item.get('field','')).split('::',1)[0].lower() not in removed]
    predicates=[]
    context_predicate=_context_predicate(model,source_table,active_filters,alias)
    if context_predicate:predicates.append(context_predicate)
    predicates.extend(item for item in extra_predicates if item)
    sql=f'SELECT {", ".join(select_sql)} FROM {qi(physical)} {qi(alias)}'
    if predicates:sql+=' WHERE '+' AND '.join(f'({item})' for item in predicates)
    if group_sql:sql+=' GROUP BY '+', '.join(group_sql)
    return DaxTable(sql,source_table,columns,source_table,tuple(group_columns),tuple(computed),remove_group_filters,tuple(extra_predicates))

def _compile_table_expr(expr,model,vars_sql,filters,measure_resolver=None):
    e=expr.strip()
    try:
        existing=_mapping_value(vars_sql,e)
        if isinstance(existing,DaxTable):return existing
    except KeyError:pass

    # A physical model table is a valid DAX table expression.  Keep every row
    # and expose its columns to FILTER/ADDCOLUMNS/iterator row context.
    bare=re.fullmatch(r"(?is)'?([A-Za-z_][\w ]*)'?",e)
    if bare:
        try:table=resolve_table(model,bare.group(1).strip())
        except DaxError:table=None
        if table:
            physical=model['tables'][table]['physical'];columns=model['tables'][table].get('columns',{})
            selections=[f'{qi(table)}.{qi(actual)} AS {qi(name)}' for name,actual in columns.items()]
            sql=f'SELECT {", ".join(selections)} FROM {qi(physical)} {qi(table)}'
            context=_context_predicate(model,table,filters or [],table)
            if context:sql+=' WHERE '+context
            return DaxTable(sql,table,{name:name for name in columns},table,(),(),False)

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
        computed=list(base.computed);new_computed=[]
        for index in range(1,len(args),2):
            name=args[index].strip()
            if not (name.startswith('"') and name.endswith('"')):raise DaxError('ADDCOLUMNS column name must be quoted.')
            pair=(name[1:-1],args[index+1]);computed.append(pair);new_computed.append(pair)
        if not base.group_columns:
            select_parts=['__row.*'];columns=dict(base.columns)
            working=base
            for name,expression in new_computed:
                value=_virtual_scalar(expression,working,model,measure_resolver,filters)
                select_parts.append(f'{value} AS {qi(name)}');columns[name]=name
                working=DaxTable(base.sql,base.table,columns,base.source_table,(),tuple(computed),base.remove_group_filters,base.row_predicates)
            return DaxTable(f'SELECT {", ".join(select_parts)} FROM ({base.sql}) {qi("__row")}',base.table,columns,base.source_table,(),tuple(computed),base.remove_group_filters,base.row_predicates)
        return _render_group_table(base.source_table,list(base.group_columns),computed,model,filters,measure_resolver,base.remove_group_filters)

    match=re.fullmatch(r'(?is)CALCULATETABLE\s*\((.*)\)',e)
    if match:
        args=split_top(match.group(1))
        if not args:raise DaxError('CALCULATETABLE requires a table expression.')
        base=_compile_table_expr(args[0],model,vars_sql,filters,measure_resolver)
        if base is None:raise DaxError('CALCULATETABLE requires a supported table expression.')
        def resolve_filter_value(name):
            try:return _mapping_value(vars_sql,name)
            except KeyError:pass
            if measure_resolver:return measure_resolver(name)
            raise DaxError(f"Unknown variable [{name}] in CALCULATETABLE filter")
        predicates=[];overrides=set()
        for item in args[1:]:
            predicate,removed=_compile_calculate_filter(item,model,vars_sql,filters,resolve_filter_value)
            if predicate:predicates.append(predicate)
            overrides.update(removed)
        active_filters=[]
        for item in filters or []:
            field=str(item.get('field','')).split('::',1)[0]
            table=field.split('.',1)[0] if '.' in field else ''
            if field.lower() in {x.lower() for x in overrides}:continue
            if (table+'.*').lower() in {x.lower() for x in overrides}:continue
            active_filters.append(item)
        if base.source_table:
            return _render_group_table(base.source_table,list(base.group_columns),list(base.computed),model,active_filters,measure_resolver,base.remove_group_filters,predicates)
        if predicates:
            raise DaxError('CALCULATETABLE filters require a table expression with source lineage.')
        return base

    match=re.fullmatch(r'(?is)FILTER\s*\((.*)\)',e)
    if match:
        args=split_top(match.group(1))
        if len(args)!=2:return None
        base=_compile_table_expr(args[0],model,vars_sql,filters,measure_resolver)
        if base is None:return None
        predicate=_virtual_scalar(args[1],base,model,measure_resolver,filters,True)
        return DaxTable(f'SELECT * FROM ({base.sql}) {qi("__row")} WHERE {predicate}',base.table,base.columns,base.source_table,base.group_columns,base.computed,base.remove_group_filters,base.row_predicates)

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
        # Power BI TOPN includes every row tied at the Nth boundary.  SQL RANK
        # (with gaps after ties) models row-position boundaries: for 250,250,200
        # and N=2 the ranks are 1,1,3, so only the tied first two rows qualify.
        order_sql=', '.join(order)
        sql=(f'SELECT * EXCLUDE ({qi("__topn_rank")}) FROM ('
             f'SELECT *, RANK() OVER (ORDER BY {order_sql}) AS {qi("__topn_rank")} '
             f'FROM ({base.sql}) {qi("__row")}) {qi("__topn")} '
             f'WHERE {qi("__topn_rank")} <= {limit}')
        return DaxTable(sql,base.table,base.columns,base.source_table,base.group_columns,base.computed,base.remove_group_filters,base.row_predicates)
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
        # CALCULATE without filter arguments is evaluated in the visual's current
        # filter/group context.  Returning the aggregate directly is important:
        # wrapping MIN/MAX in an uncorrelated scalar subquery made cards appear to
        # work in isolation but lost chart grouping, while older builds could emit
        # the underlying date columns beside an aggregate and trigger DuckDB's
        # "must appear in GROUP BY" binder error.
        if len(args)==1:
            return base
        predicates=[];overrides=set()
        for item in args[1:]:
            pred,over=_compile_calculate_filter(item,model,vars_sql,filters,var_aware_resolver)
            if pred:predicates.append(pred)
            overrides.update(over)
        references=re.findall(r"(?is)'?([A-Za-z_][\w ]*)'?\s*\[\s*([^\]]+)\s*\]",args[0])
        if references:
            source=resolve_table(model,references[0][0],references[0][1]);physical=model['tables'][source]['physical']
            removed={item.lower() for item in overrides}
            active=[]
            for item in filters or []:
                field=str(item.get('field','')).split('::',1)[0]
                table_name=field.split('.',1)[0] if '.' in field else ''
                if field.lower() in removed or (table_name+'.*').lower() in removed:continue
                active.append(item)
            context=_context_predicate(model,source,active,source)
            combined=([context] if context else [])+predicates
            sql=f'(SELECT {base} FROM {qi(physical)} {qi(source)}'
            if combined:sql+=' WHERE '+' AND '.join(f'({item})' for item in combined)
            return sql+')'
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

def _dax_format_sql(value_sql:str,format_expression:str,locale_expression:str|None=None):
    """Compile the supported Power BI FORMAT subset to deterministic DuckDB SQL."""
    literal=format_expression.strip()
    if not (len(literal)>=2 and literal[0]=='"' and literal[-1]=='"'):
        raise DaxError('FORMAT currently requires a literal format string, for example "#,##0.00".')
    mask=literal[1:-1].replace('""','"')
    if locale_expression:
        locale=locale_expression.strip().strip('"').lower()
        if locale not in {'','en-us','en-gb','en-in','invariant'}:
            raise DaxError(
                f'FORMAT locale {locale_expression} is not available. Use en-US, en-GB, en-IN, or omit the locale.'
            )
    upper=mask.upper()
    named={
        'GENERAL NUMBER':'{}','FIXED':'{:.2f}','STANDARD':'{:,.2f}',
        'PERCENT':'{:.2%}','SCIENTIFIC':'{:.2E}',
    }
    if upper in named:
        rendered=f'format({sql_literal(named[upper])}, CAST({value_sql} AS DOUBLE))'
        return f"CASE WHEN ({value_sql}) IS NULL THEN '' ELSE {rendered} END"
    # Common DAX date/time masks.  Month uses uppercase M; minute uses lowercase m.
    if re.search(r'[dDyY]',mask) and not re.search(r'[0#]',mask):
        replacements={
            'yyyy':'%Y','yyy':'%Y','yy':'%y','MMMM':'%B','MMM':'%b','MM':'%m',
            'dd':'%d','d':'%-d','HH':'%H','hh':'%I','mm':'%M','ss':'%S',
        }
        # Translate tokens in one pass. Sequential replacements corrupt the
        # generated percent directives (for example `%d` becoming `%%-d`).
        token_pattern='|'.join(sorted(map(re.escape,replacements),key=len,reverse=True))
        strftime_mask=re.sub(token_pattern,lambda match:replacements[match.group(0)],mask)
        rendered=f'strftime(CAST({value_sql} AS TIMESTAMP), {sql_literal(strftime_mask)})'
        return f"CASE WHEN ({value_sql}) IS NULL THEN '' ELSE {rendered} END"
    section=mask.split(';',1)[0]
    percent='%' in section
    numeric_mask=section.replace('%','')
    decimal_part=numeric_mask.split('.',1)[1] if '.' in numeric_mask else ''
    decimals=sum(1 for char in decimal_part if char in '0#')
    grouping=',' in numeric_mask.split('.',1)[0]
    python_mask='{:'+(',' if grouping else '')+'.'+str(decimals)+'f}'
    numeric=f'(CAST({value_sql} AS DOUBLE)'+('* 100' if percent else '')+')'
    rendered=f'format({sql_literal(python_mask)}, {numeric})'
    if percent:rendered=f'({rendered} || \'%\')'
    return f"CASE WHEN ({value_sql}) IS NULL THEN '' ELSE {rendered} END"

def _compile_simple(expr,model,measure_resolver=None,filters=None,in_filter=False):
    expr=expr.strip()
    if _is_wrapped(expr):
        return '(' + _compile_simple(expr[1:-1],model,measure_resolver,filters,in_filter=in_filter) + ')'
    if re.fullmatch(r'-?\d+(?:\.\d+)?',expr):return expr
    # Unary minus may wrap any scalar expression, not only a numeric literal.
    # Reconstructed rounding formulas use -CEILING(ABS(...), significance)
    # to preserve Power BI's away-from-zero behavior for negative values.
    if expr.startswith('-'):
        operand=expr[1:].strip()
        if not operand:raise DaxError('Unary minus requires an expression.')
        return f'(-({_compile_simple(operand,model,measure_resolver,filters,in_filter=in_filter)}))'
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
        # A physical table owns the outer FROM selected by semantic_engine.
        # Keeping COUNTROWS as COUNT(*) preserves visual/filter context and
        # lets CALCULATE attach its predicate to that aggregate.
        direct_table=target.strip("'")
        resolved_table=next((name for name in model.get('tables',{}) if name.lower()==direct_table.lower()),None)
        if resolved_table is not None:return 'COUNT(*)'
        if measure_resolver:
            try:
                table_value=measure_resolver(target)
                if isinstance(table_value,DaxTable):return f'(SELECT COUNT(*) FROM ({table_value.sql}) {qi("__row")})'
            except (DaxError,KeyError,ValueError):pass
        table_value=_compile_table_expr(target,model,{},filters or [],measure_resolver)
        if isinstance(table_value,DaxTable):
            # SUMMARIZE produces the distinct grouping tuples. Expressing its
            # row count as an aggregate on the visual's outer fact rows keeps
            # category/date context for cards and charts instead of returning
            # one global scalar for every bar or point.
            if table_value.source_table and table_value.group_columns and not table_value.computed:
                fields=[resolve_field(model,table_value.source_table,column) for column in table_value.group_columns]
                distinct=fields[0] if len(fields)==1 else '('+', '.join(fields)+')'
                aggregate=f'COUNT(DISTINCT {distinct})'
                return _attach_filter(aggregate,' AND '.join(f'({item})' for item in table_value.row_predicates))
            return f'(SELECT COUNT(*) FROM ({table_value.sql}) {qi("__row")})'
        return 'COUNT(*)'

    m=re.fullmatch(r'(?is)(SUMX|AVERAGEX|MINX|MAXX|CONCATENATEX)\s*\((.*)\)',expr)
    if m:
        fn=m.group(1).upper();args=split_top(m.group(2))
        required=3 if fn=='CONCATENATEX' else 2
        if len(args)<required:raise DaxError(f'{fn} requires at least {required} arguments.')
        # Iterating a physical table can remain in the outer query. This keeps
        # chart grouping and slicer predicates in the iterator's row context.
        if fn in ('SUMX','AVERAGEX','MINX','MAXX'):
            requested_table=args[0].strip().strip("'")
            direct_table=next((name for name in model.get('tables',{}) if name.lower()==requested_table.lower()),None)
            if direct_table is not None:
                aggregate={'SUMX':'SUM','AVERAGEX':'AVG','MINX':'MIN','MAXX':'MAX'}[fn]
                return f'{aggregate}({_compile_row_expr(args[1],model,direct_table)})'
        table_value=None
        if measure_resolver:
            try:table_value=measure_resolver(args[0].strip())
            except (DaxError,KeyError,ValueError):pass
        if not isinstance(table_value,DaxTable):
            table_value=_compile_table_expr(args[0],model,{},filters or [],measure_resolver)
        if isinstance(table_value,DaxTable):
            value=_virtual_scalar(args[1],table_value,model,measure_resolver,filters)
            if fn in ('SUMX','AVERAGEX','MINX','MAXX'):
                aggregate={'SUMX':'SUM','AVERAGEX':'AVG','MINX':'MIN','MAXX':'MAX'}[fn]
                return f'(SELECT {aggregate}({value}) FROM ({table_value.sql}) {qi("__row")})'
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

    m=re.fullmatch(r'(?is)RANKX\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1),keep_empty=True)
        if len(args)<2:raise DaxError('RANKX requires a table and expression.')
        table_value=_compile_table_expr(args[0],model,{},filters or [],measure_resolver)
        if not isinstance(table_value,DaxTable) or len(table_value.group_columns)!=1:
            raise DaxError('RANKX currently requires ALL or VALUES over one grouping column.')
        value=_compile_simple(args[1],model,measure_resolver,filters)
        order=(args[3].strip().upper() if len(args)>3 and args[3].strip() else 'DESC')
        ties=(args[4].strip().upper() if len(args)>4 and args[4].strip() else 'SKIP')
        if order not in {'ASC','DESC'}:raise DaxError('RANKX order must be ASC or DESC.')
        if ties not in {'DENSE','SKIP'}:raise DaxError('RANKX ties must be DENSE or SKIP.')
        rank_fn='DENSE_RANK' if ties=='DENSE' else 'RANK'
        return f'{rank_fn}() OVER (ORDER BY {value} {order})'

    for fn,sqlfn in [('ABS','ABS'),('INT','FLOOR'),('FLOOR','FLOOR'),('CEILING','CEIL'),('LEN','LENGTH')]:
        m=re.fullmatch(rf'(?is){fn}\s*\((.*)\)',expr)
        if m:
            args=split_top(m.group(1))
            if fn in {'FLOOR','CEILING'} and len(args)==2:
                value=_compile_simple(args[0],model,measure_resolver,filters)
                significance=_compile_simple(args[1],model,measure_resolver,filters)
                # DuckDB's FLOOR/CEIL accept one argument while DAX accepts a
                # significance. Scaling preserves the DAX two-argument shape
                # and, unlike passing the comma expression through recursively,
                # supports nested POWER/DIVIDE expressions safely.
                return f'({sqlfn}(({value})/NULLIF(ABS({significance}),0))*ABS({significance}))'
            if len(args)!=1:raise DaxError(f'{fn} requires one value'+(' and optional significance.' if fn in {'FLOOR','CEILING'} else '.'))
            return f'{sqlfn}({_compile_simple(args[0],model,measure_resolver,filters)})'

    m=re.fullmatch(r'(?is)FORMAT\s*\((.*)\)',expr)
    if m:
        args=split_top(m.group(1))
        if len(args) not in (2,3):raise DaxError('FORMAT requires a value, format string, and optional locale.')
        value=_compile_simple(args[0],model,measure_resolver,filters)
        return _dax_format_sql(value,args[1],args[2] if len(args)==3 else None)

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
        if unit not in {'SECOND','MINUTE','HOUR','DAY','WEEK','MONTH','QUARTER','YEAR'}:
            raise DaxError('DATEDIFF interval must be SECOND, MINUTE, HOUR, DAY, WEEK, MONTH, QUARTER, or YEAR.')
        start=_compile_simple(args[0],model,measure_resolver,filters,in_filter=in_filter)
        end=_compile_simple(args[1],model,measure_resolver,filters,in_filter=in_filter)
        return f"date_diff('{unit.lower()}',CAST({start} AS TIMESTAMP),CAST({end} AS TIMESTAMP))"

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

    m=re.fullmatch(r'(?is)FILTER\s*\(\s*ALL\s*\(\s*(\'?.*?\'?)\s*\[\s*([^\]]+)\]\s*\)\s*,\s*(.*)\)',e)
    if m:
        t=m.group(1).strip("'");c=m.group(2).strip();cond=m.group(3).strip()
        return _condition(cond,model,resolve_filter_value,filters,in_filter=True),{semantic_field(t,c)}
        
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
    # A direct Boolean CALCULATE filter replaces an existing filter on the same
    # column (KEEPFILTERS, handled above, is the explicit intersection form).
    referenced=parse_field(re.split(r'(?<![<>])(?:>=|<=|<>|=|>|<)',e,maxsplit=1)[0].strip())
    overridden={semantic_field(*referenced)} if referenced else set()
    return _condition(e,model,resolve_filter_value,filters,in_filter=True),overridden

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
    signature_errors=_validate_function_signatures(text,'measure')
    if signature_errors:raise DaxError(' '.join(dict.fromkeys(signature_errors)))
    direct_column=parse_field(text)
    if direct_column:
        table,column=direct_column
        raise DaxError(
            f"'{table}'[{column}] is a column, not a scalar measure. Wrap it in SUM/MIN/MAX, "
            'use SELECTEDVALUE, or create a calculated column in Transform Data.'
        )
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
        'calculatetable-summary':'Health Table Context = VAR _Year = YEAR(TODAY()) RETURN COUNTROWS(CALCULATETABLE(SUMMARIZE(Health,Health[Id],Health[EventDate]),REMOVEFILTERS(Health),FILTER(ALL(Health[EventDate]),Health[EventDate] >= DATE(_Year,1,1) && Health[EventDate] < DATE(_Year+1,1,1))))',
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
        'previous-periods':'Health Previous = CALCULATE([Base Amount],PREVIOUSMONTH(Health[EventDate]),PREVIOUSQUARTER(Health[EventDate]),PREVIOUSYEAR(Health[EventDate]),PARALLELPERIOD(Health[EventDate],-1,YEAR))',
        'totals':'Health Totals = TOTALYTD([Base Amount],Health[EventDate]) + TOTALMTD([Base Amount],Health[EventDate]) + TOTALQTD([Base Amount],Health[EventDate])',
        'variables':'Health Variables = VAR Current = [Base Amount] RETURN Current',
        'concat-operator':'Health Ampersand = LEFT(Health[Status],1) & RIGHT(Health[Status],1)',
        'format-text':'Health Format = FORMAT([Base Amount], "#,##0.00") & " USD"',
        'rankx':'Health Rank = RANKX(ALL(Health[Status]),CALCULATE([Base Amount]),,DESC,DENSE)',
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

