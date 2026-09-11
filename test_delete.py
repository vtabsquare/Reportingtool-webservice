import os
from supabase import create_client
def read_env(path):
    values = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line: continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("\"'")
    return values

env = read_env("web.env")
supabase = create_client(env["VITE_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
res = supabase.table("workspaces").delete().eq("name", "My Workspace").execute()
print(res)
