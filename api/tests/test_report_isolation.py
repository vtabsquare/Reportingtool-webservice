from app.demo import blank_project
from app.storage import Store

def test_blank_project_is_clean():
    p=blank_project('Finance Dashboard')
    assert p['model']['tables']=={}
    assert p['model']['measures']=={}
    assert p['model']['relationships']==[]
    assert p['transform']['queries']==[]
    assert p['security']['roles']==[]

def test_saved_report_has_full_project_snapshot():
    s=Store();p=blank_project('Isolated Report');p['model']['tables']['OnlyThisReport']={'physical':'DimRegion','x':1,'y':1,'columns':{'Region':'RegionName'}};p['transform']['queries'].append({'id':'q1','name':'Region Query','source':'DimRegion','steps':[{'id':'s','type':'source','label':'Source'}]});item=s.save_report(p['report'],p);loaded=s.get_report(item['id']);assert set(loaded['project']['model']['tables'])=={'OnlyThisReport'};assert loaded['project']['transform']['queries'][0]['name']=='Region Query'
