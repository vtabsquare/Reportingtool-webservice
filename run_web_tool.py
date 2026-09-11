"""Build and run the VTAB Services website and API with one command."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
API_ROOT = ROOT / "api"
WEB_ENV = ROOT / "web.env"
DIST_WEB = ROOT / "dist-web"
RUNTIME_ROOT = Path(os.environ.get("LOCALAPPDATA", str(ROOT))) / "VTAB Reporting Studio" / "web-runtime"
VENV_ROOT = RUNTIME_ROOT / "python"
VENV_PYTHON = VENV_ROOT / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
DEPS_MARKER = RUNTIME_ROOT / "requirements.sha256"
REQUIRED_API_PATHS = {
    "/api/v1/service/publish-context",
    "/api/v1/service/workspaces/{workspace_id}/reports",
    "/api/v1/published/query-snapshot",
    "/api/v1/scheduler/preflight",
    "/api/v1/scheduler/discover-tables",
    "/api/v1/scheduler/jobs",
}


class SetupError(RuntimeError):
    pass


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"\'')
    return values


def has_placeholder(value: str) -> bool:
    upper = value.upper()
    return any(token in upper for token in ("REPLACE_WITH", "YOUR_PROJECT", "YOUR_SUPABASE", "CHANGE_ME"))


def ensure_local_encryption_key(values: dict[str, str]) -> None:
    """Create the local credential key on first run and persist it without printing it."""
    current = values.get("VTAB_CREDENTIAL_ENCRYPTION_KEY", "")
    if len(current) >= 32 and not has_placeholder(current):
        return
    generated = secrets.token_urlsafe(48)
    lines = WEB_ENV.read_text(encoding="utf-8-sig").splitlines() if WEB_ENV.is_file() else []
    replacement = f"VTAB_CREDENTIAL_ENCRYPTION_KEY={generated}"
    found = False
    updated: list[str] = []
    for line in lines:
        if line.strip().startswith("VTAB_CREDENTIAL_ENCRYPTION_KEY="):
            updated.append(replacement)
            found = True
        else:
            updated.append(line)
    if not found:
        updated.append(replacement)
    WEB_ENV.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    values["VTAB_CREDENTIAL_ENCRYPTION_KEY"] = generated
    print("Generated and securely saved the local refresh credential key in web.env.")


def validate(values: dict[str, str]) -> None:
    if not WEB_ENV.is_file():
        raise SetupError("web.env is missing. Restore it from web.env.example and enter your Supabase values.")
    url = values.get("VITE_SUPABASE_URL", "")
    anon = values.get("VITE_SUPABASE_ANON_KEY", "")
    service = values.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url.startswith("https://") or has_placeholder(url):
        raise SetupError("Open web.env and replace VITE_SUPABASE_URL with your Supabase Project URL.")
    if len(anon) < 40 or has_placeholder(anon):
        raise SetupError("Open web.env and replace VITE_SUPABASE_ANON_KEY with your public anon/publishable key.")
    if len(service) < 40 or has_placeholder(service):
        raise SetupError("Open web.env and replace SUPABASE_SERVICE_ROLE_KEY with the server-only service_role/secret key.")
    if anon == service:
        raise SetupError("The anon key and service_role key must be different Supabase keys.")
    encryption = values.get("VTAB_CREDENTIAL_ENCRYPTION_KEY", "")
    if len(encryption) < 32 or has_placeholder(encryption):
        raise SetupError(
            "Open web.env and set VTAB_CREDENTIAL_ENCRYPTION_KEY to a private random value of at least 32 characters. "
            "Generate one in PowerShell with: "
            "[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))"
        )
    if values.get("VITE_APP_MODE") != "WORKSPACE_ONLY":
        raise SetupError("Keep VITE_APP_MODE=WORKSPACE_ONLY in web.env.")
    api_port = int(values.get("VTAB_API_PORT", "8830"))
    if api_port == 8820:
        raise SetupError(
            "Port 8820 is reserved for VTAB Desktop. In web.env set VTAB_API_PORT=8830 "
            "and VITE_API_URL=http://127.0.0.1:8830/api/v1."
        )
    expected_api = f"http://127.0.0.1:{api_port}/api/v1"
    configured_api = values.get("VITE_API_URL", "").rstrip("/")
    if configured_api != expected_api:
        raise SetupError(f"In web.env set VITE_API_URL={expected_api} so the website uses its own Services API.")


def command(name: str) -> str:
    candidates = [name]
    if os.name == "nt" and not name.endswith(".cmd"):
        candidates.insert(0, name + ".cmd")
    for candidate in candidates:
        found = shutil.which(candidate)
        if found:
            return found
    raise SetupError(f"{name} was not found. Install Node.js 18 or newer and reopen the terminal.")


def run_checked(args: list[str], *, cwd: Path, env: dict[str, str]) -> None:
    print("> " + subprocess.list2cmdline(args), flush=True)
    result = subprocess.run(args, cwd=cwd, env=env, check=False)
    if result.returncode:
        raise SetupError(f"Command failed with exit code {result.returncode}: {subprocess.list2cmdline(args)}")


def prepare_frontend(env: dict[str, str]) -> None:
    npm = command("npm")
    vite = ROOT / "node_modules" / ".bin" / ("vite.cmd" if os.name == "nt" else "vite")
    if not vite.is_file():
        print("Installing website packages (first run only)...")
        run_checked([npm, "ci", "--no-audit", "--no-fund"], cwd=ROOT, env=env)
    print("Building the Services website...")
    run_checked([npm, "run", "build:web"], cwd=ROOT, env=env)
    if not (DIST_WEB / "index.html").is_file():
        raise SetupError("The Services website build did not create dist-web/index.html.")


def prepare_backend(env: dict[str, str]) -> None:
    requirements = API_ROOT / "requirements.txt"
    fingerprint = hashlib.sha256(requirements.read_bytes() + sys.version.encode()).hexdigest()
    ready = VENV_PYTHON.is_file() and DEPS_MARKER.is_file() and DEPS_MARKER.read_text(encoding="utf-8").strip() == fingerprint
    if ready:
        return
    print("Preparing the Services Python runtime (first run only)...")
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    if not VENV_PYTHON.is_file():
        run_checked([sys.executable, "-m", "venv", str(VENV_ROOT)], cwd=ROOT, env=env)
    run_checked([str(VENV_PYTHON), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(requirements)], cwd=ROOT, env=env)
    DEPS_MARKER.write_text(fingerprint, encoding="utf-8")


def source_version() -> str:
    try:
        return str(json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"])
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise SetupError(f"Could not read the Web Tool version from package.json: {error}")


def wait_for_api(url: str, process: subprocess.Popen, expected_version: str, timeout: float = 45) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise SetupError(f"The Services API stopped with exit code {process.returncode}.")
        try:
            with urllib.request.urlopen(url, timeout=1.0) as response:
                if response.status == 200:
                    payload = json.loads(response.read().decode("utf-8"))
                    running_version = str(payload.get("version") or "")
                    if running_version != expected_version:
                        raise SetupError(
                            f"The Services website is {expected_version}, but the API on this port is {running_version or 'unknown'}. "
                            "Stop the old Web Tool, copy all updated files, and run this file again."
                        )
                    return
        except SetupError:
            raise
        except (OSError, urllib.error.URLError):
            time.sleep(0.4)
    raise SetupError(f"The Services API did not become ready at {url}.")


def verify_api_contract(api_host: str, api_port: int) -> None:
    url = f"http://{api_host}:{api_port}/openapi.json"
    try:
        with urllib.request.urlopen(url, timeout=5.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise SetupError(f"Could not verify the Services API contract at {url}: {error}")
    available = set((payload.get("paths") or {}).keys())
    missing = sorted(REQUIRED_API_PATHS - available)
    if missing:
        raise SetupError(
            "The Services API is incomplete. These required routes are missing: " + ", ".join(missing) +
            ". Copy the complete current Web Tool update and start it again."
        )


class SpaHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST_WEB), **kwargs)

    def do_GET(self) -> None:
        relative = unquote(urlsplit(self.path).path).lstrip("/")
        requested = (DIST_WEB / relative).resolve()
        if not relative or DIST_WEB.resolve() not in requested.parents or not requested.is_file():
            self.path = "/index.html"
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> int:
    print("VTAB Services Web Tool - One-Command Local Runner")
    print(f"Source: {ROOT}\n")
    api_process: subprocess.Popen | None = None
    server: ThreadingHTTPServer | None = None
    try:
        values = read_env(WEB_ENV)
        ensure_local_encryption_key(values)
        validate(values)
        expected_version = source_version()
        env = os.environ.copy()
        env.update(values)
        env["VTAB_PRODUCT_VERSION"] = expected_version
        env.setdefault("VTAB_REFRESH_WORKER_ENABLED", "1")
        env.setdefault("VTAB_REFRESH_POLL_SECONDS", "30")
        api_host = values.get("VTAB_API_HOST", "127.0.0.1")
        api_port = int(values.get("VTAB_API_PORT", "8830"))
        web_host = values.get("VTAB_WEB_HOST", "127.0.0.1")
        web_port = int(values.get("VTAB_WEB_PORT", "4173"))
        env["PORT"] = str(api_port)
        env["VTAB_ALLOWED_ORIGINS"] = values.get("VTAB_ALLOWED_ORIGINS") or f"http://{web_host}:{web_port}"

        prepare_frontend(env)
        prepare_backend(env)

        print("Starting the Services API...")
        api_process = subprocess.Popen([str(VENV_PYTHON), "cloud_backend.py"], cwd=API_ROOT, env=env)
        health_url = f"http://{api_host}:{api_port}/api/v1/health"
        wait_for_api(health_url, api_process, expected_version)
        verify_api_contract(api_host, api_port)

        server = ThreadingHTTPServer((web_host, web_port), SpaHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        web_url = f"http://{web_host}:{web_port}"
        print("\nSERVICES WEB TOOL IS READY")
        print(f"Version: {expected_version}")
        print(f"Website: {web_url}")
        print(f"API health: {health_url}")
        print("Keep this window open. Press Ctrl+C to stop both services.\n")
        webbrowser.open(web_url)
        while api_process.poll() is None:
            time.sleep(0.5)
        raise SetupError(f"The Services API stopped with exit code {api_process.returncode}.")
    except KeyboardInterrupt:
        print("\nStopping VTAB Services...")
        return 0
    except (SetupError, OSError, ValueError) as error:
        print(f"\nSTART FAILED: {error}", file=sys.stderr)
        return 1
    finally:
        if server:
            server.shutdown()
            server.server_close()
        if api_process and api_process.poll() is None:
            api_process.terminate()
            try:
                api_process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                api_process.kill()


if __name__ == "__main__":
    raise SystemExit(main())
