from app.dax_engine import compile_dax, suggest_measure_from_prompt
from app.semantic_engine import compile_query

MODEL={
    'tables':{
        'Sales':{'physical':'fact_sales','columns':{'CustomerKey':'customer_key','OrderDate':'order_date','Amount':'amount','Cost':'cost','Status':'status'}},
        'CustomerBridge':{'physical':'bridge_customer','columns':{'CustomerKey':'customer_key','CustomerId':'customer_id'}},
        'Customer':{'physical':'dim_customer','columns':{'CustomerId':'customer_id','Country':'country','Segment':'segment'}},
    },
    'relationships':[
        {'fromTable':'Sales','fromColumn':'CustomerKey','toTable':'CustomerBridge','toColumn':'CustomerKey','active':True},
        {'fromTable':'CustomerBridge','fromColumn':'CustomerId','toTable':'Customer','toColumn':'CustomerId','active':True},
    ],
    'columnTypes':{
        'Sales.OrderDate':'date','Sales.Amount':'DOUBLE','Sales.Cost':'DOUBLE',
        'Sales.CustomerKey':'INTEGER','CustomerBridge.CustomerKey':'INTEGER','CustomerBridge.CustomerId':'INTEGER','Customer.CustomerId':'INTEGER'
    },
    'measures':{'Total Amount':'Total Amount = SUM ( Sales[Amount] )'}
}

def test_card_raw_numeric_column_gets_valid_fact_table_query():
    sql,params=compile_query(MODEL,{'dimensions':[],'measures':['Sales.Amount'],'filters':[],'limit':500})
    assert 'FROM "fact_sales" "Sales"' in sql
    assert 'SUM(TRY_CAST("Sales"."amount" AS DOUBLE))' in sql
    assert params==[]

def test_multihop_slicer_filter_joins_bridge_instead_of_binder_error():
    sql,params=compile_query(MODEL,{
        'dimensions':[],'measures':['Total Amount'],
        'filters':[{'field':'Customer.Country','operator':'equals','value':'India'}],
        'limit':500,
    })
    assert 'LEFT JOIN "bridge_customer" "CustomerBridge"' in sql
    assert 'LEFT JOIN "dim_customer" "Customer"' in sql
    assert '"Customer"."country" = ?' in sql
    assert params==['India']

def test_multiple_slicer_style_filters_are_combined():
    sql,params=compile_query(MODEL,{
        'dimensions':['Customer.Segment'],'measures':['Total Amount'],
        'filters':[
            {'field':'Customer.Country','operator':'in','value':['India','UK']},
            {'field':'Sales.Status','operator':'equals','value':'Closed'},
        ],'limit':500,
    })
    assert ' IN (?,?)' in sql
    assert '"Sales"."status" = ?' in sql
    assert params==['India','UK','Closed']

def test_common_valid_dax_switch_blank_logic_and_filter_compile():
    resolver=lambda name:'SUM("Sales"."amount")' if name=='Total Amount' else (_ for _ in ()).throw(ValueError(name))
    dax='Status KPI = SWITCH(TRUE(), ISBLANK([Total Amount]), "Missing", [Total Amount] >= 1000, "High", "Normal")'
    compiled=compile_dax(dax,MODEL,measure_resolver=resolver).sql
    assert 'CASE' in compiled and 'IS NULL' in compiled and '>= 1000' in compiled
    filtered=compile_dax('Closed Amount = CALCULATE(SUM(Sales[Amount]), FILTER(Sales, Sales[Status] = "Closed"))',MODEL).sql
    assert 'FILTER (WHERE' in filtered and "'Closed'" in filtered

def test_ai_builder_classifies_value_date_and_explicit_filter_roles():
    prompt='total Sales[Amount] for last 3 months using Sales[OrderDate] and Customer[Country] <> India'
    result=suggest_measure_from_prompt(prompt,MODEL)
    assert result['grounding']['valueField']=='Sales[Amount]'
    assert result['grounding']['dateField']=='Sales[OrderDate]'
    assert 'Customer[Country] <> "India"' in result['expression']
    assert 'DATESBETWEEN' in result['expression']
    assert compile_dax(result['expression'],MODEL).sql

def test_ai_builder_supports_two_explicit_numeric_fields_for_margin_ratio():
    result=suggest_measure_from_prompt('margin percentage using Sales[Amount] and Sales[Cost]',MODEL)
    assert result['intent']=='ratio'
    assert 'DIVIDE' in result['expression']
    compiled=compile_dax(result['expression'],MODEL).sql
    assert 'NULLIF' in compiled
