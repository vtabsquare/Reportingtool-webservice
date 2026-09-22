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


@router.post("/semantic-models/{semantic_model_id}/bridge-refresh")
def request_bridge_refresh(semantic_model_id: str, authorization: str | None = Header(default=None)):
    access_token = _token(authorization)
    model = get_semantic_model(semantic_model_id, access_token)
    _workspace(access_token, str(model["workspace_id"]), manage=True)
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
    try:
        rows = (
            _anon_client(access_token).table("vtab_bridge_refresh_jobs")
            .select("id,status,trigger_type,created_at,claimed_at,completed_at,error_message,result")
            .eq("id", job_id).eq("semantic_model_id", semantic_model_id).limit(1).execute().data or []
        )
        if not rows:
            raise HTTPException(404, "Bridge refresh job not found.")
        return rows[0]
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, f"Could not read the Data Bridge refresh status. {error}")


@router.get("/semantic-models/{semantic_model_id}/bridge-refresh-history")
def bridge_refresh_history(semantic_model_id: str, limit: int = 20, authorization: str | None = Header(default=None)):
    access_token = _token(authorization)
    model = get_semantic_model(semantic_model_id, access_token)
    _workspace(access_token, str(model["workspace_id"]))
    try:
        return (
            _anon_client(access_token).table("vtab_bridge_refresh_jobs")
            .select("id,status,trigger_type,created_at,claimed_at,completed_at,error_message,result")
            .eq("semantic_model_id", semantic_model_id).order("created_at", desc=True)
            .limit(max(1, min(int(limit), 100))).execute().data or []
        )
    except Exception as error:
        raise HTTPException(503, f"Could not read Data Bridge refresh history. {error}")
