import asyncio
import base64
import json
import subprocess
import time
import urllib.request
import websockets
import os
import sys

EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
URL_SUPABASE = "https://asjscibujiikthxmpxgg.supabase.co"
SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzanNjaWJ1amlpa3RoeG1weGdnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Nzg5ODkwMiwiZXhwIjoyMTAzNDc0OTAyfQ.qVZXwNUJdG-fRuS8g2_gn5tJMIn3qxyZAXmHnbzosAA"
ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzanNjaWJ1amlpa3RoeG1weGdnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4OTg5MDIsImV4cCI6MjEwMzQ3NDkwMn0._ruAu1DRXerWX5kCUYOyaOFmNclIB0TZoZXTiMotQMM"
USER_EMAIL = "mohamedyasin.vtab@gmail.com"

def get_session():
    # 1. Generate OTP
    req = urllib.request.Request(
        f"{URL_SUPABASE}/auth/v1/admin/generate_link",
        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"},
        data=json.dumps({"type": "magiclink", "email": USER_EMAIL}).encode()
    )
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode())
        otp = res.get("email_otp")
    
    # 2. Verify OTP
    req = urllib.request.Request(
        f"{URL_SUPABASE}/auth/v1/verify",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        data=json.dumps({"type": "magiclink", "token": otp, "email": USER_EMAIL}).encode()
    )
    with urllib.request.urlopen(req) as resp:
        session = json.loads(resp.read().decode())
    return session

async def main():
    print("Obtaining Supabase session...")
    session = get_session()
    access_token = session["access_token"]
    auth_key = "sb-asjscibujiikthxmpxgg-auth-token"
    session_json = json.dumps(session)

    user_data_dir = os.path.join(os.environ.get("TEMP", "C:\\Temp"), "edge_cdp_profile_load2")
    os.makedirs(user_data_dir, exist_ok=True)

    cmd = [
        EDGE_PATH,
        "--headless=new",
        "--remote-debugging-port=9224",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        f"--user-data-dir={user_data_dir}",
        "--window-size=1920,1080",
        "about:blank"
    ]
    proc = subprocess.Popen(cmd)
    try:
        ws_url = None
        for _ in range(20):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen("http://127.0.0.1:9224/json") as r:
                    tabs = json.loads(r.read().decode())
                    pages = [t for t in tabs if t.get("type") == "page" and not t.get("url", "").startswith("edge://")]
                    if pages:
                        ws_url = pages[0].get("webSocketDebuggerUrl")
                        break
            except Exception:
                pass
        
        if not ws_url:
            raise RuntimeError("Could not connect to Edge DevTools")

        print("Connecting to Edge CDP at", ws_url)
        async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
            msg_id = 0
            async def send_cmd(method, params=None):
                nonlocal msg_id
                msg_id += 1
                payload = {"id": msg_id, "method": method, "params": params or {}}
                await ws.send(json.dumps(payload))
                while True:
                    res = json.loads(await ws.recv())
                    if res.get("id") == payload["id"]:
                        return res.get("result")

            await send_cmd("Page.enable")
            await send_cmd("Runtime.enable")

            # Navigate to origin so we can set localStorage
            await send_cmd("Page.navigate", {"url": "http://127.0.0.1:4173"})
            await asyncio.sleep(1.5)

            script = f"""
            localStorage.setItem({json.dumps(auth_key)}, {json.dumps(session_json)});
            localStorage.setItem('vtab_supabase_token', {json.dumps(access_token)});
            localStorage.setItem('vtab_workspace_token', {json.dumps(access_token)});
            """
            await send_cmd("Runtime.evaluate", {"expression": script})

            target_url = "http://127.0.0.1:4173/?workspace=1b2ff1db-3c64-4817-a5c3-a9f1a1422f32&report=d8690833-2e4c-445c-b814-de3c15ddd341&page=page-1"
            print("Navigating to report development page-1 (normal load)...")
            await send_cmd("Page.navigate", {"url": target_url})

            # Wait for data to render completely
            print("Waiting for visuals to complete rendering...")
            for i in range(30):
                await asyncio.sleep(1.0)
                res = await send_cmd("Runtime.evaluate", {
                    "expression": """(() => {
                        const loadingVisuals = document.querySelectorAll('.viewerVisualLoading');
                        const notice = document.querySelector('.viewerPageLoadNotice');
                        const visuals = document.querySelectorAll('.viewerVisual');
                        return {
                            visualCount: visuals.length,
                            loadingCount: loadingVisuals.length,
                            hasNotice: !!notice
                        };
                    })()""",
                    "returnByValue": True
                })
                val = res.get("result", {}).get("value", {}) if res else {}
                print(f"[{i}s] Visuals: {val.get('visualCount')}, Loading: {val.get('loadingCount')}, Notice: {val.get('hasNotice')}")
                if val.get("visualCount", 0) > 0 and val.get("loadingCount", 1) == 0 and not val.get("hasNotice"):
                    print("All visuals and data loaded completely!")
                    break

            await asyncio.sleep(2.0)
            shot_loaded = await send_cmd("Page.captureScreenshot", {"format": "png"})
            with open("report_loaded_state.png", "wb") as f:
                f.write(base64.b64decode(shot_loaded["data"]))
            print("Saved updated report_loaded_state.png")

    finally:
        proc.kill()

if __name__ == "__main__":
    asyncio.run(main())
