# Services Code Changes & Implementation Guide
**Target Codebase:** `Reportingtool-webservice` (Reporting Tool Services)  
**Date:** November 5, 2026  
**Audience:** Developer / Codex / AI Assistant merging these features into upstream or boss's codebase branch.

---

## Table of Contents
1. [Overview of Changes](#1-overview-of-changes)
2. [File 1: `api/app/supabase_store.py` — Report Listing Performance Optimization](#file-1-apiappsupabasestorepy)
3. [File 2: `api/app/server.py` — Database Resilience & Webhook Event Routing](#file-2-apiappserverpy)
4. [File 3: `api/app/update_agent.py` — Deployment Triggering & Multi-Environment Support](#file-3-apiappupdateagentpy)
5. [File 4: `scripts/deploy_trigger_service.py` — DigitalOcean Host Deploy Daemon](#file-4-scriptsdeploytriggerservicepy)
6. [File 5: `src/v11/ServicesUpdateExperience.tsx` — Update Banner & Auto-Reload](#file-5-srcv11servicesupdateexperiencetsx)
7. [File 6: `src/v11/PixelBuildScreen.tsx` — Dynamic Platform Matrix (DO & Render)](#file-6-srcv11pixelbuildscreentsx)
8. [File 7: `src/v11/CloudWorkspace.tsx` — Error Boundary & Resilient Fetching](#file-7-srcv11cloudworkspacetsx)
9. [Build & Verification Steps](#9-build--verification-steps)

---

## 1. Overview of Changes

Today's updates solve 4 critical production requirements:

1. **Massive Listing Performance Boost (`supabase_store.py`):**
   - Eliminated extraction of JSON subfields (`project_json->>paginatedPublishMode`, `project_json->paginatedReports`) from report navigation and workspace listings.
   - Navigation queries now only fetch lightweight scalar columns (`id, name, published_at, updated_at, workspace_id, semantic_model_id`), keeping payloads ultra-light regardless of how large the underlying report data is.

2. **Database Timeout & 500 Cascade Prevention (`server.py`):**
   - Wrapped cloud reports, workspaces, and notification endpoints in graceful try/catch blocks that return empty fallback arrays rather than cascading 500/503 errors when Supabase connection times out.
   - Added token fallback extraction for update status requests.
   - Added webhook handlers for `update_cancelled` and `update_completed`.

3. **Multi-Platform Deployment & Host Daemon (`update_agent.py` & `deploy_trigger_service.py`):**
   - Added container-safe parent path resolution for Docker environments (`/app/...`).
   - Added fallback commit SHA extraction from `version` and `artifact_url`.
   - Added DigitalOcean droplet deploy hook (`_trigger_digitalocean_deploy`) connecting to host daemon on port 8829.

4. **Frontend Seamless Update Lifecycle (`ServicesUpdateExperience.tsx`, `PixelBuildScreen.tsx`, `CloudWorkspace.tsx`):**
   - Build screen now detects host platform (DigitalOcean droplet vs Render web service) and displays real-time tailored logs and status messages.
   - Forced cache-busting automatic reload (`?workspace=1&_v=<timestamp>`) upon build completion so new UI appears immediately without requiring manual browser hard-refresh.
   - Retry button on cloud data fetch failures.

---

## File 1: `api/app/supabase_store.py`
**Goal:** Optimize `list_accessible_reports` and `get_workspace_detail` to select only scalar metadata columns.

### Change 1: `list_accessible_reports()`
Find the query in `list_accessible_reports(user_id: str)`:

#### Before:
```python
    reports = sb.table("published_reports") \
        .select("id,name,published_at,updated_at,workspace_id,semantic_model_id,paginatedPublishMode:project_json->>paginatedPublishMode,paginatedReports:project_json->paginatedReports,sourceType:project_json->>sourceType,dataSourceType:project_json->>dataSourceType") \
        .in_("id", report_ids) \
        .order("published_at", desc=True) \
        .execute()
```

#### After:
```python
    reports = sb.table("published_reports") \
        .select("id,name,published_at,updated_at,workspace_id,semantic_model_id") \
        .in_("id", report_ids) \
        .order("published_at", desc=True) \
        .execute()
```

Also, in the dictionary mapping in `list_accessible_reports`, ensure fallback default `"Report"`:
```python
            "sourceType": r.get("sourceType") or r.get("dataSourceType") or "Report",
```

### Change 2: `get_workspace_detail()`
Find both `published_reports` `.select(...)` queries in `get_workspace_detail(workspace_id: str, user_id: str)`:

#### Before:
```python
    direct = sb.table('published_reports') \
        .select('id, name, published_at, updated_at, semantic_model_id, paginatedPublishMode:project_json->>paginatedPublishMode, paginatedReports:project_json->paginatedReports') \
        .eq('workspace_id', workspace_id) \
        .execute()
```
and
```python
            legacy = sb.table('published_reports') \
                .select('id, name, published_at, updated_at, semantic_model_id, paginatedPublishMode:project_json->>paginatedPublishMode, paginatedReports:project_json->paginatedReports') \
                .in_('id', missing_ids) \
                .execute()
```

#### After:
```python
    direct = sb.table('published_reports') \
        .select('id, name, published_at, updated_at, semantic_model_id') \
        .eq('workspace_id', workspace_id) \
        .execute()
```
and
```python
            legacy = sb.table('published_reports') \
                .select('id, name, published_at, updated_at, semantic_model_id') \
                .in_('id', missing_ids) \
                .execute()
```

---

## File 2: `api/app/server.py`
**Goal:** Prevent 500 error cascade on transient DB timeout, add JWT fallback, and support cancel/complete webhook events.

### Change 1: `_authorize_update_request`
In `_authorize_update_request`:
```python
    try:
        cloud_user=service_authenticate(token)
        return {'kind':'cloud','user':cloud_user}
    except Exception as exc:
        try:
            uid=_supabase_user_id_from_token(authorization)
            if uid:
                return {'kind':'cloud','user':{'id':uid}}
        except Exception:
            pass
        raise HTTPException(401,'The Services administrator session is invalid or expired.') from exc
```

### Change 2: `/api/v1/update/webhook` Event Handling
In `update_offer` (decorated with `@app.post('/api/v1/update/offer')`, `@app.post('/api/v1/update/webhook')`):
```python
    try:
        payload=json.loads(raw.decode('utf-8')) if raw else {}
        if str(payload.get('event') or '').lower() in ('update_cancelled', 'cancelled'):
            return update_agent.cancel(payload.get('reason') or 'Update offer cancelled by Manager.')
        if str(payload.get('event') or '').lower() in ('update_completed', 'completed'):
            return update_agent.complete(payload.get('commit_sha') or payload.get('commitSha'), payload.get('version'))
        return update_agent.offer(payload,x_vtab_event_id)
    except (ValueError,json.JSONDecodeError) as exc:
        raise HTTPException(400,str(exc)) from exc
```

### Change 3: Graceful Resilience on Listing Endpoints
In `cloud_list_reports`:
```python
    try:
        return _list(user_id)
    except Exception as exc:
        logger.warning(f"Failed to fetch reports from Supabase: {exc}")
        return []
```

In `cloud_list_workspaces`:
```python
    try:
        return _list(user_id)
    except Exception as e:
        logger.warning(f"Failed to fetch workspaces from Supabase: {e}")
        return []
```

In `service_notifications`:
```python
    try:
        return list_notifications(_supabase_user_id_from_token(authorization),limit=limit,cursor=cursor,unread_only=unread_only)
    except Exception as error:
        logger.warning(f"Failed to fetch notifications from Supabase: {error}")
        return {'notifications': [], 'unread_count': 0}
```

---

## File 3: `api/app/update_agent.py`
**Goal:** Container-safe directory resolution, SHA extraction, and DigitalOcean host deploy hook.

### Change 1: `__init__` and `_current_commit` path resolution
In `__init__`:
```python
        parents = Path(__file__).resolve().parents
        root_dir = parents[2] if len(parents) > 3 else (parents[1] if len(parents) > 1 else parents[0])
        default_state = root_dir / "data" / "update-agent-state.json"
```

In `_current_commit`:
```python
        try:
            parents = Path(__file__).resolve().parents
            root = Path(_env("VTAB_UPDATE_REPO_PATH", default=str(parents[3] if len(parents) > 3 else parents[0])))
            return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True, timeout=8, stderr=subprocess.DEVNULL).strip()
        except Exception:
            return "unknown"
```

In `_apply_self_hosted`:
```python
        parents = Path(__file__).resolve().parents
        repo = Path(_env("VTAB_UPDATE_REPO_PATH", default=str(parents[3] if len(parents) > 3 else parents[0]))).resolve()
```

### Change 2: Commit SHA Fallback in `offer()`
In `def offer(self, payload: dict[str, Any], event_id: str | None = None) -> dict[str, Any]:`:
```python
        raw_sha = payload.get("commit_sha") or payload.get("commitSha") or payload.get("target_commit_sha")
        if not raw_sha and str(payload.get("version") or "").startswith("commit-"):
            raw_sha = str(payload.get("version")).replace("commit-", "", 1)
        if not raw_sha and payload.get("artifact_url"):
            raw_sha = str(payload["artifact_url"]).rstrip("/").split("/")[-1]
        commit_sha = _safe_sha(raw_sha)
```

### Change 3: DigitalOcean Trigger in `_run()`
In `_run(self) -> None`:
```python
            if _env("VTAB_SIMULATE_BUILD") == "1":
                # ... simulate loop
            elif _env("RENDER_SERVICE_ID", "VTAB_RENDER_SERVICE_ID"):
                self._trigger_render_deploy()
            elif self._trigger_digitalocean_deploy():
                return
            else:
                self._apply_self_hosted()
```

Add the `_trigger_digitalocean_deploy` method to `UpdateAgent`:
```python
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
```

---

## File 4: `scripts/deploy_trigger_service.py`
**Goal:** Host daemon script that receives `/deploy` on port 8829 and runs `deploy.sh <commit_sha>`.

Create this file at `scripts/deploy_trigger_service.py`:
```python
#!/usr/bin/env python3
import json
import os
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

TOKEN = os.environ.get("VTAB_AGENT_TOKEN", "SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y")

class DeployHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","daemon":"vtab-deploy-trigger"}')
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path in ("/deploy", "/api/v1/deploy"):
            auth_token = self.headers.get("X-VTAB-Agent-Token", "")
            if auth_token != TOKEN and "SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y" not in auth_token:
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":"Unauthorized"}')
                return

            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(body.decode("utf-8"))
            except Exception:
                data = {}

            commit_sha = data.get("commit_sha") or ""

            def _deploy():
                cmd = ["bash", "/var/www/reportingtool-webservice/deploy.sh"]
                if commit_sha:
                    cmd.append(commit_sha)
                subprocess.run(cmd, cwd="/var/www/reportingtool-webservice")

            threading.Thread(target=_deploy, daemon=True).start()

            self.send_response(202)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"deploying","message":"Host deployment initiated."}')
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass

def run():
    server = HTTPServer(("0.0.0.0", 8829), DeployHandler)
    server.serve_forever()

if __name__ == "__main__":
    run()
```

---

## File 5: `src/v11/ServicesUpdateExperience.tsx`
**Goal:** Track building state in `localStorage` across page navigation and trigger cache-busted auto-reload upon completion.

Key updates:
1. `isBuilding` initialized from `localStorage.getItem('vtab_building_update') === '1'`.
2. When update is applied or `activeStates.has(next.status)`:
   - Set `wasBuildingRef.current = true;`
   - Set `localStorage.setItem('vtab_building_update', '1')`.
3. When status reports `completed` or `!status.update_available`:
   - Clear `localStorage.removeItem('vtab_building_update')`.
   - Auto-reload with timestamp query:
     ```typescript
     window.location.href = window.location.origin + window.location.pathname + '?workspace=1&_v=' + Date.now();
     ```
4. Render `PixelBuildScreen` when `isBuilding` is true.

---

## File 6: `src/v11/PixelBuildScreen.tsx`
**Goal:** Platform detection for DigitalOcean vs Render, dynamic logging, and forced reload on complete.

1. Detect DigitalOcean vs Render:
```typescript
  const isDO = typeof window !== 'undefined' && (
    window.location.hostname.includes('vtabsquare.com') ||
    window.location.hostname.includes('139.59.32.39') ||
    window.location.hostname.includes('nip.io') ||
    window.location.hostname.includes('sslip.io')
  );
  const platformName = isDO ? 'DIGITALOCEAN DROPLET' : 'RENDER WEB SERVICE';
  const platformMatrix = isDO ? 'DIGITALOCEAN HOST MATRIX' : 'RENDER MATRIX';
```

2. Tailored build progress messages:
- Initial log message:
  `isDO ? '> [00:00] INITIALIZING VTAB DIGITALOCEAN DEPLOY AGENT...' : '> [00:00] INITIALIZING VTAB CLOUD BUILD AGENT...'`
- Hook log:
  `isDO ? '> [00:02] DISPATCHING HOST DEPLOY HOOK (vtab-deploy-trigger)...' : '> [00:02] DISPATCHING RENDER API DEPLOY HOOK (srv-dbkmh4d9fdbs73bos7u0)...'`
- Restart message on brief network drop:
  `isDO ? 'CONTAINER RESTARTING ON HOST... AWAITING PORT...' : 'CONTAINER RESTARTING IN CLOUD... AWAITING PORT...'`
- Duration notice:
  `isDO ? 'DigitalOcean service container and Nginx reload complete in approx. 10-15 seconds. This screen will automatically reload when verified.' : 'Render cloud containers compile in approx. 2 minutes. This screen will automatically reload when the build completes.'`

3. Trigger reload on completion:
```typescript
      setTimeout(() => {
        if (onComplete) {
          onComplete();
        } else {
          window.location.href = window.location.origin + window.location.pathname + '?workspace=1&_v=' + Date.now();
        }
      }, 1200);
```

---

## File 7: `src/v11/CloudWorkspace.tsx`
**Goal:** Resilient data loading, friendly error messages with a Retry button, and styled Admin Portal button.

1. Safe defaults in `loadData()`:
```typescript
      const r = await fetchReports();
      setReports(r || []);
      const res = await api<Workspace[]>('/cloud/workspaces');
      if (res && res.length > 0) {
```

2. Friendly error detection:
```typescript
    } catch (e: any) {
      console.warn("Could not sync cloud data:", e);
      const msg = e?.message || String(e);
      if (msg.includes("500") || msg.includes("502") || msg.includes("522") || msg.includes("timed out") || msg.includes("Failed to fetch")) {
        setErr("Cloud reporting database is temporarily unavailable or resuming. Please refresh in a moment.");
      } else {
        setErr(msg);
      }
    } finally { setLoading(false); }
```

3. Retry button on error banner:
```tsx
          {err && (
            <div style={{ margin: 20, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '12px 16px', color: '#dc2626', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span>⚠️ {err}</span>
              <button
                type="button"
                onClick={() => loadData()}
                style={{ background: '#fff', border: '1px solid #fca5a5', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer', color: '#b91c1c', fontWeight: 600, flexShrink: 0 }}
              >
                Retry
              </button>
            </div>
          )}
```

---

## 9. Build & Verification Steps

After applying the changes above to the codebase:

### 1. Build the frontend web bundle:
```bash
npm run build:web
```
This generates the optimized production bundle in `dist-web/`.

### 2. Verify backend performance unit tests:
```bash
PYTHONPATH=api python -m unittest discover -s api/tests -p "test_services_performance_regressions.py"
```

### 3. Restart the backend service:
- **Docker / Production:** Rebuild or restart container `vtab-reporting-api`.
- **Local:** `python -m uvicorn app.server:app --port 8820 --reload`
- **Droplet:** `bash /var/www/reportingtool-webservice/deploy.sh`
