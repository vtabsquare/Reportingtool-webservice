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
supabase = create_client(env["VITE_SUPABASE_URL"], env["VITE_SUPABASE_ANON_KEY"])
res = supabase.table("published_reports").select("*").eq("id", "22192b62-b020-4fe4-a991-79ce2e2cbcb4").execute()
print(res.data[0].keys())
