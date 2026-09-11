from __future__ import annotations
import re
from .semantic_engine import measure


def _slug(s:str)->str:
    s=re.sub(r'[^A-Za-z0-9]+','_',s).strip('_')
    return s[:80] or 'Measure'

def _dtype(model,table,col):
    return str(model.get('columnTypes',{}).get(f'{table}.{col}','')).lower()

def _norm(s:str)->str:
    return re.sub(r'[^a-z0-9]','',s.lower())

def _is_date(model,table,col):
    d=_dtype(model,table,col); n=_norm(col)
    return any(k in d for k in ('date','time','timestamp')) or n in ('date','orderdate','transactiondate','invoicedate','salesdate','createddate','shipdate','joindate')

def _is_numeric(model,table,col):
    d=_dtype(model,table,col); n=_norm(col)
    if any(k in d for k in ('int','decimal','double','float','number','currency','numeric')): return True
    return any(k in n for k in ('amount','revenue','sales','cost','profit','quantity','qty','price','discount','margin','value','total','rate','percent','pct','balance'))

def _is_id(col):
    n=_norm(col)
    return n=='id' or n.endswith('id') or n.endswith('key') or n.endswith('code') or n.endswith('number')

def _human(col):
    return re.sub(r'(?<!^)(?=[A-Z])',' ',col).replace('_',' ').strip()

def _candidate(name,expression,category,description,table,fields,confidence=.95,priority=100):
    return {'id':_slug(name).lower(),'name':_slug(name),'expression':expression,'category':category,
            'description':description,'table':table,'fields':fields,'confidence':round(confidence,2),'priority':priority}

def _semantic_role(table:str,tdef:dict,model:dict)->str:
    n=_norm(table)
    cols=list((tdef.get('columns') or {}).keys())
    numeric=sum(_is_numeric(model,table,c) for c in cols)
    ids=sum(_is_id(c) for c in cols)
    dates=sum(_is_date(model,table,c) for c in cols)
    if 'calendar' in n or n in ('date','dimdate','datedim','datecalendar') or (dates and any(_norm(c)=='date' for c in cols) and len(cols)>20): return 'Calendar'
    if any(x in n for x in ('fact','sales','transaction','orderline','invoice','ledger')) or numeric>=4: return 'Fact'
    if n.startswith('dim') or ids>=1: return 'Dimension'
    return 'Dimension'

def _business_kind(col:str)->str|None:
    n=_norm(col)
    tests=[
      ('sales',('salesamount','netsales','grosssales','salesvalue','saleamount','sales')),
      ('revenue',('revenueamount','netrevenue','grossrevenue','revenue')),
      ('profit',('profitamount','netprofit','grossprofit','profit')),
      ('cost',('costamount','totalcost','cost')),
      ('quantity',('quantity','qty','units','unitssold')),
      ('price',('unitprice','price','sellingprice')),
      ('discount',('discountamount','discountpct','discountpercent','discount')),
    ]
    for kind,names in tests:
        if n in names or any(x in n for x in names): return kind
    return None

def _best_date(model:dict,roles:dict):
    # Prefer the Date column of a Calendar/Date dimension, then a fact transaction/order date.
    for t,role in roles.items():
        if role=='Calendar':
            cols=list((model['tables'][t].get('columns') or {}).keys())
            for wanted in ('date','Date'):
                for c in cols:
                    if _norm(c)==_norm(wanted): return (t,c)
            for c in cols:
                if _is_date(model,t,c): return (t,c)
    preferred=('orderdate','transactiondate','salesdate','invoicedate','date')
    for key in preferred:
        for t,role in roles.items():
            if role=='Fact':
                for c in (model['tables'][t].get('columns') or {}):
                    if _norm(c)==key: return (t,c)
    for t in model.get('tables',{}):
        for c in (model['tables'][t].get('columns') or {}):
            if _is_date(model,t,c): return (t,c)
    return None

def _count_entities(model,roles):
    result=[]
    for t,role in roles.items():
        cols=list((model['tables'][t].get('columns') or {}).keys())
        for c in cols:
            n=_norm(c)
            if _is_id(c):
                label=None
                if 'customer' in n: label='Customers'
                elif 'order' in n: label='Orders'
                elif 'product' in n: label='Products'
                elif 'employee' in n: label='Employees'
                elif 'invoice' in n: label='Invoices'
                elif 'supplier' in n or 'vendor' in n: label='Suppliers'
                if label: result.append((label,t,c,role))
    # Dimensions often expose a generic CustomerID/ProductID.
    for t,role in roles.items():
        if role!='Dimension': continue
        tn=_norm(t)
        label=None
        if 'customer' in tn: label='Customers'
        elif 'product' in tn: label='Products'
        elif 'employee' in tn: label='Employees'
        elif 'supplier' in tn or 'vendor' in tn: label='Suppliers'
        if label:
            for c in (model['tables'][t].get('columns') or {}):
                if _is_id(c): result.append((label,t,c,role)); break
    seen=set(); out=[]
    for x in result:
        if x[0] in seen: continue
        seen.add(x[0]); out.append(x)
    return out

def _period_measure(name,base_expr,dref,kind,description,table,fields,priority=90):
    if kind=='YTD': expr=f'{name} =\nTOTALYTD ( {base_expr}, {dref} )'
    elif kind=='MTD': expr=f'{name} =\nTOTALMTD ( {base_expr}, {dref} )'
    elif kind=='QTD': expr=f'{name} =\nTOTALQTD ( {base_expr}, {dref} )'
    elif kind=='LY': expr=f'{name} =\nCALCULATE ( {base_expr}, SAMEPERIODLASTYEAR ( {dref} ) )'
    else: raise ValueError(kind)
    return _candidate(name,expr,'Time Intelligence',description,table,fields,.96,priority)

def _rolling_measure(name,base_expr,dref,days,description,table,fields,priority=88):
    expr=(f'{name} =\nVAR MaxSelectedDate =\n    MAX ( {dref} )\nRETURN\nCALCULATE (\n    {base_expr},\n'
          f'    DATESINPERIOD ( {dref}, MaxSelectedDate, -{days}, DAY )\n)')
    return _candidate(name,expr,'Rolling Period',description,table,fields,.97,priority)

def _rolling_month_measure(name,base_expr,dref,months,description,table,fields,priority=87):
    expr=(f'{name} =\nVAR MaxSelectedDate =\n    MAX ( {dref} )\nRETURN\nCALCULATE (\n    {base_expr},\n'
          f'    DATESINPERIOD ( {dref}, MaxSelectedDate, -{months}, MONTH )\n)')
    return _candidate(name,expr,'Rolling Period',description,table,fields,.96,priority)

def generate_measure_catalog(model:dict,limit:int=360):
    """Create a business-oriented, model-grounded measure catalog.

    Fact, dimension and Calendar roles are inferred from model metadata. High-value
    commercial KPIs and time-intelligence measures are emitted before technical
    profiling measures. Every returned candidate is compiled against the model.
    """
    tables=model.get('tables',{})
    roles={t:_semantic_role(t,d,model) for t,d in tables.items()}
    date_field=_best_date(model,roles)
    dref=f'{date_field[0]}[{date_field[1]}]' if date_field else None
    raw=[]

    business_numeric=[]
    other_numeric=[]
    for t,tdef in tables.items():
        for c in (tdef.get('columns') or {}):
            if not _is_numeric(model,t,c): continue
            kind=_business_kind(c)
            (business_numeric if kind else other_numeric).append((t,c,kind))

    # 1) Business headline KPIs first.
    preferred_order={'sales':0,'revenue':1,'profit':2,'cost':3,'quantity':4,'price':5,'discount':6}
    business_numeric.sort(key=lambda x:(preferred_order.get(x[2],99),x[0],x[1]))
    for t,c,kind in business_numeric:
        label={'sales':'Sales','revenue':'Revenue','profit':'Profit','cost':'Cost','quantity':'Quantity','price':'Unit Price','discount':'Discount'}.get(kind,_human(c))
        ref=f'{t}[{c}]'; base=f'SUM ( {ref} )'
        raw.append(_candidate(f'Overall_{label}',f'Overall_{_slug(label)} =\n{base}','Executive KPI',f'Overall {label.lower()} across the current filter context.',t,[f'{t}.{c}'],.99,1))
        raw.append(_candidate(f'Average_{label}',f'Average_{_slug(label)} =\nAVERAGE ( {ref} )','Executive KPI',f'Average {label.lower()} across the current filter context.',t,[f'{t}.{c}'],.98,20))
        if dref:
            fields=[f'{t}.{c}',f'{date_field[0]}.{date_field[1]}']
            raw.extend([
                _period_measure(f'{_slug(label)}_YTD',base,dref,'YTD',f'{label} year to date.',t,fields,10),
                _period_measure(f'{_slug(label)}_MTD',base,dref,'MTD',f'{label} month to date.',t,fields,11),
                _period_measure(f'{_slug(label)}_QTD',base,dref,'QTD',f'{label} quarter to date.',t,fields,12),
                _period_measure(f'Last_Year_{_slug(label)}',base,dref,'LY',f'{label} for the comparable period last year.',t,fields,13),
            ])
            for days in (5,7,10,14,21,28,30,42,45,56,60,75,90,100,120,150,180,270,365):
                raw.append(_rolling_measure(f'Last_{days}_Days_{_slug(label)}',base,dref,days,f'{label} over the last {days} days from the maximum selected date.',t,fields,25+days//10))
            for months in (1,2,3,4,5,6,8,9,10,12,15,18,24,36):
                raw.append(_rolling_month_measure(f'Last_{months}_Months_{_slug(label)}',base,dref,months,f'{label} over the last {months} month(s) from the maximum selected date.',t,fields,50+months))
            for weeks in (1,2,3,4,6,8,13,16,26,52):
                raw.append(_rolling_measure(f'Last_{weeks}_Weeks_{_slug(label)}',base,dref,weeks*7,f'{label} over the last {weeks} week(s) from the maximum selected date.',t,fields,60+weeks))

    # 2) Entity counts from dimensions/facts.
    for label,t,c,role in _count_entities(model,roles):
        ref=f'{t}[{c}]'; name=f'Total_{label}'
        raw.append(_candidate(name,f'{name} =\nDISTINCTCOUNT ( {ref} )','Executive KPI',f'Total distinct {label.lower()} in the current filter context.',t,[f'{t}.{c}'],.99,2))
        if dref:
            fields=[f'{t}.{c}',f'{date_field[0]}.{date_field[1]}']
            for days in (7,14,30,90,365):
                nm=f'{label}_Last_{days}_Days'
                expr=(f'{nm} =\nVAR MaxSelectedDate =\n    MAX ( {dref} )\nRETURN\nCALCULATE (\n    DISTINCTCOUNT ( {ref} ),\n'
                      f'    DATESINPERIOD ( {dref}, MaxSelectedDate, -{days}, DAY )\n)')
                raw.append(_candidate(nm,expr,'Customer & Activity',f'Distinct {label.lower()} active in the last {days} days.',t,fields,.95,70+days//20))

    # 3) Business ratios derived from recognized columns.
    by_kind={}
    for t,c,k in business_numeric:
        by_kind.setdefault(k,[]).append((t,c))
    if by_kind.get('profit') and by_kind.get('sales'):
        pt,pc=by_kind['profit'][0]; st,sc=by_kind['sales'][0]
        nm='Profit_Margin_Percent';expr=f'{nm} =\nDIVIDE ( SUM ( {pt}[{pc}] ), SUM ( {st}[{sc}] ), 0 )'
        raw.append(_candidate(nm,expr,'Business Ratio','Profit as a percentage of sales.',pt,[f'{pt}.{pc}',f'{st}.{sc}'],.99,5))
    if by_kind.get('cost') and by_kind.get('sales'):
        ct,cc=by_kind['cost'][0]; st,sc=by_kind['sales'][0]
        nm='Cost_to_Sales_Percent';expr=f'{nm} =\nDIVIDE ( SUM ( {ct}[{cc}] ), SUM ( {st}[{sc}] ), 0 )'
        raw.append(_candidate(nm,expr,'Business Ratio','Cost as a percentage of sales.',ct,[f'{ct}.{cc}',f'{st}.{sc}'],.97,18))
    customers=next((x for x in _count_entities(model,roles) if x[0]=='Customers'),None)
    if customers and by_kind.get('sales'):
        st,sc=by_kind['sales'][0]; _,ct,cc,_=customers
        nm='Sales_per_Customer';expr=f'{nm} =\nDIVIDE ( SUM ( {st}[{sc}] ), DISTINCTCOUNT ( {ct}[{cc}] ), 0 )'
        raw.append(_candidate(nm,expr,'Business Ratio','Average sales generated per distinct customer.',st,[f'{st}.{sc}',f'{ct}.{cc}'],.98,6))

    # 4) Useful aggregates for other numeric fields, but after business KPIs.
    for t,c,_ in other_numeric:
        ref=f'{t}[{c}]'; label=_slug(_human(c))
        for prefix,fn,desc in [('Total','SUM',f'Total {_human(c).lower()}.'),('Average','AVERAGE',f'Average {_human(c).lower()}.'),('Minimum','MIN',f'Minimum {_human(c).lower()}.'),('Maximum','MAX',f'Maximum {_human(c).lower()}.')]:
            nm=f'{prefix}_{label}'; raw.append(_candidate(nm,f'{nm} =\n{fn} ( {ref} )','Operational KPI',desc,t,[f'{t}.{c}'],.92,120))

    # 5) Row counts and dimension counts ensure non-sales models still get useful KPIs.
    for t,tdef in tables.items():
        nm=f'Total_Rows_{_slug(t)}'; raw.append(_candidate(nm,f'{nm} =\nCOUNTROWS ( {t} )','Operational KPI',f'Total rows in {t}.',t,[],.95,130))
        for c in (tdef.get('columns') or {}):
            if _is_id(c):
                nm=f'Distinct_{_slug(_human(c))}_{_slug(t)}';raw.append(_candidate(nm,f'{nm} =\nDISTINCTCOUNT ( {t}[{c}] )','Operational KPI',f'Distinct {_human(c).lower()} in {t}.',t,[f'{t}.{c}'],.92,135))

    # 6) Data quality measures are intentionally low priority, used only to fill remaining catalog space.
    for t,tdef in tables.items():
        for c in (tdef.get('columns') or {}):
            ref=f'{t}[{c}]';base=_slug(f'{t}_{c}')
            nm=f'Completeness_Rate_{base}';raw.append(_candidate(nm,f'{nm} =\nDIVIDE ( COUNT ( {ref} ), COUNTROWS ( {t} ), 0 )','Data Quality',f'Populated-value rate for {_human(c)}.',t,[f'{t}.{c}'],.84,250))
            nm=f'Uniqueness_Rate_{base}';raw.append(_candidate(nm,f'{nm} =\nDIVIDE ( DISTINCTCOUNT ( {ref} ), COUNTROWS ( {t} ), 0 )','Data Quality',f'Unique-value rate for {_human(c)}.',t,[f'{t}.{c}'],.82,260))

    # Deduplicate, sort by business relevance, and validate each formula against the semantic model.
    raw.sort(key=lambda x:(x.get('priority',100),-x.get('confidence',0),x['name']))
    out=[]; seen=set(); base_measures=dict(model.get('measures') or {})
    for cand in raw:
        if len(out)>=limit: break
        if cand['name'] in seen or cand['name'] in base_measures: continue
        working={**model,'measures':{**base_measures,cand['name']:cand['expression']}}
        try: compiled=measure(cand['name'],working,context_filters=[])
        except Exception: continue
        cand['compiledPreview']=compiled; cand.pop('priority',None)
        seen.add(cand['name']);out.append(cand)

    # If the model is small and business suggestions do not reach 360, return what is genuinely useful.
    # The UI displays "up to 360" rather than inventing meaningless filler measures.
    return {'suggestions':out,'count':len(out),'requested':limit,
            'modelSummary':{'tables':len(tables),'factTables':sum(v=='Fact' for v in roles.values()),
                            'dimensionTables':sum(v=='Dimension' for v in roles.values()),
                            'calendarTables':sum(v=='Calendar' for v in roles.values()),
                            'roles':roles,'dateField':f'{date_field[0]}.{date_field[1]}' if date_field else None}}
