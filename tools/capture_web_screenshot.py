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
    print("Session obtained successfully.")

    user_data_dir = os.path.join(os.environ.get("TEMP", "C:\\Temp"), "edge_cdp_profile")
    os.makedirs(user_data_dir, exist_ok=True)

    cmd = [
        EDGE_PATH,
        "--headless=new",
        "--remote-debugging-port=9222",
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
        # Wait for debugging port
        ws_url = None
        for _ in range(20):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen("http://127.0.0.1:9222/json") as r:
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

            # First navigate to origin so we can access localStorage
            print("Navigating to base URL to set localStorage...")
            await send_cmd("Page.navigate", {"url": "http://127.0.0.1:4173"})
            await asyncio.sleep(2)

            # Set localStorage
            script = f"""
            localStorage.setItem({json.dumps(auth_key)}, {json.dumps(session_json)});
            localStorage.setItem('vtab_supabase_token', {json.dumps(access_token)});
            localStorage.setItem('vtab_workspace_token', {json.dumps(access_token)});
            """
            await send_cmd("Runtime.evaluate", {"expression": script})
            print("localStorage set.")

            pages_to_test = [
                ("academic_summary", "page-1"),
                ("attendance", "page-1791800054751"),
                ("exam_performance", "page-1791800078344")
            ]
            for name, pid in pages_to_test:
                turl = f"http://127.0.0.1:4173/?workspace=1&report=e57899bd-e10b-4085-8710-5407e8cbb828&page={pid}"
                print(f"Navigating to {name} ({pid})...")
                await send_cmd("Page.navigate", {"url": turl})
                for _ in range(25):
                    await asyncio.sleep(1)
                    res = await send_cmd("Runtime.evaluate", {
                        "expression": "document.querySelectorAll('.viewerVisual').length"
                    })
                    count = res.get("value", 0) if res else 0
                    if count > 0:
                        print(f"Visuals found for {name}: {count}")
                        break
                await asyncio.sleep(4)
                shot = await send_cmd("Page.captureScreenshot", {"format": "png"})
                data = base64.b64decode(shot["data"])
                out = os.path.abspath(f"{name}_web_current.png")
                with open(out, "wb") as f:
                    f.write(data)
                print(f"Saved {name} to {out}")

    finally:
        proc.kill()

if __name__ == "__main__":
    asyncio.run(main())
