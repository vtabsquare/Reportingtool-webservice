from app.measure_catalog import generate_measure_catalog
from app.local_engine import _calendar_column_specs


def sample_model():
    return {
      'tables':{
        'Sales':{'physical':'Sales','columns':{c:c for c in ['OrderID','OrderDate','CustomerID','ProductID','Quantity','UnitPrice','DiscountPct','SalesAmount','CostAmount','ProfitAmount','Country','Region']}},
        'Customer':{'physical':'Customer','columns':{c:c for c in ['CustomerID','CustomerName','Region','Segment','Country','JoinDate','CreditLimit']}},
      },
      'relationships':[{'id':'r1','fromTable':'Customer','fromColumn':'CustomerID','toTable':'Sales','toColumn':'CustomerID','cardinality':'1:*','active':True}],
      'columnTypes':{
        'Sales.OrderDate':'date','Customer.JoinDate':'date','Sales.Quantity':'integer','Sales.UnitPrice':'decimal','Sales.DiscountPct':'decimal',
        'Sales.SalesAmount':'decimal','Sales.CostAmount':'decimal','Sales.ProfitAmount':'decimal','Customer.CreditLimit':'decimal'
      },
      'measures':{}
    }


def test_measure_catalog_returns_360_validated_suggestions():
    r=generate_measure_catalog(sample_model(),360)
    assert r['count']==360
    assert len({x['name'] for x in r['suggestions']})==360
    assert all(x.get('compiledPreview') for x in r['suggestions'])
    assert any(x['category']=='Time Intelligence' for x in r['suggestions'])
    assert any(x['category']=='Data Quality' for x in r['suggestions'])


def test_calendar_schema_has_exactly_360_unique_attributes():
    cols=_calendar_column_specs()
    assert len(cols)==360
    assert len({x[0] for x in cols})==360
    names={x[0] for x in cols}
    for required in ['Date','DateKey','DayName','ISOWeekNumber','MonthName','MonthYear','Quarter','Year','FiscalYear_M04','FiscalQuarter_M07','IsCurrentMonth','MonthOffset']:
        assert required in names
