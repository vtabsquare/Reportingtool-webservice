import json
from pathlib import Path

import pandas as pd
import pytest

from app import connectors


def test_nested_json_is_flattened(tmp_path: Path):
    source=tmp_path/'nested.json'
    source.write_text(json.dumps({'records':[{'id':1,'customer':{'name':'A'},'tags':['new','vip']}]}),encoding='utf-8')
    frame=connectors._json_frame(source)
    assert list(frame.columns)==['id','tags','customer.name']
    assert frame.loc[0,'customer.name']=='A'
    assert json.loads(frame.loc[0,'tags'])==['new','vip']


def test_xml_attributes_and_nested_values_are_flattened(tmp_path: Path):
    source=tmp_path/'orders.xml'
    source.write_text('<orders><order id="10"><customer><name>Ada</name></customer><amount>42</amount></order><order id="11"><customer><name>Lin</name></customer><amount>12</amount></order></orders>',encoding='utf-8')
    frame=connectors._xml_frame(source)
    assert list(frame['@id'])==['10','11']
    assert list(frame['customer.name'])==['Ada','Lin']


def test_excel_sheet_discovery_and_selected_sheet(tmp_path: Path,monkeypatch):
    source=tmp_path/'book.xlsx'
    with pd.ExcelWriter(source,engine='openpyxl') as writer:
        pd.DataFrame({'A':[1]}).to_excel(writer,sheet_name='Summary',index=False)
        pd.DataFrame({'B':[2,3]}).to_excel(writer,sheet_name='Transactions',index=False)
    sheets=connectors.workbook_sheets(source)
    assert [s['name'] for s in sheets]==['Summary','Transactions']
    assert sheets[1]['cols']==1 and sheets[1]['fields']==['B']
    captured={}
    monkeypatch.setattr(connectors,'write_dataframe',lambda df,*args,**kwargs: captured.setdefault('rows',len(df)))
    monkeypatch.setattr(connectors,'local_metadata',lambda:[{'name':'Imported_book_Transactions','columns':[{'name':'B'}],'storage':{}}])
    result=connectors.import_file_path('book.xlsx',source,'Transactions')
    assert result['sheet']=='Transactions' and result['rows']==2
    assert result['table']=='Imported_book_Transactions' and result['displayName']=='Transactions'


def test_database_query_guard_is_read_only():
    assert connectors._safe_select('WITH q AS (SELECT 1 AS x) SELECT * FROM q').startswith('WITH')
    with pytest.raises(ValueError):connectors._safe_select('DELETE FROM customers')
    with pytest.raises(ValueError):connectors._safe_select('SELECT 1; DROP TABLE customers')


def test_microsoft_shared_link_uses_graph_when_token_is_supplied():
    url=connectors._microsoft_download_url('sharepoint','https://tenant.sharepoint.com/:x:/r/sites/Finance/file.xlsx','token')
    assert url.startswith('https://graph.microsoft.com/v1.0/shares/u!') and url.endswith('/driveItem/content')
