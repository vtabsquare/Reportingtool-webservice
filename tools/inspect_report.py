import json
import urllib.request
import os

import sys
sys.path.insert(0, '.')
from run_web_tool import read_env, WEB_ENV

env = read_env(WEB_ENV)
url = env.get("VITE_SUPABASE_URL")
key = env.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("VITE_SUPABASE_ANON_KEY")

report_id = "e57899bd-e10b-4085-8710-5407e8cbb828"
req = urllib.request.Request(
    f"{url}/rest/v1/published_reports?id=eq.{report_id}&select=id,name,project_json",
    headers={"apikey": key, "Authorization": f"Bearer {key}"}
)

with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode())
    if not data:
        print("Report not found in published_reports")
    else:
        item = data[0]
        print("Report name:", item.get("name"))
        project = json.loads(item["project_json"])
        pages = project.get("report", {}).get("pages", [])
        print("Pages count:", len(pages))
        for p in pages:
            print(f"Page '{p.get('name')}', id: {p.get('id')}, visuals: {len(p.get('visuals', []))}")
            if "ATTENDANCE" in p.get("name", "").upper():
                print("Page settings:", p.get("settings"))
                for v in p.get("visuals", []):
                    fmt = v.get("format", {})
                    print(f"{v['id']} | type={v.get('type')} | x={v.get('x')} y={v.get('y')} w={v.get('w')} h={v.get('h')} z={v.get('zIndex')} | title='{v.get('title')}' | showTitle={fmt.get('showTitle')} | bg={fmt.get('background')} | border={fmt.get('borderVisible')}")

