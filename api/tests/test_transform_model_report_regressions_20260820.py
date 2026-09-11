from copy import deepcopy
from pathlib import Path

from app import server
from app.connectors import friendly_table_name
from app.demo import blank_project


def _meta(name, columns):
    return {'name': name, 'columns': [{'name': c, 'type': 'VARCHAR'} for c in columns]}


def test_friendly_import_names_are_concise_and_distinct():
    assert friendly_table_name('Imported_SalesData_1000') == 'SalesData'
    assert friendly_table_name('Imported_Customers') == 'Customers'
    assert friendly_table_name('Imported_Products') == 'Products'
    assert len({
        friendly_table_name('Imported_SalesData_1000'),
        friendly_table_name('Imported_Customers'),
        friendly_table_name('Imported_Products'),
    }) == 3


def test_transform_source_registration_reuses_only_same_physical_table(monkeypatch):
    p = blank_project('Regression')
    metadata = [
        _meta('Imported_SalesData_1000', ['SalesID', 'CustomerID', 'ProductID', 'NetSales']),
        _meta('Imported_Customers', ['CustomerID', 'CustomerName']),
        _meta('Imported_Products', ['ProductID', 'ProductName']),
    ]
    monkeypatch.setattr(server, 'project', lambda: p)
    monkeypatch.setattr(server, 'demo_metadata', lambda: metadata)
    monkeypatch.setattr(server.store, 'save_project', lambda project: None)
    monkeypatch.setattr(server.store, 'log', lambda *args, **kwargs: None)

    first = server.add_transform_source(server.AddTransformSourceReq(physicalTable='Imported_SalesData_1000', queryName='SalesData_1000'))
    second = server.add_transform_source(server.AddTransformSourceReq(physicalTable='Imported_Customers', queryName='Customers'))
    third = server.add_transform_source(server.AddTransformSourceReq(physicalTable='Imported_Products', queryName='Products'))
    repeat = server.add_transform_source(server.AddTransformSourceReq(physicalTable='Imported_SalesData_1000', queryName='SalesData_1000'))

    assert [q['name'] for q in p['transform']['queries']] == ['SalesData', 'Customers', 'Products']
    assert [q['source'] for q in p['transform']['queries']] == ['Imported_SalesData_1000', 'Imported_Customers', 'Imported_Products']
    assert len(p['transform']['queries']) == 3
    assert first['queryId'] == repeat['queryId']
    assert repeat['existing'] is True
    assert second['queryName'] == 'Customers'
    assert third['queryName'] == 'Products'


def test_model_registration_repairs_duplicate_aliases_and_auto_builds_sales_relationships(monkeypatch):
    p = blank_project('Regression')
    p['model']['tables'] = {
        # Simulate stale aliases created by the buggy build: two semantic nodes for the same source.
        'SalesData_1000': {'physical': 'ETL_SalesData', 'x': 10, 'y': 10, 'columns': {'SalesID':'SalesID','CustomerID':'CustomerID','ProductID':'ProductID','NetSales':'NetSales'}},
        'SalesData Copy': {'physical': 'ETL_SalesData', 'x': 20, 'y': 20, 'columns': {'SalesID':'SalesID','CustomerID':'CustomerID','ProductID':'ProductID','NetSales':'NetSales'}},
    }
    metadata = [
        _meta('ETL_SalesData', ['SalesID', 'CustomerID', 'ProductID', 'NetSales']),
        _meta('ETL_Customers', ['CustomerID', 'CustomerName', 'Segment']),
        _meta('ETL_Products', ['ProductID', 'ProductName', 'Category']),
    ]
    monkeypatch.setattr(server, 'project', lambda: p)
    monkeypatch.setattr(server, 'demo_metadata', lambda: metadata)
    monkeypatch.setattr(server.store, 'save_project', lambda project: None)
    monkeypatch.setattr(server, 'clear_cache', lambda: None)
    monkeypatch.setattr(server, '_ensure_model_hierarchies', lambda project: project)

    server.add_model_table(server.AddModelTableReq(physicalTable='ETL_SalesData', semanticName='SalesData_1000'))
    customer_result = server.add_model_table(server.AddModelTableReq(physicalTable='ETL_Customers', semanticName='Customers'))
    product_result = server.add_model_table(server.AddModelTableReq(physicalTable='ETL_Products', semanticName='Products'))

    assert list(p['model']['tables'].keys()) == ['SalesData', 'Customers', 'Products']
    assert len({t['physical'] for t in p['model']['tables'].values()}) == 3
    assert p['model']['tables']['SalesData']['physical'] == 'ETL_SalesData'
    assert p['model']['tables']['Customers']['physical'] == 'ETL_Customers'
    assert p['model']['tables']['Products']['physical'] == 'ETL_Products'

    rels = p['model']['relationships']
    pairs = {(r['fromTable'], r['fromColumn'], r['toTable'], r['toColumn']) for r in rels}
    assert ('Customers', 'CustomerID', 'SalesData', 'CustomerID') in pairs
    assert ('Products', 'ProductID', 'SalesData', 'ProductID') in pairs
    assert len(rels) == 2
    assert all(r['cardinality'] == '1:*' and r['filterDirection'] == 'single' and r['active'] for r in rels)
    assert len(customer_result['relationshipsAdded']) == 1
    assert len(product_result['relationshipsAdded']) == 1


def test_frontend_contains_stale_preview_guard_compact_queries_and_report_pane_controls():
    root = Path(__file__).resolve().parents[2]
    transform = (root / 'src/v11/TransformWorkbench.tsx').read_text(encoding='utf-8')
    report = (root / 'src/v11/ReportWorkbench.tsx').read_text(encoding='utf-8')
    css = (root / 'src/styles.css').read_text(encoding='utf-8')

    # The active query preview must reject late responses from a previously selected table.
    assert 'previewSeqRef' in transform
    assert 'requestId!==previewSeqRef.current' in transform
    assert 'compactQueryName' in transform and 'queryTextGlass' in transform

    # Report authoring must expose direct pane controls and independently scroll properties.
    assert 'Focus Canvas' in report
    assert 'Properties' in report
    assert 'paneQuickToggle' in report
    assert 'collapsedDockTab' in report
    assert '.view-report .professionalRightPane' in css
    assert 'overflow-y:auto!important' in css
    assert 'padding-bottom:72px!important' in css
