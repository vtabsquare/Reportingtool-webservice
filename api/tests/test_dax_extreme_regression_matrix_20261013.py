"""High-volume compiler matrix for supported VTAB DAX combinations.

This deliberately generates combinations instead of validating a few hand-picked
examples. A failure identifies the exact generated expression.
"""
from app.dax_engine import compile_dax, diagnose_dax_definition


MODEL={
    'tables':{'lead_crm':{'physical':'lead_crm','columns':{
        'lead_id':'lead_id','source':'source','location':'location',
        'lead_status':'lead_status','amount':'amount','created_date':'created_date'}}},
    'relationships':[],
    'columnTypes':{'lead_crm.amount':'double','lead_crm.created_date':'date'},
    'measures':{
        'Total Enquiries':"Total Enquiries = COUNTROWS ( 'lead_crm' )",
        'Total Amount':"Total Amount = SUM ( 'lead_crm'[amount] )",
    },
}


def resolver(name):
    return compile_dax(MODEL['measures'][name],MODEL,measure_resolver=resolver).sql


def _compile(body,index):
    expression=f'Stress {index} = {body}'
    diagnostic=diagnose_dax_definition(expression)
    assert diagnostic['issues']==[],(expression,diagnostic)
    sql=compile_dax(expression,MODEL,measure_resolver=resolver).sql
    assert sql and 'Unsupported' not in sql
    return sql


def test_extreme_scalar_filter_and_table_expression_matrix():
    compiled=0
    text_expressions=[
        "TRIM('lead_crm'[source])",
        "LOWER(TRIM('lead_crm'[source]))",
        "UPPER(TRIM('lead_crm'[location]))",
        "LEFT('lead_crm'[source],3)",
        "RIGHT('lead_crm'[location],2)",
        "MID('lead_crm'[lead_status],2,4)",
        "SUBSTITUTE('lead_crm'[source],\" \" ,\"_\")",
    ]
    literals=['"open"','"converted"','"web"','"north"','"partner"','"referral"','""']
    operators=['=','<>']
    for left in text_expressions:
        for operator in operators:
            for literal in literals:
                _compile(f'IF ( {left} {operator} {literal}, 1, 0 )',compiled);compiled+=1

    aggregate_expressions=[
        "SUM('lead_crm'[amount])","AVERAGE('lead_crm'[amount])",
        "MIN('lead_crm'[amount])","MAX('lead_crm'[amount])",
        "COUNT('lead_crm'[lead_id])","DISTINCTCOUNT('lead_crm'[lead_id])",
        "COUNTROWS('lead_crm')",
    ]
    filter_values=['"open"','"converted"','"qualified"','"closed"']
    for aggregate in aggregate_expressions:
        for value in filter_values:
            for mode in range(3):
                condition=f"LOWER(TRIM('lead_crm'[lead_status])) = {value}"
                if mode==1:condition=f'NOT ISBLANK(\'lead_crm\'[source]) && {condition}'
                if mode==2:condition=f'{condition} || \'lead_crm\'[source] = "web"'
                _compile(f"CALCULATE({aggregate},FILTER('lead_crm',{condition}))",compiled);compiled+=1

    numeric=['ABS(-5)','ROUND(12.345,2)','POWER(2,3)','SQRT(81)','DIVIDE([Total Amount],[Total Enquiries],0)']
    for left in numeric:
        for right in numeric:
            _compile(f'({left}) + ({right})',compiled);compiled+=1

    for column in ('source','location','lead_status'):
        for direction in ('ASC','DESC'):
            body=f'''VAR T = TOPN(1,FILTER(ADDCOLUMNS(ALL('lead_crm'[{column}]),"EnquiryCount",[Total Enquiries]),NOT ISBLANK('lead_crm'[{column}])),[EnquiryCount],DESC,'lead_crm'[{column}],{direction}) RETURN CONCATENATEX(T,'lead_crm'[{column}],", ")'''
            _compile(body,compiled);compiled+=1
            summary=f'''VAR T = SUMMARIZE('lead_crm','lead_crm'[{column}],"EnquiryCount",[Total Enquiries]) VAR M = MAXX(T,[EnquiryCount]) VAR F = FILTER(T,[EnquiryCount]=M) RETURN MINX(F,'lead_crm'[{column}])'''
            _compile(summary,compiled);compiled+=1

    date_anchors=['TODAY()',"MAX('lead_crm'[created_date])"]
    for anchor in date_anchors:
        for months in range(-12,1):
            _compile(f'EDATE({anchor},{months})',compiled);compiled+=1
            _compile(f'EOMONTH({anchor},{months})',compiled);compiled+=1

    assert compiled >= 240
