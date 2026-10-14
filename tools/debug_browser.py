import asyncio
import base64
import json
import subprocess
import time
import urllib.request
import websockets
import os

from test_loading_animation import get_session, EDGE_PATH

async def main():
    print("Obtaining Supabase session...")
    session = get_session()
    access_token = session['access_token']
    auth_key = 'sb-asjscibujiikthxmpxgg-auth-token'
    session_json = json.dumps(session)

    user_data_dir = os.path.join(os.environ.get('TEMP', 'C:\\Temp'), 'edge_cdp_profile_render')
    os.makedirs(user_data_dir, exist_ok=True)

    cmd = [
        EDGE_PATH,
        '--headless=new',
        '--remote-debugging-port=9226',
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        f'--user-data-dir={user_data_dir}',
        '--window-size=1920,1080',
        'about:blank'
    ]
    proc = subprocess.Popen(cmd)
    try:
        ws_url = None
        for _ in range(20):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen('http://127.0.0.1:9226/json') as r:
                    tabs = json.loads(r.read().decode())
                    pages = [t for t in tabs if t.get('type') == 'page' and not t.get('url', '').startswith('edge://')]
                    if pages:
                        ws_url = pages[0].get('webSocketDebuggerUrl')
                        break
            except Exception:
                pass
        
        async with websockets.connect(ws_url, max_size=50*1024*1024) as ws:
            msg_id = 0
            async def send_cmd(method, params=None):
                nonlocal msg_id
                msg_id += 1
                payload = {'id': msg_id, 'method': method, 'params': params or {}}
                await ws.send(json.dumps(payload))
                while True:
                    res = json.loads(await ws.recv())
                    if res.get('id') == payload['id']:
                        return res.get('result')

            await send_cmd('Page.enable')
            await send_cmd('Runtime.enable')

            await send_cmd('Page.navigate', {'url': 'http://127.0.0.1:4173'})
            await asyncio.sleep(1.0)

            script = f"""
            localStorage.setItem({json.dumps(auth_key)}, {json.dumps(session_json)});
            localStorage.setItem('vtab_supabase_token', {json.dumps(access_token)});
            localStorage.setItem('vtab_workspace_token', {json.dumps(access_token)});
            """
            await send_cmd('Runtime.evaluate', {'expression': script})

            target_url = 'http://127.0.0.1:4173/?workspace=1b2ff1db-3c64-4817-a5c3-a9f1a1422f32&report=d8690833-2e4c-445c-b814-de3c15ddd341&page=page-1'
            print('Navigating to target...')
            await send_cmd('Page.navigate', {'url': target_url})

            # Wait for report and visuals to appear
            print('Waiting for visuals to appear...')
            visuals_appeared = False
            for i in range(30):
                await asyncio.sleep(1.0)
                res = await send_cmd('Runtime.evaluate', {
                    'expression': 'document.querySelectorAll(".viewerVisual").length',
                    'returnByValue': True
                })
                count = res.get('result', {}).get('value', 0) if res else 0
                if count > 0:
                    print(f'Visuals appeared: {count} visuals in DOM after {i+1}s')
                    visuals_appeared = True
                    break

            if not visuals_appeared:
                print('Visuals did not appear within 30s!')

            # Now wait for visualLoading to finish
            print('Waiting for visualLoading to finish...')
            for i in range(30):
                await asyncio.sleep(1.0)
                res = await send_cmd('Runtime.evaluate', {
                    'expression': """(() => {
                        const loading = document.querySelectorAll('.viewerVisualLoading');
                        const notice = document.querySelector('.viewerPageLoadNotice');
                        return { loadingCount: loading.length, hasNotice: !!notice };
                    })()""",
                    'returnByValue': True
                })
                val = res.get('result', {}).get('value', {}) if res else {}
                print(f'[{i+1}s] Loading count: {val.get("loadingCount")}, hasNotice: {val.get("hasNotice")}')
                if val.get('loadingCount') == 0 and not val.get('hasNotice'):
                    print('All visuals finished loading!')
                    break

            await asyncio.sleep(2.5)

            shot = await send_cmd('Page.captureScreenshot', {'format': 'png'})
            with open('report_fully_loaded_verified.png', 'wb') as f:
                f.write(base64.b64decode(shot['data']))
            print('Saved report_fully_loaded_verified.png')

    finally:
        proc.kill()

if __name__ == '__main__':
    asyncio.run(main())
