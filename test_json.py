import os
import asyncio
from dotenv import load_dotenv

load_dotenv('web.env')

from api.app.supabase_store import _admin_client

async def test():
    sb = _admin_client()
    try:
        res = sb.table('published_reports').select('project_json').limit(1).execute()
        val = res.data[0]['project_json']
        print("TYPE:", type(val))
        print("STARTS WITH:", repr(val[:20]))
    except Exception as e:
        print("ERROR:", e)

asyncio.run(test())
