from app.dax_engine import suggest_measure_from_prompt, compile_dax, DaxError

MODEL={
 'tables':{
  'VTAB_Test_Customers':{'physical':'cust','columns':{'CustomerID':'CustomerID','CustomerName':'CustomerName','CreditLimit':'CreditLimit'}},
  'VTAB_Test_Sales_Transactions':{'physical':'sales','columns':{'Quantity':'Quantity','SalesAmount':'SalesAmount','CustomerID':'CustomerID','OrderDate':'OrderDate'}}
 },
 'columnTypes':{
  'VTAB_Test_Customers.CreditLimit':'DOUBLE',
  'VTAB_Test_Sales_Transactions.Quantity':'INTEGER',
  'VTAB_Test_Sales_Transactions.SalesAmount':'DOUBLE',
  'VTAB_Test_Sales_Transactions.OrderDate':'date'
 },
 'relationships':[],'measures':{}
}

def test_explicit_customer_id_never_falls_back_to_quantity():
    r=suggest_measure_from_prompt('overall VTAB_Test_Customers[CustomerID]',MODEL)
    assert 'DISTINCTCOUNT ( VTAB_Test_Customers[CustomerID] )' in r['expression']
    assert 'Quantity' not in r['expression']
    assert r['semanticChecks']['explicitFieldLock'] is True
    assert compile_dax(r['expression'],MODEL).sql=='COUNT(DISTINCT "VTAB_Test_Customers"."CustomerID")'

def test_explicit_numeric_total_is_sum():
    r=suggest_measure_from_prompt('total VTAB_Test_Sales_Transactions[SalesAmount]',MODEL)
    assert 'SUM ( VTAB_Test_Sales_Transactions[SalesAmount] )' in r['expression']
    assert r['intent']=='sum'

def test_explicit_numeric_average_is_average():
    r=suggest_measure_from_prompt('average VTAB_Test_Customers[CreditLimit]',MODEL)
    assert 'AVERAGE ( VTAB_Test_Customers[CreditLimit] )' in r['expression']

def test_identifier_is_protected_from_sum():
    r=suggest_measure_from_prompt('total VTAB_Test_Customers[CustomerID]',MODEL)
    assert 'DISTINCTCOUNT' in r['expression']
    assert 'SUM' not in r['expression']
