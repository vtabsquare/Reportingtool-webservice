from __future__ import annotations
import sqlite3, random, uuid
from datetime import date,timedelta
from .storage import DEMO, Store

def ensure_demo_db():
    if DEMO.exists(): return
    DEMO.parent.mkdir(parents=True, exist_ok=True)
    random.seed(42); c=sqlite3.connect(DEMO)
    c.executescript('''
    CREATE TABLE DimRegion(RegionId INTEGER PRIMARY KEY,RegionName TEXT);
    CREATE TABLE DimCustomer(CustomerId INTEGER PRIMARY KEY,CustomerName TEXT,RegionId INTEGER,Segment TEXT);
    CREATE TABLE DimProduct(ProductId INTEGER PRIMARY KEY,ProductName TEXT,Category TEXT);
    CREATE TABLE DimDate(DateKey TEXT PRIMARY KEY,Year INTEGER,Quarter TEXT,Month INTEGER,MonthName TEXT);
    CREATE TABLE FactSales(SaleId INTEGER PRIMARY KEY,DateKey TEXT,CustomerId INTEGER,ProductId INTEGER,RegionId INTEGER,Quantity INTEGER,Revenue REAL,Cost REAL,OrderId TEXT);
    ''')
    for i,r in enumerate(['North','South','East','West'],1):c.execute('INSERT INTO DimRegion VALUES(?,?)',(i,r))
    for i in range(1,61):c.execute('INSERT INTO DimCustomer VALUES(?,?,?,?)',(i,f'Customer {i:02d}',(i-1)%4+1,['Enterprise','Mid Market','SMB'][i%3]))
    cats=['Hardware','Software','Services','Accessories']
    for i in range(1,25):c.execute('INSERT INTO DimProduct VALUES(?,?,?)',(i,f'Product {i:02d}',cats[(i-1)%4]))
    start=date(2024,1,1)
    for d in range(950):
        dt=start+timedelta(days=d);c.execute('INSERT INTO DimDate VALUES(?,?,?,?,?)',(dt.isoformat(),dt.year,f'Q{(dt.month-1)//3+1}',dt.month,dt.strftime('%b')))
    sid=1
    for d in range(920):
        dt=start+timedelta(days=d)
        for _ in range(random.randint(6,14)):
            cust=random.randint(1,60); prod=random.randint(1,24); qty=random.randint(1,9); region=(cust-1)%4+1
            unit=random.uniform(80,950); rev=round(unit*qty*random.uniform(.9,1.08),2); cost=round(rev*random.uniform(.52,.78),2)
            c.execute('INSERT INTO FactSales VALUES(?,?,?,?,?,?,?,?,?)',(sid,dt.isoformat(),cust,prod,region,qty,rev,cost,f'ORD-{sid//2:06d}'));sid+=1
    c.commit();c.close()


def blank_project(report_name='Untitled Report'):
    report_id=str(uuid.uuid4())
    model_id=str(uuid.uuid4())
    page_id='page-1'
    return {
      'id':'current','name':report_name,
      'appTheme':'vtab',
      'appAccent':'#2563eb',
      'uiDensity':'comfortable',
      'model':{'id':model_id,'name':report_name+' Semantic Model','tables':{},'relationships':[],'columnTypes':{},'hierarchies':[],'measures':{}},
      'transform':{'queries':[]},
      'report':{'id':report_id,'name':report_name,'activePageId':page_id,'filters':[],'pages':[{'id':page_id,'name':'Page 1','visuals':[],'filters':[],'settings':{'background':'#081321','themeId':'vtab-midnight','pageWidth':1280,'pageHeight':720,'pageSizePreset':'16:9','showNavigation':True,'header':{'visible':True,'title':report_name,'subtitle':'Add a subtitle or reporting period','fontSize':28,'titleColor':'#f4f8ff','subtitleColor':'#8fa4bb','alignment':'left','background':'#0b1725'}}}]},
      'security':{'roles':[],'activeRoleId':None}
    }

def default_project():
    model={
      'id':'sales-model','name':'Sales Semantic Model','tables':{
       'Sales':{'physical':'FactSales','x':450,'y':260,'columns':{'Date':'DateKey','Customer Id':'CustomerId','Product Id':'ProductId','Region Id':'RegionId','Quantity':'Quantity','Revenue':'Revenue','Cost':'Cost','Order Id':'OrderId'}},
       'Customer':{'physical':'DimCustomer','x':70,'y':90,'columns':{'Customer Id':'CustomerId','Customer Name':'CustomerName','Region Id':'RegionId','Segment':'Segment'}},
       'Product':{'physical':'DimProduct','x':70,'y':470,'columns':{'Product Id':'ProductId','Product Name':'ProductName','Category':'Category'}},
       'Date':{'physical':'DimDate','x':850,'y':80,'columns':{'Date':'DateKey','Year':'Year','Quarter':'Quarter','Month':'Month','Month Name':'MonthName'}},
       'Region':{'physical':'DimRegion','x':870,'y':480,'columns':{'Region Id':'RegionId','Region':'RegionName'}}},
      'relationships':[
       {'id':'r1','fromTable':'Customer','fromColumn':'Customer Id','toTable':'Sales','toColumn':'Customer Id','cardinality':'1:*','filterDirection':'single','active':True},
       {'id':'r2','fromTable':'Product','fromColumn':'Product Id','toTable':'Sales','toColumn':'Product Id','cardinality':'1:*','filterDirection':'single','active':True},
       {'id':'r3','fromTable':'Date','fromColumn':'Date','toTable':'Sales','toColumn':'Date','cardinality':'1:*','filterDirection':'single','active':True},
       {'id':'r4','fromTable':'Region','fromColumn':'Region Id','toTable':'Sales','toColumn':'Region Id','cardinality':'1:*','filterDirection':'single','active':True}],
      'columnTypes':{
       'Sales.Date':'date','Date.Date':'date','Date.Year':'integer','Date.Quarter':'text','Date.Month':'integer','Date.Month Name':'text'
      },
      'hierarchies':[
       {'id':'date-default','name':'Date Hierarchy','table':'Date','sourceField':'Date.Date','auto':True,
        'levels':[
          {'name':'Year','field':'Date.Date::year'},
          {'name':'Quarter','field':'Date.Date::quarter'},
          {'name':'Month','field':'Date.Date::month'},
          {'name':'Week','field':'Date.Date::week'},
          {'name':'Day','field':'Date.Date::day'}
        ]}
      ],
      'measures':{
       'Revenue':'SUM(Sales.Revenue)','Cost':'SUM(Sales.Cost)','Gross Profit':'[Revenue]-[Cost]','Gross Margin %':'DIVIDE([Gross Profit],[Revenue])','Orders':'DISTINCTCOUNT(Sales.Order Id)','Customers':'DISTINCTCOUNT(Sales.Customer Id)','Average Order Value':'DIVIDE([Revenue],[Orders])'}
    }
    transform={'queries':[
      {'id':'q-sales','name':'Sales','source':'FactSales','steps':[{'id':'s1','type':'source','label':'Source: FactSales'},{'id':'s2','type':'filter','label':'Keep Revenue > 100','field':'Revenue','operator':'gt','value':100}]},
      {'id':'q-customer','name':'Customer','source':'DimCustomer','steps':[{'id':'s1','type':'source','label':'Source: DimCustomer'}]}]}
    report={'id':'executive','name':'Executive Sales','activePageId':'overview','pages':[
      {'id':'overview','name':'Executive Overview','visuals':[
       {'id':'v1','type':'kpi','title':'Revenue','x':0,'y':0,'w':3,'h':2,'bindings':{'values':['Revenue']},'format':{'accent':'#14b8a6','fontSize':34,'showTitle':True,'dataLabels':True,'fieldFormats':{'Revenue':{'style':'currency','currency':'USD','decimals':1,'displayUnits':'million','thousandsSeparator':True}}}},
       {'id':'v2','type':'kpi','title':'Gross Profit','x':3,'y':0,'w':3,'h':2,'bindings':{'values':['Gross Profit']},'format':{'accent':'#8b5cf6','fontSize':34,'showTitle':True,'dataLabels':True,'fieldFormats':{'Gross Profit':{'style':'currency','currency':'USD','decimals':1,'displayUnits':'million','thousandsSeparator':True}}}},
       {'id':'v3','type':'kpi','title':'Gross Margin %','x':6,'y':0,'w':3,'h':2,'bindings':{'values':['Gross Margin %']},'format':{'accent':'#38bdf8','fontSize':34,'showTitle':True,'dataLabels':True,'fieldFormats':{'Gross Margin %':{'style':'percentage','decimals':2,'displayUnits':'none'}}}},
       {'id':'v4','type':'line','title':'Revenue Trend','x':0,'y':2,'w':7,'h':5,'bindings':{'axis':['Date.Month Name'],'values':['Revenue']},'format':{'accent':'#2563eb','fontSize':12,'showTitle':True,'dataLabels':False,'fieldFormats':{'Revenue':{'style':'currency','currency':'USD','decimals':1,'displayUnits':'million','thousandsSeparator':True}}}},
       {'id':'v5','type':'bar','title':'Revenue by Region','x':7,'y':2,'w':5,'h':5,'bindings':{'axis':['Region.Region'],'values':['Revenue']},'format':{'accent':'#818cf8','fontSize':12,'showTitle':True,'dataLabels':True,'fieldFormats':{'Revenue':{'style':'currency','currency':'USD','decimals':1,'displayUnits':'million','thousandsSeparator':True}}}},
       {'id':'v6','type':'table','title':'Top Customers','x':0,'y':7,'w':12,'h':5,'bindings':{'axis':['Customer.Customer Name'],'values':['Revenue']},'format':{'accent':'#14b8a6','fontSize':12,'showTitle':True,'dataLabels':False,'fieldFormats':{'Revenue':{'style':'currency','currency':'USD','decimals':2,'displayUnits':'none','thousandsSeparator':True}}}}]},
      {'id':'products','name':'Product Analysis','visuals':[
       {'id':'p1','type':'donut','title':'Revenue Mix by Category','x':0,'y':0,'w':6,'h':6,'bindings':{'axis':['Product.Category'],'values':['Revenue']},'format':{'accent':'#2dd4bf','fontSize':12,'showTitle':True,'dataLabels':True,'fieldFormats':{'Revenue':{'style':'currency','currency':'USD','decimals':1,'displayUnits':'million','thousandsSeparator':True}}}},
       {'id':'p2','type':'bar','title':'Gross Profit by Category','x':6,'y':0,'w':6,'h':6,'bindings':{'axis':['Product.Category'],'values':['Gross Profit']},'format':{'accent':'#a78bfa','fontSize':12,'showTitle':True,'dataLabels':True,'fieldFormats':{'Gross Profit':{'style':'currency','currency':'USD','decimals':1,'displayUnits':'million','thousandsSeparator':True}}}}]}]}
    security={'roles':[{'id':'south-manager','name':'South Regional Manager','rules':[{'table':'Region','column':'Region','operator':'equals','value':'South'}]}],'activeRoleId':None}
    return {'id':'demo','name':'VTAB Sales Analytics','model':model,'transform':transform,'report':report,'security':security}

def seed():
    ensure_demo_db(); s=Store()
    if not s.get_project('current'):
        s.save_project(blank_project('Untitled Report'))
