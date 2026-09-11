from app.measure_catalog import generate_measure_catalog
from app.local_engine import calendar_column_catalog, _calendar_sql
from tests.test_catalog_calendar_330 import sample_model


def test_business_catalog_prioritizes_business_kpis():
    r=generate_measure_catalog(sample_model(),360)
    names=[x['name'] for x in r['suggestions']]
    for required in ['Overall_Sales','Overall_Profit','Total_Customers','Total_Orders','Profit_Margin_Percent','Sales_YTD','Sales_MTD','Sales_QTD','Last_Year_Sales','Last_7_Days_Sales','Last_14_Days_Sales','Last_21_Days_Sales','Last_90_Days_Sales','Last_365_Days_Sales']:
        assert required in names
    assert r['count']==360


def test_calendar_catalog_exposes_checkbox_metadata():
    c=calendar_column_catalog()
    assert c['count']==360
    assert c['recommendedCount']>20
    names={x['name'] for x in c['columns']}
    for required in ['Date','MonthName','MonthYear','Quarter','Year','FiscalYear_M04','IsCurrentMonth','IsRollingLast1Days']:
        assert required in names
    assert any(g['name']=='Fiscal' for g in c['groups'])


def test_calendar_sql_materializes_only_selected_columns_and_date():
    sql=_calendar_sql("'2026-01-01'","'2026-01-31'",['MonthName','Year'])
    assert 'MonthName' in sql and 'Year' in sql
    assert ' AS "DateKey"' not in sql
    assert 'SELECT\n      Date,' in sql
