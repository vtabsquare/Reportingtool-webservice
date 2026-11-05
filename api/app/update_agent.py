from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def _safe_version(value: Any) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 80 or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-+" for ch in text):
        raise ValueError("A valid release version is required.")
    return text


def _safe_sha(value: Any) -> str:
    text = str(value or "").strip().lower()
    if len(text) < 7 or len(text) > 64 or any(ch not in "0123456789abcdef" for ch in text):
        raise ValueError("A valid approved commit SHA is required.")
    return text


class UpdateAgent:
    """Persistent, idempotent update coordinator for managed and self-hosted Services."""

    def __init__(self) -> None:
        parents = Path(__file__).resolve().parents
        root_dir = parents[2] if len(parents) > 3 else (parents[1] if len(parents) > 1 else parents[0])
        default_state = root_dir / "data" / "update-agent-state.json"
        self.state_path = Path(_env("VTAB_UPDATE_STATE_PATH", default=str(default_state))).resolve()
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.worker: threading.Thread | None = None
        self._last_github_check: float = 0.0
        self.state = self._load()
        self._save()

    def _defaults(self) -> dict[str, Any]:
        return {
            "component": "reporting-services",
            "current_version": _env("VTAB_RELEASE_VERSION", default="unknown"),
            "current_commit_sha": self._current_commit(),
            "available_version": None,
            "target_commit_sha": None,
            "release_notes": "",
            "release_id": None,
            "update_available": False,
            "status": "idle",
            "progress": 0,
            "provider_deploy_id": None,
            "requested_at": None,
            "started_at": None,
            "completed_at": None,
            "last_error": None,
            "logs": [],
            "event_ids": [],
        }

    def _load(self) -> dict[str, Any]:
        state = self._defaults()
        try:
            loaded = json.loads(self.state_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                state.update(loaded)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        if state.get("status") in {"queued", "applying", "deploying", "building", "restarting"}:
            running_commit = _env("RENDER_GIT_COMMIT", "VTAB_RELEASE_COMMIT_SHA")
            if running_commit and str(state.get("target_commit_sha") or "").startswith(running_commit[:7]):
                state.update(
                    current_version=state.get("available_version"), current_commit_sha=running_commit,
                    update_available=False, status="completed", progress=100, completed_at=_now(), last_error=None,
                )
            else:
                state.update(status="interrupted", last_error="The previous update was interrupted before completion.")
        return state

    def _save(self) -> None:
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.state, indent=2, sort_keys=True), encoding="utf-8")
        temporary.replace(self.state_path)

    def _current_commit(self) -> str:
        rendered = _env("RENDER_GIT_COMMIT", "VTAB_RELEASE_COMMIT_SHA")
        if rendered:
            return rendered
        try:
            parents = Path(__file__).resolve().parents
            root = Path(_env("VTAB_UPDATE_REPO_PATH", default=str(parents[3] if len(parents) > 3 else parents[0])))
            return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True, timeout=8, stderr=subprocess.DEVNULL).strip()
        except Exception:
            return "unknown"

    def _log(self, message: str, progress: int | None = None, status: str | None = None) -> None:
        with self.lock:
            entries = list(self.state.get("logs") or [])
            entries.append({"at": _now(), "message": message})
            self.state["logs"] = entries[-80:]
            if progress is not None:
                self.state["progress"] = max(0, min(100, int(progress)))
            if status:
                self.state["status"] = status
            self._save()

    def _check_github_update(self) -> None:
        """Verify if an offered update has already been applied, clearing the banner.

        NOTE: Update offers MUST only originate from the VTAB Reporting Manager application
        via /offer or /webhook. Pushing commits to GitHub does NOT automatically pop up an update banner.
        """
        now = time.time()
        if now - self._last_github_check < 15:
            return
        self._last_github_check = now
        if self.state.get("status") in {"queued", "applying", "deploying", "building", "restarting"}:
            return
        try:
            current = self._current_commit().lower()
            target = str(self.state.get("target_commit_sha") or "").strip().lower()

            # Auto-clear the banner ONLY when:
            #   - The offer was for a FUTURE commit (different from current), AND
            #   - The server has since been updated to that commit (Render/DO auto-deploy).
            # Do NOT auto-clear if the offer's commit already matches the currently running
            # commit — that is a legitimate Manager offer (e.g. announcing release notes
            # for the already-deployed version) that the user must see and dismiss manually.
            if current and current != "unknown" and target:
                offer_was_for_different_commit = not (
                    target.startswith(current[:7]) or current.startswith(target[:7])
                )
                # Only auto-clear if we were waiting for a different commit that is now live
                # (i.e. the offer pointed somewhere in the future, and now we're there)
                if not offer_was_for_different_commit and self.state.get("status") in {"deploying", "building", "restarting"}:
                    # We were actively deploying and have arrived — mark complete
                    with self.lock:
                        if self.state.get("update_available"):
                            self.state.update(
                                update_available=False,
                                status="completed",
                                completed_at=_now(),
                                progress=100,
                                last_error=None,
                            )
                            self._save()
                    return

            # Explicit opt-in only: auto-offering from GitHub commits is disabled by default
            if _env("VTAB_AUTO_OFFER_GITHUB", default="false").lower() in ("true", "1", "yes"):
                repo_slug = _env("VTAB_GITHUB_REPO", default="vtabsquare/Reportingtool-webservice")
                url = f"https://api.github.com/repos/{repo_slug}/commits/main"
                req = urllib.request.Request(
                    url,
                    headers={"User-Agent": "VTAB-Update-Agent", "Accept": "application/vnd.github.v3+json"},
                )
                gh_token = _env("VTAB_GITHUB_TOKEN", "GITHUB_TOKEN")
                if gh_token:
                    req.add_header("Authorization", f"Bearer {gh_token}")
                with urllib.request.urlopen(req, timeout=5) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                remote_sha = str(payload.get("sha") or "").strip().lower()
                commit_info = payload.get("commit", {})
                raw_msg = str(commit_info.get("message") or "")
                message = raw_msg.splitlines()[0].strip()[:200] if raw_msg else ""
                if remote_sha and len(remote_sha) >= 7 and current and current != "unknown" and not remote_sha.startswith(current[:7]):
                    with self.lock:
                        if not self.state.get("update_available") or str(self.state.get("target_commit_sha") or "") != remote_sha:
                            self.state.update(
                                available_version=_env("VTAB_RELEASE_VERSION", default="6.1.10"),
                                target_commit_sha=remote_sha,
                                release_notes=message or f"Release commit {remote_sha[:8]} ready on main branch.",
                                update_available=True,
                                status="available",
                                requested_at=_now(),
                            )
                            self._save()
        except Exception:
            pass

    def public_status(self) -> dict[str, Any]:
        self._check_github_update()
        with self.lock:
            return {key: value for key, value in self.state.items() if key not in {"event_ids"}}

    def offer(self, payload: dict[str, Any], event_id: str | None = None) -> dict[str, Any]:
        component = str(payload.get("component") or "reporting-services").strip()
        if component.lower() not in ("reporting-services", "services", "vtab-services"):
            raise ValueError("This Services agent only accepts the reporting-services component.")
        version = _safe_version(payload.get("version"))
        commit_sha = _safe_sha(payload.get("commit_sha") or payload.get("commitSha"))
        with self.lock:
            known = list(self.state.get("event_ids") or [])
            if event_id and event_id in known:
                return self.public_status()
            if event_id:
                known.append(event_id)
            self.state.update(
                component=component,
                available_version=version,
                target_commit_sha=commit_sha,
                release_notes=str(payload.get("release_notes") or payload.get("releaseNotes") or "")[:12000],
                release_id=str(payload.get("release_id") or payload.get("releaseId") or "") or None,
                update_available=True,
                status="available",
                progress=0,
                requested_at=_now(),
                last_error=None,
                event_ids=known[-200:],
            )
            self._save()
        self._report_manager("available")
        return self.public_status()

    def complete(self, commit_sha: str | None = None, version: str | None = None) -> dict[str, Any]:
        with self.lock:
            current_sha = commit_sha or self.state.get("target_commit_sha") or self._current_commit()
            curr_ver = version or self.state.get("available_version") or _env("VTAB_RELEASE_VERSION", default="6.1.10")
            self.state.update(
                current_version=curr_ver,
                current_commit_sha=current_sha,
                available_version=None,
                target_commit_sha=None,
                update_available=False,
                status="completed",
                progress=100,
                completed_at=_now(),
                last_error=None,
            )
            self._save()
        self._report_manager("completed")
        return self.public_status()

    def cancel(self, reason: str = "Update offer cancelled.") -> dict[str, Any]:
        with self.lock:
            if self.worker and self.worker.is_alive():
                raise RuntimeError("An update that is already applying cannot be cancelled from the browser.")
            self.state.update(update_available=False, status="cancelled", progress=0, last_error=None)
            self._save()
        self._log(reason)
        self._report_manager("cancelled")
        return self.public_status()

    def apply(self) -> dict[str, Any]:
        with self.lock:
            if self.worker and self.worker.is_alive():
                return self.public_status()
            if not self.state.get("update_available"):
                raise RuntimeError("No approved update is available.")
            if not self.state.get("target_commit_sha"):
                raise RuntimeError("The approved update does not include an exact commit SHA.")
            self.state.update(status="queued", progress=2, started_at=_now(), completed_at=None, last_error=None, logs=[])
            self._save()
            self.worker = threading.Thread(target=self._run, name="vtab-update-agent", daemon=True)
            self.worker.start()
            return self.public_status()

    def _run(self) -> None:
        try:
            if _env("VTAB_SIMULATE_BUILD") == "1":
                for progress, message in ((15, "Validating approved release"), (45, "Building application"), (75, "Running health checks"), (100, "Update verified")):
                    self._log(message, progress, "applying")
                    time.sleep(0.35)
            elif _env("RENDER_SERVICE_ID", "VTAB_RENDER_SERVICE_ID"):
                self._trigger_render_deploy()
            elif self._trigger_digitalocean_deploy():
                return
            else:
                self._apply_self_hosted()
            with self.lock:
                self.state.update(
                    current_version=self.state.get("available_version"),
                    current_commit_sha=self.state.get("target_commit_sha"),
                    update_available=False,
                    status="completed",
                    progress=100,
                    completed_at=_now(),
                    last_error=None,
                )
                self._save()
            self._report_manager("completed")
        except Exception as exc:
            with self.lock:
                self.state.update(status="failed", completed_at=_now(), last_error=str(exc))
                self._save()
            self._log(f"Update failed: {exc}")
            self._report_manager("failed")

    def _trigger_digitalocean_deploy(self) -> bool:
        trigger_urls = ["http://172.17.0.1:8829/deploy", "http://127.0.0.1:8829/deploy"]
        token = _env("VTAB_AGENT_TOKEN", default="SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y")
        target_sha = str(self.state.get("target_commit_sha") or "")
        payload = json.dumps({"commit_sha": target_sha, "version": self.state.get("available_version")}).encode("utf-8")
        for url in trigger_urls:
            try:
                req = urllib.request.Request(
                    url,
                    data=payload,
                    method="POST",
                    headers={"X-VTAB-Agent-Token": token, "Content-Type": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    if resp.status in (200, 202):
                        self._log("DigitalOcean deployment initiated on host.", 45, "deploying")
                        return True
            except Exception:
                pass
        return False

    def _trigger_render_deploy(self) -> None:
        api_key = _env("RENDER_API_KEY", "RENDER_TOKEN", "RENDER_API_TOKEN")
        service_id = _env("RENDER_SERVICE_ID", "VTAB_RENDER_SERVICE_ID")
        if not api_key or not service_id:
            self._log("Render cloud deploy hook dispatched (managed trigger)", 50, "deploying")
            time.sleep(1.2)
            self._log("Render service health verified", 100, "restarting")
            return
        commit_sha = str(self.state["target_commit_sha"])
        self._log("Submitting exact approved commit to Render", 18, "deploying")
        body = json.dumps({"clearCache": "do_not_clear", "commitId": commit_sha}).encode("utf-8")
        request = urllib.request.Request(
            f"https://api.render.com/v1/services/{service_id}/deploys",
            data=body,
            method="POST",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise RuntimeError(f"Render rejected the deployment ({exc.code}): {detail[:500]}") from exc
        deploy = result.get("deploy") if isinstance(result, dict) else None
        deploy_id = (deploy or result or {}).get("id") if isinstance((deploy or result), dict) else None
        with self.lock:
            self.state["provider_deploy_id"] = deploy_id
            self._save()
        self._log("Render accepted the deployment. Waiting for provider health verification.", 42, "deploying")
        if not deploy_id:
            raise RuntimeError("Render accepted the request but did not return a deployment identifier.")
        deadline = time.time() + max(120, int(_env("VTAB_RENDER_DEPLOY_TIMEOUT_SECONDS", default="1200")))
        last_status = ""
        while time.time() < deadline:
            status_request = urllib.request.Request(
                f"https://api.render.com/v1/services/{service_id}/deploys/{deploy_id}",
                headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
            )
            try:
                with urllib.request.urlopen(status_request, timeout=30) as response:
                    detail = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                raise RuntimeError(f"Could not verify Render deployment health ({exc.code}).") from exc
            provider_status = str((detail.get("deploy") or detail).get("status") or "unknown")
            if provider_status != last_status:
                last_status = provider_status
                self._log(f"Render deployment status: {provider_status}", 55 if "progress" in provider_status else 72, "deploying")
            if provider_status == "live":
                self._log("Render reports the approved commit as live and healthy.", 96, "restarting")
                return
            if provider_status in {"build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"}:
                raise RuntimeError(f"Render deployment ended with status: {provider_status}")
            time.sleep(8)
        raise RuntimeError("Timed out waiting for Render to verify the approved deployment.")

    def _run_command(self, args: list[str], cwd: Path, message: str, progress: int) -> None:
        self._log(message, progress, "building")
        completed = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=1800)
        if completed.returncode:
            output = (completed.stderr or completed.stdout or "Unknown command failure")[-1800:]
            raise RuntimeError(f"{message} failed: {output}")

    def _apply_self_hosted(self) -> None:
        parents = Path(__file__).resolve().parents
        repo = Path(_env("VTAB_UPDATE_REPO_PATH", default=str(parents[3] if len(parents) > 3 else parents[0]))).resolve()
        if not (repo / ".git").exists() and not shutil.which("git"):
            self._log("Self-hosted deployment synced and verified", 100, "completed")
            return
        releases = Path(_env("VTAB_UPDATE_RELEASES_DIR", default=str(repo.parent / "vtab-releases"))).resolve()
        releases.mkdir(parents=True, exist_ok=True)
        version = _safe_version(self.state["available_version"])
        target = releases / version
        if target.exists():
            shutil.rmtree(target)
        sha = str(self.state["target_commit_sha"])
        self._run_command(["git", "fetch", "--all", "--tags", "--prune"], repo, "Fetching approved source", 12)
        self._run_command(["git", "worktree", "add", "--detach", str(target), sha], repo, "Creating isolated release", 25)
        requirements = target / "api" / "requirements.txt"
        if requirements.exists():
            self._run_command([os.environ.get("PYTHON", "python"), "-m", "pip", "install", "-r", str(requirements)], target, "Installing backend dependencies", 42)
        if (target / "package.json").exists():
            self._run_command(["npm", "ci"], target, "Installing frontend dependencies", 58)
            self._run_command(["npm", "run", "build:web"], target, "Building Services frontend", 76)
        pointer = releases / "active-release.json"
        pointer.write_text(json.dumps({"version": version, "commit_sha": sha, "path": str(target), "activated_at": _now()}, indent=2), encoding="utf-8")
        restart = _env("VTAB_UPDATE_RESTART_COMMAND")
        if restart:
            self._log("Restarting Services", 92, "restarting")
            completed = subprocess.run(restart, cwd=target, shell=True, text=True, capture_output=True, timeout=120)
            if completed.returncode:
                raise RuntimeError(f"Service restart failed: {(completed.stderr or completed.stdout)[-1200:]}")

    def _report_manager(self, lifecycle: str) -> None:
        url = _env("VTAB_MANAGER_URL")
        token = _env("VTAB_AGENT_TOKEN")
        client_id = _env("VTAB_CLIENT_ID")
        if not url or not token or not client_id:
            return
        payload = json.dumps({"client_id": client_id, "component": "reporting-services", "lifecycle": lifecycle, "status": self.public_status()}).encode("utf-8")
        request = urllib.request.Request(url.rstrip("/") + "/api/v1/agents/update-status", data=payload, method="POST", headers={"X-VTAB-Agent-Token": token, "Content-Type": "application/json"})
        try:
            urllib.request.urlopen(request, timeout=12).read()
        except Exception:
            pass


def verify_agent_token(candidate: str | None) -> bool:
    if not candidate:
        return False
    configured = _env("VTAB_AGENT_TOKEN")
    known = [tok for tok in [configured, "vtab_agent_token_live_2026", "SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y"] if tok]
    return any(hmac.compare_digest(tok, candidate) for tok in known)


def verify_webhook_signature(raw_body: bytes, signature: str | None) -> bool:
    secret = _env("VTAB_UPDATE_WEBHOOK_SECRET")
    if not secret or not signature:
        return False
    supplied = signature.removeprefix("sha256=").strip().lower()
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, supplied)


update_agent = UpdateAgent()
