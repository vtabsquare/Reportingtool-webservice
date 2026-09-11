from __future__ import annotations
import sqlite3, json, uuid, time, hashlib, secrets, base64, os
from pathlib import Path

# Keep a source checkout self-contained. ``storage.py`` lives in api/app, so
# parents[2] is the Services project root. The previous parents[3] value wrote
# runtime state into the directory above the project and could reuse stale
# catalogs containing absolute paths from a different machine. Packaged
# Desktop builds still set VTAB_DATA_ROOT explicitly to their AppData folder.
ROOT = Path(os.environ.get('VTAB_DATA_ROOT') or Path(__file__).resolve().parents[2])
DATA = ROOT / 'data'
META = DATA / 'studio_meta.db'
DEMO = DATA / 'demo_sales.db'

def uid(): return str(uuid.uuid4())

def _is_secret_key(k:str)->bool:
    k=(k or '').lower()
    return any(x in k for x in ('password','secret','token','apikey','api_key','accesskey','privatekey','clientsecret'))

def _dpapi_protect(text:str)->str:
    if not text or os.name!='nt': return text
    try:
        import ctypes
        from ctypes import wintypes
        class DATA_BLOB(ctypes.Structure):
            _fields_=[('cbData',wintypes.DWORD),('pbData',ctypes.POINTER(ctypes.c_byte))]
        raw=text.encode('utf-8'); buf=ctypes.create_string_buffer(raw)
        inp=DATA_BLOB(len(raw),ctypes.cast(buf,ctypes.POINTER(ctypes.c_byte))); out=DATA_BLOB()
        if not ctypes.windll.crypt32.CryptProtectData(ctypes.byref(inp),'VTAB',None,None,None,0,ctypes.byref(out)):
            raise ctypes.WinError()
        data=ctypes.string_at(out.pbData,out.cbData); ctypes.windll.kernel32.LocalFree(out.pbData)
        return 'dpapi:'+base64.b64encode(data).decode('ascii')
    except Exception:
        return text

def _dpapi_unprotect(text:str)->str:
    if not isinstance(text,str) or not text.startswith('dpapi:') or os.name!='nt': return text
    try:
        import ctypes
        from ctypes import wintypes
        class DATA_BLOB(ctypes.Structure):
            _fields_=[('cbData',wintypes.DWORD),('pbData',ctypes.POINTER(ctypes.c_byte))]
        raw=base64.b64decode(text[6:]); buf=ctypes.create_string_buffer(raw)
        inp=DATA_BLOB(len(raw),ctypes.cast(buf,ctypes.POINTER(ctypes.c_byte))); out=DATA_BLOB()
        if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(inp),None,None,None,None,0,ctypes.byref(out)):
            raise ctypes.WinError()
        data=ctypes.string_at(out.pbData,out.cbData); ctypes.windll.kernel32.LocalFree(out.pbData)
        return data.decode('utf-8')
    except Exception:
        return text

def _protect_config(cfg:dict)->dict:
    return {k:(_dpapi_protect(str(v)) if _is_secret_key(k) and v not in (None,'') else v) for k,v in (cfg or {}).items()}

def _unprotect_config(cfg:dict)->dict:
    return {k:(_dpapi_unprotect(v) if _is_secret_key(k) else v) for k,v in (cfg or {}).items()}


class Store:
    def __init__(self):
        DATA.mkdir(parents=True, exist_ok=True); self.init()
    def conn(self):
        # Never delete/replace the metadata DB as a recovery mechanism. On Windows,
        # SQLite/AV/indexing processes may briefly retain a file handle. Use SQLite's
        # locking protocol with a generous busy timeout instead.
        c=sqlite3.connect(META, timeout=30.0)
        c.row_factory=sqlite3.Row
        c.execute("PRAGMA busy_timeout=30000")
        c.execute("PRAGMA foreign_keys=ON")
        try:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
        except sqlite3.OperationalError:
            # Another connection may be switching journal mode during startup.
            # busy_timeout still protects subsequent reads/writes.
            pass
        return c
    def init(self):
        last=None
        for attempt in range(6):
            try:
                with self.conn() as c:
                    c.executescript("""
                    CREATE TABLE IF NOT EXISTS projects(
                        id TEXT PRIMARY KEY,name TEXT,app_theme TEXT DEFAULT 'vtab',app_accent TEXT DEFAULT '#2563eb',ui_density TEXT DEFAULT 'comfortable',app_preferences_json TEXT DEFAULT '{}',model_json TEXT,report_json TEXT,transform_json TEXT,security_json TEXT
                    );
                    CREATE TABLE IF NOT EXISTS saved_reports(
                        id TEXT PRIMARY KEY,name TEXT NOT NULL,report_json TEXT NOT NULL,project_json TEXT,
                        created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE TABLE IF NOT EXISTS published_reports(
                        id TEXT PRIMARY KEY,name TEXT NOT NULL,project_json TEXT NOT NULL,
                        published_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,name TEXT,type TEXT,config_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
                    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,status TEXT DEFAULT 'active',password_hash TEXT,password_salt TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
                    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
                    CREATE TABLE IF NOT EXISTS workspace_memberships(workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
                    CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value_json TEXT);
                    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
                    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,action TEXT,details_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
                    """)
                    cols=[r[1] for r in c.execute("PRAGMA table_info(saved_reports)").fetchall()]
                    if 'project_json' not in cols: c.execute("ALTER TABLE saved_reports ADD COLUMN project_json TEXT")
                    pcols=[r[1] for r in c.execute("PRAGMA table_info(projects)").fetchall()]
                    if 'app_theme' not in pcols: c.execute("ALTER TABLE projects ADD COLUMN app_theme TEXT DEFAULT 'vtab'")
                    if 'app_accent' not in pcols: c.execute("ALTER TABLE projects ADD COLUMN app_accent TEXT DEFAULT '#2563eb'")
                    if 'security_json' not in pcols: c.execute("ALTER TABLE projects ADD COLUMN security_json TEXT DEFAULT '{\"roles\":[],\"activeRoleId\":null}'")
                    if 'ui_density' not in pcols: c.execute("ALTER TABLE projects ADD COLUMN ui_density TEXT DEFAULT 'comfortable'")
                    if 'app_preferences_json' not in pcols: c.execute("ALTER TABLE projects ADD COLUMN app_preferences_json TEXT DEFAULT '{}'")
                    ucols=[r[1] for r in c.execute("PRAGMA table_info(users)").fetchall()]
                    if 'password_hash' not in ucols: c.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
                    if 'password_salt' not in ucols: c.execute("ALTER TABLE users ADD COLUMN password_salt TEXT")
                    # Secure first-run bootstrap. A generic administrator is created only
                    # when the installation has no users. The password is PBKDF2-hashed,
                    # never stored in clear text. Administrators should change it after first login.
                    c.execute("INSERT INTO workspaces(id,name) VALUES('default','Default Workspace') ON CONFLICT(id) DO NOTHING")
                    user_count=c.execute('SELECT COUNT(*) FROM users').fetchone()[0]
                    if int(user_count or 0)==0:
                        admin_id='bootstrap-admin'
                        admin_email='admin@vtab.local'
                        admin_password='VTAB@Admin123!'
                        salt=base64.b64encode(secrets.token_bytes(16)).decode()
                        ph=hashlib.pbkdf2_hmac('sha256',admin_password.encode(),base64.b64decode(salt),200000).hex()
                        c.execute("INSERT INTO users(id,email,display_name,status,password_hash,password_salt) VALUES(?,?,?,?,?,?)",(admin_id,admin_email,'VTAB Administrator','active',ph,salt))
                        c.execute("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES('default',?,'Admin')",(admin_id,))
                    # Login is enabled by default for both authoring and Workspace. Preserve
                    # any explicit administrator settings on upgrades.
                    existing_setting=c.execute("SELECT value_json FROM app_settings WHERE key='workspace_email'").fetchone()
                    if not existing_setting:
                        c.execute("INSERT INTO app_settings(key,value_json) VALUES('workspace_email',?)",(json.dumps({'requireWorkspaceLogin':True,'requireAuthoringLogin':True,'workspaceBaseUrl':'http://127.0.0.1:5228/?workspace=1'}),))
                    else:
                        cfg=json.loads(existing_setting['value_json'] or '{}')
                        changed=False
                        if 'requireWorkspaceLogin' not in cfg: cfg['requireWorkspaceLogin']=True;changed=True
                        if 'requireAuthoringLogin' not in cfg: cfg['requireAuthoringLogin']=True;changed=True
                        if changed:c.execute("UPDATE app_settings SET value_json=? WHERE key='workspace_email'",(json.dumps(cfg),))
                return
            except sqlite3.OperationalError as exc:
                last=exc
                msg=str(exc).lower()
                if 'locked' not in msg and 'busy' not in msg:
                    raise
                time.sleep(0.25*(attempt+1))
        raise RuntimeError(f"Metadata database remained busy after retries: {last}")
    def get_project(self,pid='current'):
        with self.conn() as c:
            r=c.execute('SELECT * FROM projects WHERE id=?',(pid,)).fetchone()
            if not r:return None
            d=dict(r)
            for k in ['model_json','report_json','transform_json']:d[k[:-5]]=json.loads(d[k] or '{}')
            d['security']=json.loads(d.get('security_json') or '{"roles":[],"activeRoleId":null}')
            d['appTheme']=d.pop('app_theme',None) or 'vtab'
            d['appAccent']=d.pop('app_accent',None) or '#2563eb'
            d['uiDensity']=d.pop('ui_density',None) or 'comfortable'
            d['appPreferences']=json.loads(d.pop('app_preferences_json',None) or '{}')
            return d
    def save_project(self,p):
        with self.conn() as c:
            c.execute("""INSERT INTO projects(id,name,app_theme,app_accent,ui_density,app_preferences_json,model_json,report_json,transform_json,security_json) VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,app_theme=excluded.app_theme,app_accent=excluded.app_accent,ui_density=excluded.ui_density,app_preferences_json=excluded.app_preferences_json,model_json=excluded.model_json,report_json=excluded.report_json,transform_json=excluded.transform_json,security_json=excluded.security_json""",
            (p['id'],p['name'],p.get('appTheme','vtab'),p.get('appAccent','#2563eb'),p.get('uiDensity','comfortable'),json.dumps(p.get('appPreferences',{})),json.dumps(p.get('model',{})),json.dumps(p.get('report',{})),json.dumps(p.get('transform',{})),json.dumps(p.get('security',{'roles':[],'activeRoleId':None}))))
    def list_reports(self):
        with self.conn() as c:
            rows=c.execute('SELECT id,name,report_json,project_json,created_at,updated_at FROM saved_reports ORDER BY datetime(updated_at) DESC,name').fetchall();out=[]
            for r in rows:
                d=dict(r); report=json.loads(d.pop('report_json')); raw=d.pop('project_json',None); project=json.loads(raw) if raw else None; pages=report.get('pages',[])
                d.update(pages=len(pages),visuals=sum(len(p.get('visuals',[])) for p in pages),tables=len((project or {}).get('model',{}).get('tables',{})),queries=len((project or {}).get('transform',{}).get('queries',[])),report=report);out.append(d)
            return out
    def get_report(self,report_id):
        with self.conn() as c:
            r=c.execute('SELECT * FROM saved_reports WHERE id=?',(report_id,)).fetchone()
            if not r:return None
            d=dict(r);d['report']=json.loads(d.pop('report_json'));raw=d.pop('project_json',None);d['project']=json.loads(raw) if raw else None;return d
    def save_report(self,report,project=None):
        report_id=report.get('id') or uid();report['id']=report_id;name=(report.get('name') or 'Untitled Report').strip() or 'Untitled Report';report['name']=name;project_json=None
        if project is not None:
            snapshot=json.loads(json.dumps(project));snapshot['id']='current';snapshot['name']=name;snapshot['report']=report;project_json=json.dumps(snapshot)
        with self.conn() as c:
            c.execute("""INSERT INTO saved_reports(id,name,report_json,project_json,created_at,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,report_json=excluded.report_json,project_json=COALESCE(excluded.project_json,saved_reports.project_json),updated_at=CURRENT_TIMESTAMP""",
            (report_id,name,json.dumps(report),project_json))
        return self.get_report(report_id)
    def delete_report(self,report_id):
        with self.conn() as c:c.execute('DELETE FROM saved_reports WHERE id=?',(report_id,))
    def duplicate_report(self,report_id):
        source=self.get_report(report_id)
        if not source:return None
        report=json.loads(json.dumps(source['report']));report['id']=uid();report['name']=(report.get('name') or 'Report')+' Copy';project=json.loads(json.dumps(source.get('project'))) if source.get('project') else None
        if project:
            project['id']='current';project['name']=report['name'];project['report']=report
            if project.get('model'):project['model']['id']=uid();project['model']['name']=report['name']+' Semantic Model'
        return self.save_report(report,project)
    def rename_report(self,report_id,name):
        item=self.get_report(report_id)
        if not item:return None
        report=item['report'];report['name']=name;project=item.get('project')
        if project:project['name']=name;project['report']=report
        return self.save_report(report,project)
    def ensure_report_snapshot(self,report,project=None):
        if report and report.get('id') and not self.get_report(report['id']):self.save_report(report,project)
    def publish_project(self,project):
        snapshot=json.loads(json.dumps(project)); report=snapshot.get('report') or {}; rid=report.get('id') or uid(); report['id']=rid
        name=(report.get('name') or snapshot.get('name') or 'Untitled Report').strip() or 'Untitled Report'; report['name']=name; snapshot['report']=report; snapshot['name']=name
        with self.conn() as c:
            c.execute("""INSERT INTO published_reports(id,name,project_json,published_at,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,project_json=excluded.project_json,updated_at=CURRENT_TIMESTAMP""",(rid,name,json.dumps(snapshot)))
        return self.get_published(rid)
    def list_published(self):
        with self.conn() as c:
            rows=c.execute('SELECT id,name,project_json,published_at,updated_at FROM published_reports ORDER BY datetime(updated_at) DESC,name').fetchall();out=[]
            for r in rows:
                d=dict(r);p=json.loads(d.pop('project_json'));pages=p.get('report',{}).get('pages',[]);d.update(pages=len(pages),visuals=sum(len(x.get('visuals',[])) for x in pages),project=p);out.append(d)
            return out
    def get_published(self,report_id):
        with self.conn() as c:
            r=c.execute('SELECT * FROM published_reports WHERE id=?',(report_id,)).fetchone()
            if not r:return None
            d=dict(r);d['project']=json.loads(d.pop('project_json'));return d
    def unpublish(self,report_id):
        with self.conn() as c:c.execute('DELETE FROM published_reports WHERE id=?',(report_id,))
    def log(self,action,details):
        with self.conn() as c:c.execute('INSERT INTO audit(id,action,details_json) VALUES(?,?,?)',(uid(),action,json.dumps(details)))
    def audits(self):
        with self.conn() as c:return [dict(r) for r in c.execute('SELECT * FROM audit ORDER BY created_at DESC LIMIT 100')]

    def list_users(self):
        with self.conn() as c:
            rows=c.execute("SELECT u.*,m.workspace_id,m.role,w.name workspace_name FROM users u LEFT JOIN workspace_memberships m ON m.user_id=u.id LEFT JOIN workspaces w ON w.id=m.workspace_id ORDER BY u.display_name,u.email").fetchall()
            return [dict(r) for r in rows]
    def save_user(self,user):
        user_id=user.get('id') or uid(); email=(user.get('email') or '').strip().lower(); name=(user.get('displayName') or user.get('display_name') or '').strip() or email; status=user.get('status','active'); role=user.get('role','Viewer'); workspace_id=user.get('workspaceId') or 'default'; password=user.get('password') or ''
        if not email: raise ValueError('Email is required.')
        with self.conn() as c:
            c.execute("INSERT INTO workspaces(id,name) VALUES('default','Default Workspace') ON CONFLICT(id) DO NOTHING")
            
            existing=c.execute('SELECT password_hash,password_salt FROM users WHERE id=?',(user_id,)).fetchone()
            ph=existing['password_hash'] if existing else None; ps=existing['password_salt'] if existing else None
            if password:
                ps=base64.b64encode(secrets.token_bytes(16)).decode();ph=hashlib.pbkdf2_hmac('sha256',password.encode(),base64.b64decode(ps),200000).hex()
            c.execute("INSERT INTO users(id,email,display_name,status,password_hash,password_salt,created_at,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,status=excluded.status,password_hash=COALESCE(excluded.password_hash,users.password_hash),password_salt=COALESCE(excluded.password_salt,users.password_salt),updated_at=CURRENT_TIMESTAMP",(user_id,email,name,status,ph,ps))
            c.execute("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES(?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role",(workspace_id,user_id,role))
        return next((x for x in self.list_users() if x['id']==user_id),None)
    def delete_user(self,user_id):
        with self.conn() as c:
            c.execute('DELETE FROM workspace_memberships WHERE user_id=?',(user_id,));c.execute('DELETE FROM users WHERE id=?',(user_id,))
    def list_connections(self):
        with self.conn() as c:
            out=[]
            for r in c.execute('SELECT * FROM connections ORDER BY name').fetchall():
                d=dict(r); cfg=json.loads(d.pop('config_json') or '{}');
                for k in list(cfg):
                    if any(x in k.lower() for x in ('password','secret','token','key')) and cfg.get(k): cfg[k]='********'
                d['config']=cfg;out.append(d)
            return out
    def get_connection(self,connection_id):
        with self.conn() as c:
            r=c.execute('SELECT * FROM connections WHERE id=?',(connection_id,)).fetchone()
            if not r:return None
            d=dict(r);d['config']=_unprotect_config(json.loads(d.pop('config_json') or '{}'));return d
    def save_connection(self,item):
        cid=item.get('id') or uid(); name=(item.get('name') or 'Connection').strip(); typ=item.get('type') or 'demo'; cfg=dict(item.get('config') or {})
        existing=self.get_connection(cid)
        if existing:
            for k,v in list(cfg.items()):
                if v=='********': cfg[k]=existing.get('config',{}).get(k)
        with self.conn() as c:
            c.execute("INSERT INTO connections(id,name,type,config_json,created_at,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP",(cid,name,typ,json.dumps(_protect_config(cfg))))
        return self.get_connection(cid)
    def delete_connection(self,cid):
        with self.conn() as c:c.execute('DELETE FROM connections WHERE id=?',(cid,))
    def get_setting(self,key,default=None):
        with self.conn() as c:
            r=c.execute('SELECT value_json FROM app_settings WHERE key=?',(key,)).fetchone()
            return json.loads(r['value_json']) if r else default
    def set_setting(self,key,value):
        with self.conn() as c:c.execute('INSERT INTO app_settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',(key,json.dumps(value)))

    def authenticate(self,email,password):
        with self.conn() as c:
            r=c.execute("SELECT * FROM users WHERE lower(email)=lower(?) AND status='active'",((email or '').strip(),)).fetchone()
            if not r or not r['password_hash'] or not r['password_salt']: return None
            calc=hashlib.pbkdf2_hmac('sha256',(password or '').encode(),base64.b64decode(r['password_salt']),200000).hex()
            if not secrets.compare_digest(calc,r['password_hash']):return None
            memberships=c.execute('SELECT m.workspace_id,m.role,w.name workspace_name FROM workspace_memberships m LEFT JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=?',(r['id'],)).fetchall()
            return {'id':r['id'],'email':r['email'],'displayName':r['display_name'],'memberships':[dict(x) for x in memberships]}
    def create_session(self,user_id,hours=12):
        token=secrets.token_urlsafe(32);expires=int(time.time()+hours*3600)
        with self.conn() as c:c.execute('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)',(token,user_id,expires))
        return token
    def session_user(self,token):
        if not token:return None
        with self.conn() as c:
            r=c.execute("SELECT s.token,s.expires_at,u.id,u.email,u.display_name,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?",(token,)).fetchone()
            if not r or r['expires_at']<int(time.time()) or r['status']!='active':return None
            memberships=c.execute('SELECT m.workspace_id,m.role,w.name workspace_name FROM workspace_memberships m LEFT JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=?',(r['id'],)).fetchall()
            return {'id':r['id'],'email':r['email'],'displayName':r['display_name'],'memberships':[dict(x) for x in memberships]}
