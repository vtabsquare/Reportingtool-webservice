from app.dax_engine import compile_dax,suggest_measure_from_prompt

SALES={
 'tables':{'Sales_Transactions':{'physical':'Sales_Transactions','columns':{
   'OrderDate':'OrderDate','SalesAmount':'SalesAmount','Country':'Country'}}},
 'relationships':[],'columnTypes':{'Sales_Transactions.OrderDate':'date'},'measures':{}
}
JIRA={
 'tables':{'DM_AI_PM_Jira_Sample_Dataset':{'physical':'jira','columns':{
   'Key':'Key','Story Points':'Story Points','Updated':'Updated'}}},
 'relationships':[],'columnTypes':{'DM_AI_PM_Jira_Sample_Dataset.Updated':'date'},'measures':{}
}

def test_rolling_sales_dax_compiles():
    expr="""Sales_Last_3_Months_Excl_India =
VAR MaxSelectedDate = MAX ( Sales_Transactions[OrderDate] )
VAR StartDate = EDATE ( MaxSelectedDate, -3 ) + 1
RETURN
CALCULATE (
 SUM ( Sales_Transactions[SalesAmount] ),
 Sales_Transactions[Country] <> "India",
 DATESBETWEEN ( Sales_Transactions[OrderDate], StartDate, MaxSelectedDate )
)"""
    c=compile_dax(expr,SALES,[{'field':'Sales_Transactions.OrderDate','operator':'between','value':['2026-06-01','2026-08-31']}])
    assert 'FILTER (WHERE' in c.sql
    assert "'India'" in c.sql
    assert 'INTERVAL' in c.sql
    assert 'Sales_Transactions.OrderDate' in c.override_fields

def test_ai_jira_number_of_key():
    r=suggest_measure_from_prompt('Number of Key',JIRA)
    assert r['name']=='Distinct_Count_Key'
    assert 'DISTINCTCOUNT ( DM_AI_PM_Jira_Sample_Dataset[Key] )' in r['expression']
    assert 'COUNT(DISTINCT' in compile_dax(r['expression'],JIRA).sql

def test_ai_last_month_jira_count():
    r=suggest_measure_from_prompt('Last month number of Key using Updated',JIRA)
    assert 'EOMONTH' in r['expression']
    assert 'DATESBETWEEN' in r['expression']
    sql=compile_dax(r['expression'],JIRA).sql
    assert 'last_day' in sql and 'FILTER (WHERE' in sql

def test_more_dax_functions():
    assert 'MEDIAN' in compile_dax('Median_Story = MEDIAN ( DM_AI_PM_Jira_Sample_Dataset[Story Points] )',JIRA).sql
    assert 'AVG' in compile_dax('Avg_Story = AVERAGEX ( DM_AI_PM_Jira_Sample_Dataset, DM_AI_PM_Jira_Sample_Dataset[Story Points] )',JIRA).sql
    assert 'date_trunc' in compile_dax('YTD = TOTALYTD ( SUM ( DM_AI_PM_Jira_Sample_Dataset[Story Points] ), DM_AI_PM_Jira_Sample_Dataset[Updated] )',JIRA).sql
