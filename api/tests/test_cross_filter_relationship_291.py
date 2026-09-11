from app.semantic_engine import compile_query

MODEL={
 "tables":{
   "VTAB_Test_Sales_Transactions":{"physical":"sales","columns":{"CustomerID":"CustomerID","OrderID":"OrderID","SalesAmount":"SalesAmount"}},
   "VTAB_Test_Customers":{"physical":"customers","columns":{"CustomerID":"CustomerID","CustomerName":"CustomerName"}}
 },
 "relationships":[{
   "fromTable":"VTAB_Test_Sales_Transactions","fromColumn":"CustomerID",
   "toTable":"VTAB_Test_Customers","toColumn":"CustomerID",
   "cardinality":"many-to-one","crossFilter":"single","active":True
 }],
 "measures":{"Orders":"DISTINCTCOUNT ( VTAB_Test_Sales_Transactions[OrderID] )","Total Sales":"SUM ( VTAB_Test_Sales_Transactions[SalesAmount] )"},
 "columnTypes":{}
}

def test_customer_slicer_forces_customer_join_for_sales_measure():
    req={
      "dimensions":[],
      "measures":["Orders"],
      "filters":[{"field":"VTAB_Test_Customers.CustomerName","operator":"equals","value":"Customer 0005"}],
      "limit":50
    }
    sql,params=compile_query(MODEL,req,[])
    assert 'LEFT JOIN "customers" "VTAB_Test_Customers"' in sql
    assert '"VTAB_Test_Customers"."CustomerName" = ?' in sql
    assert params==['Customer 0005']

def test_multiple_visual_measures_keep_cross_filter_join():
    req={
      "dimensions":[],
      "measures":["Orders","Total Sales"],
      "filters":[{"field":"VTAB_Test_Customers.CustomerName","operator":"equals","value":"Customer 0005"}],
      "limit":50
    }
    sql,_=compile_query(MODEL,req,[])
    assert sql.count('LEFT JOIN "customers" "VTAB_Test_Customers"')==1
    assert 'COUNT(DISTINCT "VTAB_Test_Sales_Transactions"."OrderID")' in sql
    assert 'SUM("VTAB_Test_Sales_Transactions"."SalesAmount")' in sql
