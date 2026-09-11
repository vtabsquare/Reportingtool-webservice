import pytest
pytest.importorskip('duckdb')
from app.demo import default_project
from app.semantic_engine import compile_query
from app.transform_engine import compile_steps

def test_date_hierarchy_virtual_fields_compile():
    model=default_project()['model']
    req={'dimensions':['Date.Date::year','Date.Date::quarter','Date.Date::month'],'measures':['Revenue'],'filters':[],'limit':50}
    sql,params=compile_query(model,req,[])
    assert 'year(' in sql
    assert "'Q'" in sql
    assert "strftime(" in sql and "'%Y-%m'" in sql
    assert params==[]

def test_bulk_change_type_compiles():
    sql,params,cols,folding=compile_steps('FactSales',[
        {'type':'source','id':'s1'},
        {'type':'bulk_change_type','id':'s2','mappings':[
            {'field':'Quantity','dataType':'integer'},
            {'field':'Revenue','dataType':'decimal'},
            {'field':'DateKey','dataType':'date'}
        ]}
    ],10)
    assert 'CAST("Quantity" AS INTEGER)' in sql
    assert 'CAST("Revenue" AS DOUBLE)' in sql
    assert 'TRY_CAST("DateKey" AS DATE)' in sql
