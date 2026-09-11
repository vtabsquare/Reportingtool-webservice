from __future__ import annotations
import re, json, hashlib, time, threading
from collections import OrderedDict
from .dax_engine import compile_dax
from .local_engine import connect, ensure_analytics_ready

def q(x):return '"'+str(x).replace('"','""')+'"'
def fld(model,dotted):
    t,c=dotted.split('.',1);part=None
    if '::' in c:c,part=c.rsplit('::',1)
    physical=model["tables"][t]["columns"][c];base=f'{q(t)}.{q(physical)}'
    if not part:return base
    d=f'TRY_CAST({base} AS DATE)';p=part.lower()
    if p=='year':return f'year({d})'
    if p=='quarter':return f"'Q' || CAST(quarter({d}) AS VARCHAR)"
    if p=='month':return f"strftime({d}, '%Y-%m')"
    if p=='week':return f"strftime({d}, '%Y-W%W')"
    if p=='day':return f'CAST({d} AS DATE)'
    raise ValueError(f'Unsupported date hierarchy part: {part}')

def measure(name,model,stack=None,context_filters=None,with_meta=False):
    stack=stack or []
    if name in stack:
        raise ValueError('Circular measure dependency: '+' -> '.join(stack+[name]))

    # Desktop serializes an implicit aggregation as
    # ``Table.Column::aggregation``.  Keep the suffix separate from date
    # hierarchy suffixes (which are handled by fld()) and resolve the raw
    # column before looking for a named measure.  Without this, a perfectly
    # valid published COUNT binding is reported as an "Unknown measure".
    aggregate=None
    raw_name=name
    if '::' in name:
        candidate,suffix=name.rsplit('::',1)
        normalized=suffix.strip().lower().replace('-','_').replace(' ','_')
        aliases={
            'sum':'sum',
            'count':'count',
            'min':'min',
            'max':'max',
            'avg':'average',
            'average':'average',
            'distinctcount':'count_distinct',
            'distinct_count':'count_distinct',
            'countdistinct':'count_distinct',
            'count_distinct':'count_distinct',
        }
        if normalized in aliases:
            raw_name=candidate
            aggregate=aliases[normalized]

    if raw_name not in model.get('measures',{}):
        # Auto-aggregate raw column references (e.g. "Finance Data.LOAN AMOUNT")
        # that were dragged from the numeric fields pane directly into Values.
        if '.' in raw_name:
            try:
                parts=raw_name.split('.',1)
                t,c=parts[0].strip(),parts[1].strip()
                if t in model.get('tables',{}) and c in model['tables'][t].get('columns',{}):
                    field_sql=fld(model,raw_name)
                    if aggregate=='count':
                        sql=f'COUNT({field_sql})'
                    elif aggregate=='count_distinct':
                        sql=f'COUNT(DISTINCT {field_sql})'
                    elif aggregate=='min':
                        sql=f'MIN({field_sql})'
                    elif aggregate=='max':
                        sql=f'MAX({field_sql})'
                    elif aggregate=='average':
                        sql=f'AVG(TRY_CAST({field_sql} AS DOUBLE))'
                    else:
                        sql=f'SUM(TRY_CAST({field_sql} AS DOUBLE))'
                    return (sql,set()) if with_meta else sql
            except Exception:
                pass
        raise ValueError(f"Unknown measure [{name}]")
    # An aggregation suffix only applies to implicit raw-column measures.
    # Preserve the original named-measure behavior for malformed bindings.
    name=raw_name
    exp=model['measures'][name].strip()

    def resolve_measure(ref):
        return measure(ref,model,stack+[name],context_filters,False)

    if re.search(r'[A-Za-z_][\w ]*\[[^\]]+\]',exp) or re.search(r'(?i)\b(VAR|RETURN|CALCULATE|EDATE|DATESBETWEEN)\b',exp):
        c=compile_dax(exp,model,context_filters or [],resolve_measure)
        return (c.sql,c.override_fields) if with_meta else c.sql

    m=re.fullmatch(r'(SUM|AVG|MIN|MAX|COUNT|DISTINCTCOUNT)\(([^.]+)\.(.+)\)',exp,re.I)
    if m:
        sql=f'{m.group(1).upper()}({fld(model,m.group(2).strip()+"."+m.group(3).strip())})'
        return (sql,set()) if with_meta else sql

    if exp.upper().startswith('DIVIDE('):
        inner=exp[7:-1];depth=0;cut=None
        for i,ch in enumerate(inner):
            if ch=='(':depth+=1
            elif ch==')':depth-=1
            elif ch==',' and depth==0:cut=i;break
        if cut is None:
            raise ValueError('DIVIDE requires two arguments')
        a,b=inner[:cut],inner[cut+1:]
        def ce(x):
            x=x.strip()
            m2=re.fullmatch(r'\[([^]]+)\]',x)
            return measure(m2.group(1),model,stack+[name],context_filters,False) if m2 else inline(x,model,stack+[name],context_filters)
        aa,bb=ce(a),ce(b)
        sql=f'(({aa})/NULLIF(({bb}),0))'
        return (sql,set()) if with_meta else sql

    sql=inline(exp,model,stack+[name],context_filters)
    return (sql,set()) if with_meta else sql

def inline(exp,model,stack,context_filters=None):
    if re.search(r"[;'\"`]",exp):
        raise ValueError('Unsafe measure expression')
    out=exp
    
    if model and 'measures' in model:
        for m_name in sorted(model['measures'].keys(), key=len, reverse=True):
            pattern = r'(?<!\[)(?<!\.)\b' + re.escape(m_name) + r'\b(?!\])'
            if re.search(pattern, out, re.IGNORECASE):
                # We use a lambda to insert the original matched case into the bracket if needed,
                # but inserting the actual exact m_name is better so it matches exactly.
                out = re.sub(pattern, f'[{m_name}]', out, flags=re.IGNORECASE)

    for ref in re.findall(r'\[([^]]+)\]',out):
        out=out.replace(f'[{ref}]',f'({measure(ref,model,stack,context_filters,False)})')
    return out

def required(model,dims,measures,rls,filters=()):
    # Every field referenced by a visual dimension, slicer/cross-filter, page/report filter,
    # or RLS predicate must participate in relationship-path planning.  Previously filter
    # tables were omitted, so a Customers[CustomerName] slicer could be compiled into the
    # WHERE clause while only the Sales table existed in FROM, producing a DuckDB Binder Error.
    req={d.split('.',1)[0] for d in dims}
    for f in filters or ():
        field=f.get('field') if isinstance(f,dict) else None
        if field and '.' in field:
            table=field.split('.',1)[0]
            if table in model.get('tables',{}):
                req.add(table)
    # Raw-column measures (e.g. "CHENNAI.Discount") are NOT in model["measures"] but still
    # carry a table prefix.  Without this block, their table never enters the FROM clause
    # and DuckDB raises "Binder Error: Referenced table '...' not found".
    for m in measures:
        if '.' in m and m not in model.get('measures',{}):
            t=m.split('.',1)[0]
            if t in model.get('tables',{}):
                req.add(t)
    names=set(measures);changed=True
    while changed:
        changed=False
        for n in list(names):
            exp=model.get('measures',{}).get(n,'')
            # Bracket refs not immediately preceded by a table identifier are measure refs.
            for ref in re.findall(r'(?<![A-Za-z0-9_])\[([^]]+)\]',exp):
                if ref in model.get('measures',{}) and ref not in names:
                    names.add(ref);changed=True
    txt=' '.join(model.get('measures',{}).get(n,'') for n in names)
    for t in model['tables']:
        if t+'.' in txt or re.search(r'(?i)\b' + re.escape(t) + r'[\'"]?\s*([\[\.])', txt):
            req.add(t)
    
    # Detect implicit column references in measures (e.g., SUM(Revenue))
    dax_funcs = {'SUM','AVG','MIN','MAX','COUNT','DISTINCTCOUNT','DIVIDE','CALCULATE','VAR','RETURN','EDATE','DATESBETWEEN'}
    words = set(re.findall(r'[A-Za-z0-9_]+', txt))
    for w in words:
        if w.upper() not in dax_funcs:
            for t_name, t_def in model.get('tables', {}).items():
                if w in t_def.get('columns', {}):
                    req.add(t_name)

    for r in rls:req.add(r['table'])
    return req

def compile_query(model,req,rls=()):
    dims=list(dict.fromkeys(req.get('dimensions',[]) or []))
    meas=list(dict.fromkeys(req.get('measures',[]) or []))
    filters=req.get('filters',[]) or []
    needed=set(required(model,dims,meas,rls,filters))
    if not model.get('tables'):
        raise ValueError('The semantic model has no tables.')

    # Prefer the table that owns a measure, then a raw-value column, then a dimension.
    # This keeps fact-table aggregation stable while still allowing slicers/dimensions to
    # join through one or more bridge tables.
    measure_text=' '.join(model.get('measures',{}).get(m,'') for m in meas)
    preferred=[]
    dax_funcs = {'SUM','AVG','MIN','MAX','COUNT','DISTINCTCOUNT','DIVIDE','CALCULATE','VAR','RETURN','EDATE','DATESBETWEEN'}
    words = set(re.findall(r'[A-Za-z0-9_]+', measure_text))
    for table, t_def in model.get('tables',{}).items():
        if table in needed:
            if table+'.' in measure_text or re.search(r'(?i)\b' + re.escape(table) + r'[\'"]?\s*([\[\.])', measure_text):
                preferred.append(table)
                continue
            for w in words:
                if w.upper() not in dax_funcs and w in t_def.get('columns', {}):
                    preferred.append(table)
                    break
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
        a,b=r.get('fromTable'),r.get('toTable')
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
            r=relationships[edge_idx];a,b=r['fromTable'],r['toTable']
            # Both aliases use their semantic table names, so the relationship
            # expression is direction-independent.
            if nxt not in model['tables']:
                raise ValueError(f"Relationship references unknown table '{nxt}'.")
            joins.append(
                f'LEFT JOIN {q(model["tables"][nxt]["physical"])} {q(nxt)} ON '
                f'{fld(model,a+"."+r["fromColumn"])}={fld(model,b+"."+r["toColumn"])}'
            )
            joined.add(nxt)

    # A disconnected filter can be ignored (same behavior as before), but a
    # dimension/measure/RLS table must be reachable or the query would otherwise
    # reference a missing alias and fail with a Binder Error.
    critical={d.split('.',1)[0] for d in dims if '.' in d}
    critical.update(required(model,[],meas,rls,[]))
    critical.update(r.get('table') for r in rls if r.get('table'))
    blocked=unreachable & critical
    if blocked:
        print(f"[DEBUG API 400] needed: {needed}, critical: {critical}, unreachable: {unreachable}, preferred: {preferred}, base: {base}")
        raise ValueError('No active relationship path connects the selected visual fields: '+', '.join(sorted(blocked)))

    sel=[];groups=[];override_fields=set()
    for d in dims:
        if d.split('.',1)[0] in unreachable:continue
        x=fld(model,d);sel.append(f'{x} AS {q(d)}');groups.append(x)
    for m in meas:
        msql,mover=measure(m,model,context_filters=filters,with_meta=True)
        override_fields.update(mover);sel.append(f'{msql} AS {q(m)}')
    if not sel:
        # Slicers normally provide a dimension; this protects malformed empty requests.
        sel=['1 AS "Value"']
    bt=model['tables'][base];sql=f'SELECT {", ".join(sel)} FROM {q(bt["physical"])} {q(base)}'
    if joins:sql+=' '+' '.join(joins)

    wh=[];params=[]
    for f in filters:
        if f.get('field') in override_fields:continue
        f_field=f.get('field','')
        if not f_field or '.' not in f_field:continue
        if f_field.split('.',1)[0] in unreachable:continue
        op=f.get('operator','equals'); field_sql=fld(model,f_field); val=f.get('value')
        ops={'equals':'=','not_equals':'<>','gt':'>','gte':'>=','lt':'<','lte':'<='}
        if op=='contains':wh.append(field_sql+' LIKE ?');params.append('%'+str(val)+'%')
        elif op=='between' and isinstance(val,(list,tuple)) and len(val)==2:wh.append(field_sql+' BETWEEN ? AND ?');params.extend([val[0],val[1]])
        elif op in ('top_n', 'bottom_n'):
            try: req['limit'] = int(val)
            except (ValueError, TypeError): pass
            # We don't add a WHERE clause constraint for top_n; it relies on ORDER BY + LIMIT
        elif op=='in':
            vals=val if isinstance(val,(list,tuple)) else [x.strip() for x in str(val).split(',') if x.strip()]
            if not vals:wh.append('1=0')
            else:wh.append(field_sql+' IN ('+','.join('?' for _ in vals)+')');params.extend(vals)
        elif op in ops:wh.append(field_sql+' '+ops[op]+' ?');params.append(val)
        else:raise ValueError('Unsupported filter operator: '+str(op))
    for r in rls:
        if r.get('table') in unreachable:
            raise ValueError('RLS table is not connected to the visual query: '+str(r.get('table')))
        field_sql=fld(model,r['table']+'.'+r['column']); op=r.get('operator','equals'); val=r.get('value')
        ops={'equals':'=','not_equals':'<>','gt':'>','gte':'>=','lt':'<','lte':'<='}
        if op=='contains':wh.append(field_sql+' LIKE ?');params.append('%'+str(val)+'%')
        elif op=='in':
            vals=val if isinstance(val,(list,tuple)) else [x.strip() for x in str(val).split(',') if x.strip()]
            if not vals:wh.append('1=0')
            else:wh.append(field_sql+' IN ('+','.join('?' for _ in vals)+')');params.extend(vals)
        elif op in ops:wh.append(field_sql+' '+ops[op]+' ?');params.append(val)
        else:raise ValueError('Unsupported RLS operator: '+str(op))
    if wh:sql+=' WHERE '+' AND '.join(wh)
    if groups:sql+=' GROUP BY '+', '.join(groups)
    sort=req.get('sort',[]) or []
    if sort:
        valid_aliases=set(dims+meas)
        safe_sort=[x for x in sort if x.get('field') in valid_aliases]
        if safe_sort:sql+=' ORDER BY '+', '.join(q(x['field'])+' '+('DESC' if x.get('direction')=='desc' else 'ASC') for x in safe_sort)
    sql+=' LIMIT '+str(min(max(int(req.get('limit',200)),1),2000))
    return sql,params

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
