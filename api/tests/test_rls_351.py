from app.semantic_engine import compile_query

MODEL={
 'tables':{
   'Sales':{'physical':'sales','columns':{'CustomerID':'CustomerID','SalesAmount':'SalesAmount'}},
   'Customers':{'physical':'customers','columns':{'CustomerID':'CustomerID','Country':'Country','Segment':'Segment'}}
 },
 'relationships':[{'fromTable':'Sales','fromColumn':'CustomerID','toTable':'Customers','toColumn':'CustomerID','active':True}],
 'measures':{'Overall Sales':'SUM(Sales[SalesAmount])'}
}

def test_rls_dimension_table_forces_relationship_join():
    sql,params=compile_query(MODEL,{'dimensions':[],'measures':['Overall Sales'],'filters':[],'limit':100},[{'table':'Customers','column':'Country','operator':'equals','value':'India'}])
    assert 'LEFT JOIN' in sql and 'Customers' in sql
    assert params==['India']

def test_rls_contains():
    sql,params=compile_query(MODEL,{'dimensions':[],'measures':['Overall Sales'],'filters':[],'limit':100},[{'table':'Customers','column':'Segment','operator':'contains','value':'Enter'}])
    assert 'LIKE ?' in sql
    assert params==['%Enter%']

def test_rls_in_list():
    sql,params=compile_query(MODEL,{'dimensions':[],'measures':['Overall Sales'],'filters':[],'limit':100},[{'table':'Customers','column':'Country','operator':'in','value':['India','UK']}])
    assert 'IN (?,?)' in sql
    assert params==['India','UK']
