from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException

from .reporting_service import _anon_client, get_semantic_model, publish_context


router = APIRouter(prefix="/api/v1/service", tags=["data-bridge"])


def _token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sign in to VTAB Services first.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(401, "Sign in to VTAB Services first.")
    return token


def _workspace(access_token: str, workspace_id: str, manage: bool = False) -> dict:
    context = publish_context(access_token)
    workspace = next((item for item in context.get("workspaces", []) if str(item.get("id")) == workspace_id), None)
    if not workspace:
        raise HTTPException(403, "You do not have access to this workspace.")
    if manage and not workspace.get("canPublish"):
        raise HTTPException(403, "Contributor, Member, or Admin access is required.")
    return workspace


def _with_effective_status(row: dict) -> dict:
    heartbeat = row.get("last_heartbeat")
    effective = "offline"
    if heartbeat and row.get("enabled"):
        try:
            stamp = datetime.fromisoformat(str(heartbeat).replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - stamp.astimezone(timezone.utc)).total_seconds()
            # Desktop/WebView timers can be briefly throttled while another window is
            # active. Three minutes prevents false Offline states without hiding a
            # genuinely stopped Desktop bridge for long.
            effective = "online" if age <= 180 else "offline"
        except Exception:
            effective = "offline"
    return {**row, "status": effective}


@router.get("/workspaces/{workspace_id}/data-bridges")
def list_data_bridges(workspace_id: str, authorization: str | None = Header(default=None)):
    access_token = _token(authorization)
    _workspace(access_token, workspace_id)
    try:
        result = (
            _anon_client(access_token)
            .table("vtab_data_bridges")
            .select("id,workspace_id,name,machine_name,status,last_heartbeat,version,enabled,capabilities,updated_at")
            .eq("workspace_id", workspace_id)
            .order("updated_at", desc=True)
            .execute()
        )
        return [_with_effective_status(row) for row in (result.data or [])]
    except Exception as error:
        raise HTTPException(503, f"Data Bridge storage is unavailable. Apply migration 013 and retry. {error}")


@router.get("/semantic-models/{semantic_model_id}/data-bridge")
def get_data_bridge_binding(semantic_model_id: str, authorization: str | None = Header(default=None)):
    access_token = _token(authorization)
    model = get_semantic_model(semantic_model_id, access_token)
    try:
        client = _anon_client(access_token)
        rows = (
            client
            .table("semantic_model_bridge_bindings")
            .select("semantic_model_id,bridge_id,updated_at")
            .eq("semantic_model_id", semantic_model_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not rows:
            return {"semantic_model_id": semantic_model_id, "workspace_id": model["workspace_id"], "bridge_id": None, "bridge": None}
        row = rows[0]
        bridge_rows = (
            client.table("vtab_data_bridges")
            .select("id,workspace_id,name,machine_name,status,last_heartbeat,version,enabled")
            .eq("id", row["bridge_id"])
            .eq("workspace_id", model["workspace_id"])
            .limit(1)
            .execute()
            .data
            or []
        )
        bridge = bridge_rows[0] if bridge_rows else None
        return {**row, "workspace_id": model["workspace_id"], "bridge": _with_effective_status(bridge) if bridge else None}
    except Exception as error:
        raise HTTPException(503, f"Data Bridge binding is unavailable. Apply migration 013 and retry. {error}")


@router.put("/semantic-models/{semantic_model_id}/data-bridge")
def set_data_bridge_binding(semantic_model_id: str, payload: dict, authorization: str | None = Header(default=None)):
    access_token = _token(authorization)
    model = get_semantic_model(semantic_model_id, access_token)
    _workspace(access_token, str(model["workspace_id"]), manage=True)
    bridge_id = str(payload.get("bridgeId") or "").strip()
    client = _anon_client(access_token)
    try:
        if not bridge_id:
            client.table("semantic_model_bridge_bindings").delete().eq("semantic_model_id", semantic_model_id).execute()
            return {"ok": True, "bridge_id": None}
        bridges = (
            client.table("vtab_data_bridges")
            .select("id,workspace_id,name,machine_name,status,last_heartbeat,version,enabled")
            .eq("id", bridge_id)
            .eq("workspace_id", model["workspace_id"])
            .limit(1)
            .execute()
            .data
            or []
        )
        if not bridges:
            raise HTTPException(400, "The selected Data Bridge is not registered in this workspace.")
        bridge = _with_effective_status(bridges[0])
        if bridge["status"] != "online":
            raise HTTPException(400, "The selected Data Bridge is offline. Open VTAB Desktop and connect it first.")
        client.table("semantic_model_bridge_bindings").upsert(
            {"semantic_model_id": semantic_model_id, "bridge_id": bridge_id}, on_conflict="semantic_model_id"
        ).execute()
        return {"ok": True, "bridge_id": bridge_id, "bridge": bridge}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, f"Could not save the Data Bridge binding. {error}")


# Cloud-only source types that the server-side RefreshWorker can handle directly.
# These do NOT require a Desktop Data Bridge agent.
_CLOUD_SOURCE_TYPES = frozenset({
    "google_sheets", "rest", "odata", "graphql",
    "sharepoint", "onedrive", "google_drive",
    "azure_blob", "adls_gen2", "s3", "gcs",
    "salesforce", "dynamics365", "servicenow", "jira", "github",
})


def _model_is_cloud_only(semantic_model_id: str, access_token: str) -> bool:
    """Return True when every live connection is a cloud source (no DB / bridge needed)."""
    try:
        rows = (
            _anon_client(access_token)
            .table("semantic_model_connections")
            .select("source_type")
            .eq("semantic_model_id", semantic_model_id)
            .execute()
            .data or []
        )
        live = [r for r in rows if (r.get("source_type") or "").lower() != "managed_file"]
        if not live:
            return False
        return all((r.get("source_type") or "").lower() in _CLOUD_SOURCE_TYPES for r in live)
    except Exception:
        return False


def _run_cloud_refresh_async(run_id: str, semantic_model_id: str, report_id: str, user_id: str):
    import time
    from datetime import datetime, timezone
    from .supabase_store import _admin_client
    from .refresh_worker import execute_refresh
    from .credential_vault import encrypt_credentials

    sb = _admin_client()
    started = time.time()
    try:
        job = {
            "id": run_id,
            "report_id": report_id,
            "semantic_model_id": semantic_model_id,
            "created_by": user_id,
            "source_type": "semantic_model",
            "source_config": {"semantic_model_id": semantic_model_id},
            "credentials_enc": encrypt_credentials({}),
        }
        result = execute_refresh(job, sb)
        duration_ms = int((time.time() - started) * 1000)
        sb.table("refresh_runs").update({
            "status": "succeeded",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": duration_ms,
            "tables_refreshed": len(result.get("tables") or []),
            "rows_processed": result.get("rows") or 0,
            "details": result,
            "error_message": None,
        }).eq("id", run_id).execute()

        # Trigger refresh success notification & email to all workspace members
        try:
            from .notification_service import notify_workspace_members
            report_row = sb.table("published_reports").select("name,workspace_id").eq("id", report_id).limit(1).execute().data or []
            rep = report_row[0] if report_row else {}
            rep_name = rep.get("name") or "Unified Data Model"
            ws_id = rep.get("workspace_id")
            if not ws_id:
                m_row = sb.table("semantic_models").select("workspace_id").eq("id", semantic_model_id).limit(1).execute().data or []
                ws_id = m_row[0].get("workspace_id") if m_row else None
            rows_cnt = result.get("rows") or 0
            tables_cnt = len(result.get("tables") or [])
            if ws_id:
                notify_workspace_members(
                    workspace_id=ws_id,
                    event_type="refresh.succeeded",
                    category="refresh",
                    severity="success",
                    title=f"Refresh completed: {rep_name}",
                    message=f"The data refresh completed successfully. {tables_cnt} table(s) refreshed with {rows_cnt:,} row(s) processed.",
                    report_id=report_id,
                    object_type="semantic_model",
                    object_id=semantic_model_id,
                    action_url=f"/?viewer={report_id}",
                    fallback_user_id=user_id,
                    override_channels=["in_app", "email"],
                )
        except Exception as notif_err:
            print(f"VTAB refresh success notification error: {notif_err}", flush=True)

        # Trigger after-refresh automation (subscriptions, alerts)
        try:
            from .automation_service import queue_after_refresh, evaluate_alert
            queue_after_refresh(report_id)
            active_alerts = (
                sb.table("alert_rules")
                .select("*")
                .eq("report_id", report_id)
                .eq("status", "active")
                .execute()
                .data or []
            )
            for alert in active_alerts:
                try:
                    evaluate_alert(alert, "after_refresh")
                except Exception as eval_err:
                    print(f"VTAB evaluate alert error: {eval_err}", flush=True)
        except Exception as auto_err:
            print(f"VTAB after-refresh automation error: {auto_err}", flush=True)

    except Exception as error:
        duration_ms = int((time.time() - started) * 1000)
        message = str(error)[:2000]
        sb.table("refresh_runs").update({
            "status": "failed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": duration_ms,
            "error_message": message,
            "details": {"error": message},
        }).eq("id", run_id).execute()

        # Trigger refresh failure notification & email to all workspace members
        try:
            from .notification_service import notify_workspace_members
            report_row = sb.table("published_reports").select("name,workspace_id").eq("id", report_id).limit(1).execute().data or []
            rep = report_row[0] if report_row else {}
            rep_name = rep.get("name") or "Unified Data Model"
            ws_id = rep.get("workspace_id")
            if not ws_id:
                m_row = sb.table("semantic_models").select("workspace_id").eq("id", semantic_model_id).limit(1).execute().data or []
                ws_id = m_row[0].get("workspace_id") if m_row else None
            if ws_id:
                notify_workspace_members(
                    workspace_id=ws_id,
                    event_type="refresh.failed",
                    category="refresh",
                    severity="error",
                    title=f"Refresh failed: {rep_name}",
                    message=f"The data refresh failed: {message}",
                    report_id=report_id,
                    object_type="semantic_model",
                    object_id=semantic_model_id,
                    action_url=f"/?viewer={report_id}",
                    fallback_user_id=user_id,
                    override_channels=["in_app", "email"],
                )
        except Exception as notif_err:
            print(f"VTAB refresh failure notification error: {notif_err}", flush=True)


@router.post("/semantic-models/{semantic_model_id}/bridge-refresh")
def request_bridge_refresh(semantic_model_id: str, authorization: str | None = Header(default=None)):
    access_token = _token(authorization)
    model = get_semantic_model(semantic_model_id, access_token)
    _workspace(access_token, str(model["workspace_id"]), manage=True)

    # ── Cloud-source fast path ────────────────────────────────────────────────
    # Google Sheets, REST APIs and other cloud connectors are refreshed by the
    # server-side RefreshWorker directly in Services without needing a Desktop Data Bridge.
    if _model_is_cloud_only(semantic_model_id, access_token):
        import threading
        from datetime import datetime, timezone
        from .supabase_store import _admin_client, _supabase_user_id_from_token_nothrow, semantic_model_refresh_now
        user_id = _supabase_user_id_from_token_nothrow(authorization) or str(model.get("created_by") or "")
        sb = _admin_client()
        report_id = str(model.get("report_id") or "")
        
        # Ensure a scheduled_job exists for foreign key constraint
        sched_res = semantic_model_refresh_now(semantic_model_id, user_id)
        job_id = (sched_res.get("job") or {}).get("id")

        run_row = sb.table("refresh_runs").insert({
            "job_id": job_id,
            "report_id": report_id,
            "semantic_model_id": semantic_model_id,
            "requested_by": user_id,
            "trigger_type": "manual",
            "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "tables_total": 1,
        }).execute().data[0]
        run_id = run_row["id"]

        thread = threading.Thread(
            target=_run_cloud_refresh_async,
            args=(run_id, semantic_model_id, report_id, user_id),
            daemon=True
        )
        thread.start()
        return {"ok": True, "job_id": run_id, "status": "running"}

    # ── Desktop Bridge path (database sources) ────────────────────────────────
    try:
        result = _anon_client(access_token).rpc(
            "request_vtab_bridge_refresh", {"p_semantic_model_id": semantic_model_id}
        ).execute().data or {}
        if isinstance(result, dict) and result.get("error"):
            raise HTTPException(400, result["error"])
        return result
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, f"Could not queue the Data Bridge refresh. Apply migration 014 and retry. {error}")


@router.get("/semantic-models/{semantic_model_id}/bridge-refresh/{job_id}")
def bridge_refresh_status(semantic_model_id: str, job_id: str, authorization: str | None = Header(default=None)):
    access_token = _token(authorization)
    model = get_semantic_model(semantic_model_id, access_token)
    _workspace(access_token, str(model["workspace_id"]))

    # 1. Check refresh_runs first (for cloud refreshes)
    try:
        from .supabase_store import _admin_client
        runs = (
            _admin_client()
            .table("refresh_runs")
            .select("id,status,trigger_type,started_at,completed_at,error_message,details,rows_processed")
            .eq("id", job_id)
            .limit(1)
            .execute()
            .data or []
        )
        if runs:
            r = runs[0]
            result = r.get("details") or {}
            if "rows" not in result and r.get("rows_processed") is not None:
                result["rows"] = r.get("rows_processed")
            return {
                "id": r["id"],
                "status": r["status"],
                "trigger_type": r.get("trigger_type") or "manual",
                "created_at": r.get("started_at"),
                "claimed_at": r.get("started_at"),
                "completed_at": r.get("completed_at"),
                "error_message": r.get("error_message"),
                "result": result,
            }
    except Exception:
        pass

    # 2. Check vtab_bridge_refresh_jobs (for Desktop Bridge refreshes)
    try:
        rows = (
            _anon_client(access_token).table("vtab_bridge_refresh_jobs")
            .select("id,status,trigger_type,created_at,claimed_at,completed_at,error_message,result")
            .eq("id", job_id).eq("semantic_model_id", semantic_model_id).limit(1).execute().data or []
        )
        if rows:
            job_row = rows[0]
            if job_row.get("status") == "succeeded":
                res = job_row.get("result") or {}
                if isinstance(res, dict) and not res.get("after_refresh_queued"):
                    try:
                        from .automation_service import queue_after_refresh
                        report_id = str(model.get("report_id") or "")
                        if report_id:
                            queue_after_refresh(report_id)
                        res["after_refresh_queued"] = True
                        _anon_client(access_token).table("vtab_bridge_refresh_jobs").update({"result": res}).eq("id", job_id).execute()
                    except Exception:
                        pass
            return job_row
    except Exception as error:
        raise HTTPException(503, f"Could not read the Data Bridge refresh status. {error}")

    raise HTTPException(404, "Refresh job not found.")


@router.get("/semantic-models/{semantic_model_id}/bridge-refresh-history")
def bridge_refresh_history(semantic_model_id: str, limit: int = 20, authorization: str | None = Header(default=None)):
    access_token = _token(authorization)
    model = get_semantic_model(semantic_model_id, access_token)
    _workspace(access_token, str(model["workspace_id"]))
    try:
        from .supabase_store import _admin_client
        bridge_jobs = (
            _anon_client(access_token).table("vtab_bridge_refresh_jobs")
            .select("id,status,trigger_type,created_at,claimed_at,completed_at,error_message,result")
            .eq("semantic_model_id", semantic_model_id).order("created_at", desc=True)
            .limit(max(1, min(int(limit), 100))).execute().data or []
        )
        cloud_runs = (
            _admin_client().table("refresh_runs")
            .select("id,status,trigger_type,started_at,completed_at,error_message,details,rows_processed,created_at")
            .eq("semantic_model_id", semantic_model_id).order("created_at", desc=True)
            .limit(max(1, min(int(limit), 100))).execute().data or []
        )
        normalized_runs = []
        for r in cloud_runs:
            res = r.get("details") or {}
            if "rows" not in res and r.get("rows_processed") is not None:
                res["rows"] = r.get("rows_processed")
            normalized_runs.append({
                "id": r["id"],
                "status": r["status"],
                "trigger_type": r.get("trigger_type") or "manual",
                "created_at": r.get("created_at") or r.get("started_at"),
                "claimed_at": r.get("started_at"),
                "completed_at": r.get("completed_at"),
                "error_message": r.get("error_message"),
                "result": res,
            })
        combined = bridge_jobs + normalized_runs
        combined.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
        return combined[:max(1, min(int(limit), 100))]
    except Exception as error:
        raise HTTPException(503, f"Could not read Data Bridge refresh history. {error}")
