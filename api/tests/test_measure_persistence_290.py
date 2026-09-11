import pytest
pytest.importorskip('duckdb')
from app.demo import default_project, blank_project
from app.server import store, save_measure, SaveMeasureReq


def test_sequential_measure_saves_preserve_prior_measures():
    original=store.get_project('current')
    try:
        p=default_project();p['id']='current';p['model']['measures']={}
        store.save_project(p)
        r1=save_measure(SaveMeasureReq(name='Measure_One',expression='SUM(Sales.Revenue)',originalName=None))
        assert set(r1['project']['model']['measures'])=={'Measure_One'}
        r2=save_measure(SaveMeasureReq(name='Measure_Two',expression='SUM(Sales.Cost)',originalName=None))
        assert set(r2['project']['model']['measures'])=={'Measure_One','Measure_Two'}
        r3=save_measure(SaveMeasureReq(name='Measure_Three',expression='[Measure_One]-[Measure_Two]',originalName=None))
        assert set(r3['project']['model']['measures'])=={'Measure_One','Measure_Two','Measure_Three'}
    finally:
        if original:store.save_project(original)
        else:store.save_project(blank_project('Untitled Report'))
