import os, sys, json
from pathlib import Path
root = Path(r"c:\Users\91733\Downloads\Reporting 14 10 26\Reporting Tool Services")
sys.path.insert(0, str(root))
from run_web_tool import read_env, WEB_ENV
os.environ.update(read_env(WEB_ENV))

sys.path.insert(0, str(root / "api"))
from app.supabase_store import _admin_client
sb = _admin_client()
res = sb.table('published_reports').select('project_json').eq('id', '4d64c75d-ee3f-45e2-bf5b-35aa5b764afe').limit(1).execute()
row = res.data[0]
pj = json.loads(row['project_json'])
p1 = pj['report']['pages'][0]
print('Page name:', p1.get('name'))
print('Page settings:', p1.get('settings'))
for v in p1.get('visuals', []):
    vid = v.get('id')
    vt = v.get('type')
    vtitle = v.get('title')
    vx, vy, vw, vh = v.get('x'), v.get('y'), v.get('w'), v.get('h')
    vz = v.get('zIndex')
    fmt = v.get('format', {})
    bg = fmt.get('background')
    bg_enabled = fmt.get('backgroundEnabled')
    text = v.get('text')
    print(f'{vid}: {vt} "{vtitle}" x={vx} y={vy} w={vw} h={vh} z={vz} bg={bg} bg_en={bg_enabled} text={repr(text)[:40]}')
