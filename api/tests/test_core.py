import pytest
pytest.importorskip('duckdb')
from app.demo import seed,default_project
from app.semantic_engine import execute,measure
from app.transform_engine import preview,join_profile,ai_suggestions
from app.connectors import import_file
from app.server import append_imported_tables, AppendTablesReq

def pv(table,steps):
    rows,sql,cols,folding=preview(table,steps)
    return rows,sql,cols,folding

def test_measure_dependency():
    p=default_project();x=measure('Gross Margin %',p['model']);assert 'NULLIF' in x and 'SUM' in x

def test_semantic_query_real_db():
    seed();p=default_project();rows,sql=execute(p['model'],{'dimensions':['Region.Region'],'measures':['Revenue'],'limit':10},[]);assert rows and 'JOIN' in sql and 'SUM' in sql

def test_transform_filter_sort_type():
    seed();rows,sql,cols,fold=pv('FactSales',[{'type':'filter','field':'Revenue','operator':'gt','value':1000},{'type':'sort','field':'Revenue','direction':'desc'},{'type':'change_type','field':'Quantity','dataType':'text'}]);assert rows and 'WHERE' in sql and 'ORDER BY' in sql and 'Revenue' in cols and len(fold)==3

def test_file_import_and_join():
    seed();r=import_file('customers_test.csv',b'CustomerId,CustomerName,RegionId\n1,A,1\n2,B,2\n3,C,1\n');assert r['rows']==3
    rows,sql,cols,_=pv(r['table'],[{'type':'join','otherTable':'DimRegion','keys':[{'leftField':'RegionId','rightField':'RegionId'}],'joinType':'left'}]);assert rows and 'JOIN' in sql and 'RegionName' in cols

def test_split_merge_text_date_case_group():
    seed();r=import_file('transform_test.csv',b'Id,FullName,Amount,OrderDate\n1, John|Smith ,1200,07/08/2026\n2,Amy|Jones,800,08/08/2026\n3,Bob|Ray,150,09/08/2026\n')
    steps=[
      {'type':'text_transform','field':'FullName','operation':'trim'},
      {'type':'split_delimiter','field':'FullName','delimiter':'|','leftName':'FirstName','rightName':'LastName'},
      {'type':'merge_columns','fields':['FirstName','LastName'],'delimiter':' ','name':'DisplayName'},
      {'type':'date_parse','field':'OrderDate','format':'dd/mm/yyyy'},
      {'type':'date_part','field':'OrderDate','part':'year','name':'Year'},
      {'type':'conditional_column','name':'Segment','rules':[{'conditions':[{'field':'Amount','operator':'gte','value':1000}],'result':'High'}],'elseValue':'Standard'},
      {'type':'group_by','groupFields':['Segment'],'aggregations':[{'field':'Amount','aggregation':'sum','alias':'TotalAmount'},{'field':'Id','aggregation':'count','alias':'Rows'}]}
    ]
    rows,sql,cols,_=pv(r['table'],steps);assert rows and 'Segment' in cols and 'TotalAmount' in cols and 'CASE' in sql and 'GROUP BY' in sql

def test_join_profile_and_ai_suggestions():
    seed();p=join_profile('FactSales',[], 'DimRegion',[{'leftField':'RegionId','rightField':'RegionId'}]);assert p['matchRate']==100.0
    r=import_file('dirty.csv',b'Id,Name,OrderDate\n1, Alice ,2026-08-01\n2,,2026-08-02\n')
    s=ai_suggestions(r['table'],[]);titles=' '.join(x['title'] for x in s);assert 'Trim' in titles and 'Date' in titles

def test_folder_append_mixed_inferred_column_types():
    seed();a=import_file('mixed_a.csv',b'Id,DateValue\n1,2026-08-01\n');b=import_file('mixed_b.csv',b'Id,DateValue\n2,20260802\n')
    r=append_imported_tables(AppendTablesReq(tables=[a['table'],b['table']],name='Mixed_Folder',schemaMode='by_name',removeSources=False))
    assert r['rows']==2 and r['columns']==['Id','DateValue'] and any('mixed inferred types' in x for x in r['warnings'])
