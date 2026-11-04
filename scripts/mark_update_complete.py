#!/usr/bin/env python3
"""
mark_update_complete.py - Notify Services backend that deployment is complete,
clearing the update banner automatically.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request


def main() -> None:
    api_base = os.environ.get("VTAB_API_BASE", "https://reportservices.vtabsquare.com/api/v1")
    agent_token = os.environ.get("VTAB_AGENT_TOKEN", "SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y").strip()
    commit_sha = sys.argv[1] if len(sys.argv) > 1 else None

    payload = json.dumps({"commit_sha": commit_sha}).encode("utf-8")
    req = urllib.request.Request(
        f"{api_base.rstrip('/')}/update/complete",
        data=payload,
        method="POST",
        headers={
            "X-VTAB-Agent-Token": agent_token,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            res = json.loads(r.read().decode("utf-8"))
            print(f"Update marked complete: update_available={res.get('update_available')}, status={res.get('status')}")
    except Exception as e:
        print(f"Notice: could not mark update complete: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
