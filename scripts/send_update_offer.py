#!/usr/bin/env python3
"""
send_update_offer.py - Notify the Services backend about a new deployment.
Used by deploy.sh after each git pull to show the update banner in the UI.

Usage: python3 send_update_offer.py [commit_sha]
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


def get_version() -> str:
    pkg = Path(__file__).resolve().parents[1] / "package.json"
    try:
        return json.loads(pkg.read_text(encoding="utf-8")).get("version", "unknown")
    except Exception:
        return os.environ.get("VTAB_RELEASE_VERSION", "unknown")


def get_commit(override: str | None = None) -> str:
    if override:
        return override.strip()
    env_sha = os.environ.get("VTAB_RELEASE_COMMIT_SHA", "").strip()
    if env_sha:
        return env_sha
    try:
        repo = Path(__file__).resolve().parents[1]
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True, timeout=8, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        return "unknown"


def send_offer(api_base: str, agent_token: str, version: str, commit_sha: str) -> dict:
    payload = json.dumps({
        "component": "reporting-services",
        "version": version,
        "commit_sha": commit_sha,
        "release_notes": f"VTAB Reporting Services {version} deployed to production. Commit: {commit_sha[:8]}.",
    }).encode("utf-8")

    request = urllib.request.Request(
        f"{api_base.rstrip('/')}/update/offer",
        data=payload,
        method="POST",
        headers={
            "X-VTAB-Agent-Token": agent_token,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    api_base = os.environ.get("VTAB_API_BASE", "https://reportservices.vtabsquare.com/api/v1")
    agent_token = os.environ.get("VTAB_AGENT_TOKEN", "SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y").strip()

    commit_sha = get_commit(sys.argv[1] if len(sys.argv) > 1 else None)
    version = get_version()

    print(f"Sending update offer: version={version}, commit={commit_sha[:12]}...")
    try:
        result = send_offer(api_base, agent_token, version, commit_sha)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        print(f"ERROR {exc.code}: {detail}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    update_available = result.get("update_available")
    status = result.get("status")
    print(f"OK: update_available={update_available}, status={status}, version={result.get('available_version')}")


if __name__ == "__main__":
    main()
