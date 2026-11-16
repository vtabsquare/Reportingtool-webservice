from __future__ import annotations

from datetime import datetime, timezone
import os
from typing import Any

from .supabase_store import _admin_client, is_admin_user


DEFAULT_POLICY = {
    "subscriptions_enabled": True,
    "scheduled_delivery_enabled": True,
    "alerts_enabled": True,
    "workflows_enabled": True,
    "templates_enabled": True,
    "external_recipients_enabled": False,
    "member_manage_own": True,
    "member_run_now": False,
    "allowed_formats": ["link", "pdf", "snapshot"],
    "max_recipients": 25,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def workspace_authority(workspace_id: str, user_id: str) -> dict[str, Any]:
    """Resolve workspace authority once and fail closed.

    This function intentionally uses the service-role client because every caller has
    already authenticated.  Authorization is still evaluated here and never trusted
    from a browser-provided role.
    """
    sb = _admin_client()
    rows = sb.table("workspaces").select("id,owner_id,created_by,name").eq("id", workspace_id).limit(1).execute().data or []
    if not rows:
        raise ValueError("Workspace not found.")
    workspace = rows[0]
    owner = str(workspace.get("owner_id") or workspace.get("created_by") or "") == str(user_id)
    membership = sb.table("workspace_members").select("role").eq("workspace_id", workspace_id).eq("user_id", user_id).limit(1).execute().data or []
    role = str((membership[0] if membership else {}).get("role") or "").strip().lower()
    system_admin = bool(is_admin_user(user_id))
    if not (owner or membership or system_admin):
        raise PermissionError("You do not have access to this workspace.")
    return {
        "workspace": workspace,
        "role": "owner" if owner else ("system_admin" if system_admin else role),
        "is_owner": owner or system_admin,
        "is_admin": owner or system_admin or role in {"admin", "co-owner"},
    }


def get_policy(workspace_id: str, user_id: str) -> dict[str, Any]:
    authority = workspace_authority(workspace_id, user_id)
    sb = _admin_client()
    rows = sb.table("automation_workspace_policies").select("*").eq("workspace_id", workspace_id).limit(1).execute().data or []
    stored = rows[0] if rows else {}
    policy = {**DEFAULT_POLICY, **{key: stored.get(key) for key in DEFAULT_POLICY if stored.get(key) is not None}}
    return {**policy, "workspace_id": workspace_id, "role": authority["role"], "can_manage_policy": authority["is_owner"]}


def save_policy(workspace_id: str, payload: dict[str, Any], user_id: str) -> dict[str, Any]:
    authority = workspace_authority(workspace_id, user_id)
    if not authority["is_owner"]:
        raise PermissionError("Only the workspace owner can change automation availability.")
    allowed_formats = [str(value).lower() for value in payload.get("allowed_formats", DEFAULT_POLICY["allowed_formats"])]
    supported_formats = {"link", "pdf", "snapshot"}
    if os.environ.get("VTAB_AUTOMATION_TABULAR_EXPORTS_ENABLED", "0") == "1": supported_formats.update({"xlsx", "csv"})
    if os.environ.get("VTAB_AUTOMATION_PAGINATED_EXPORT_ENABLED", "0") == "1": supported_formats.add("paginated_pdf")
    allowed_formats = [value for value in dict.fromkeys(allowed_formats) if value in supported_formats]
    if not allowed_formats:
        raise ValueError("Enable at least one delivery format.")
    values = {
        "workspace_id": workspace_id,
        "subscriptions_enabled": bool(payload.get("subscriptions_enabled", True)),
        "scheduled_delivery_enabled": bool(payload.get("scheduled_delivery_enabled", True)),
        "alerts_enabled": bool(payload.get("alerts_enabled", True)),
        "workflows_enabled": bool(payload.get("workflows_enabled", True)),
        "templates_enabled": bool(payload.get("templates_enabled", True)),
        "external_recipients_enabled": bool(payload.get("external_recipients_enabled", False)),
        "member_manage_own": bool(payload.get("member_manage_own", True)),
        "member_run_now": bool(payload.get("member_run_now", False)),
        "allowed_formats": allowed_formats,
        "max_recipients": max(1, min(int(payload.get("max_recipients") or 25), 500)),
        "updated_by": user_id,
        "updated_at": _now(),
    }
    sb = _admin_client()
    rows = sb.table("automation_workspace_policies").upsert(values, on_conflict="workspace_id").execute().data or []
    audit(sb, workspace_id, user_id, "automation.policy.updated", "workspace", workspace_id, {"policy": values})
    return {**(rows[0] if rows else values), "role": authority["role"], "can_manage_policy": True}


def require_feature(workspace_id: str, user_id: str, feature: str, *, manage: bool = False, run_now: bool = False) -> dict[str, Any]:
    policy = get_policy(workspace_id, user_id)
    mapping = {
        "subscription": "subscriptions_enabled",
        "schedule": "scheduled_delivery_enabled",
        "alert": "alerts_enabled",
        "workflow": "workflows_enabled",
        "template": "templates_enabled",
    }
    key = mapping.get(feature)
    if key and not policy.get(key):
        raise PermissionError(f"{feature.title()} automation is disabled by the workspace owner.")
    if manage and not (policy.get("can_manage_policy") or policy.get("member_manage_own")):
        raise PermissionError("The workspace owner has disabled member-managed automation.")
    if run_now and not (policy.get("can_manage_policy") or policy.get("member_run_now")):
        raise PermissionError("Only the workspace owner can run this automation now.")
    return policy


def audit(sb, workspace_id: str, actor_id: str, action: str, object_type: str, object_id: str | None, details: dict | None = None) -> None:
    sb.table("automation_audit_log").insert({
        "workspace_id": workspace_id,
        "actor_id": actor_id,
        "action": action,
        "object_type": object_type,
        "object_id": object_id,
        "details": details or {},
    }).execute()


def summary(workspace_id: str, user_id: str) -> dict[str, Any]:
    authority = workspace_authority(workspace_id, user_id)
    sb = _admin_client()
    subscriptions = sb.table("report_subscriptions").select("id,status,last_status,next_run").eq("workspace_id", workspace_id).execute().data or []
    alerts = sb.table("alert_rules").select("id,status,current_state,last_evaluated_at").eq("workspace_id", workspace_id).execute().data or []
    workflows = sb.table("automation_workflows").select("id,status,last_status,next_run").eq("workspace_id", workspace_id).execute().data or []
    executions = sb.table("automation_executions").select("id,status,started_at,completed_at,error_message,workflow_id").eq("workspace_id", workspace_id).order("created_at", desc=True).limit(50).execute().data or []
    return {
        "authority": {"role": authority["role"], "can_manage_policy": authority["is_owner"]},
        "policy": get_policy(workspace_id, user_id),
        "counts": {
            "subscriptions": len(subscriptions),
            "active_subscriptions": sum(1 for item in subscriptions if item.get("status") == "active"),
            "alerts": len(alerts),
            "triggered_alerts": sum(1 for item in alerts if item.get("current_state") in {"triggered", "sustained"}),
            "workflows": len(workflows),
            "failed_runs": sum(1 for item in executions if item.get("status") == "failed"),
        },
        "recent_executions": executions,
    }


def list_workflows(workspace_id: str, user_id: str) -> list[dict]:
    workspace_authority(workspace_id, user_id)
    return _admin_client().table("automation_workflows").select("*").eq("workspace_id", workspace_id).order("updated_at", desc=True).execute().data or []


def save_workflow(workspace_id: str, payload: dict, user_id: str, workflow_id: str | None = None) -> dict:
    require_feature(workspace_id, user_id, "workflow", manage=True)
    trigger = payload.get("trigger") or {}
    steps = payload.get("steps") or []
    if str(trigger.get("type") or "") not in {"schedule", "after_refresh", "data_condition", "manual"}:
        raise ValueError("Choose a supported workflow trigger.")
    if not isinstance(steps, list) or not steps:
        raise ValueError("Add at least one workflow action.")
    supported = {"validate_refresh", "refresh", "generate_report", "export", "evaluate_alert", "send_email", "notify", "record_audit"}
    if any(str(step.get("type") or "") not in supported for step in steps):
        raise ValueError("The workflow contains an unsupported action.")
    authority = workspace_authority(workspace_id, user_id)
    sb = _admin_client()
    existing = []
    if workflow_id:
        existing = sb.table("automation_workflows").select("*").eq("id", workflow_id).eq("workspace_id", workspace_id).limit(1).execute().data or []
        if not existing:
            raise ValueError("Workflow not found.")
        if str(existing[0].get("owner_id")) != str(user_id) and not authority["is_admin"]:
            raise PermissionError("You cannot edit another user's workflow.")
    cron_expr = None
    next_run = None
    if trigger.get("type") == "schedule":
        from .automation_service import _schedule
        cron_expr, next_run = _schedule({**trigger, "timezone": payload.get("timezone") or "UTC"})
    values = {
        "workspace_id": workspace_id,
        "owner_id": (existing[0].get("owner_id") if existing else user_id),
        "report_id": payload.get("report_id") or None,
        "name": str(payload.get("name") or "Untitled workflow").strip()[:200],
        "description": str(payload.get("description") or "")[:1000],
        "trigger": trigger,
        "steps": steps,
        "status": payload.get("status") if payload.get("status") in {"active", "paused", "draft"} else "draft",
        "timezone": payload.get("timezone") or "UTC",
        "cron_expr": cron_expr,
        "next_run": next_run if payload.get("status") == "active" else None,
        "updated_at": _now(),
    }
    rows = (sb.table("automation_workflows").update(values).eq("id", workflow_id).execute().data if workflow_id else sb.table("automation_workflows").insert(values).execute().data) or []
    saved = rows[0]
    version = int(saved.get("version") or 1)
    sb.table("automation_workflow_versions").upsert({"workflow_id": saved["id"], "version": version, "definition": {"trigger": trigger, "steps": steps}, "created_by": user_id}, on_conflict="workflow_id,version").execute()
    audit(sb, workspace_id, user_id, "workflow.saved", "workflow", saved["id"], {"version": version, "status": saved["status"]})
    return saved


def run_workflow(workspace_id: str, workflow_id: str, user_id: str) -> dict:
    require_feature(workspace_id, user_id, "workflow", run_now=True)
    sb = _admin_client()
    rows = sb.table("automation_workflows").select("*").eq("id", workflow_id).eq("workspace_id", workspace_id).limit(1).execute().data or []
    if not rows:
        raise ValueError("Workflow not found.")
    workflow = rows[0]
    execution = (sb.table("automation_executions").insert({
        "workspace_id": workspace_id,
        "workflow_id": workflow_id,
        "report_id": workflow.get("report_id"),
        "trigger_type": "manual",
        "status": "queued",
        "requested_by": user_id,
        "idempotency_key": f"manual:{workflow_id}:{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
        "definition_snapshot": {"trigger": workflow.get("trigger") or {}, "steps": workflow.get("steps") or []},
    }).execute().data or [])[0]
    audit(sb, workspace_id, user_id, "workflow.run.requested", "execution", execution["id"], {"workflow_id": workflow_id})
    return execution


def queue_scheduled_workflow(workflow: dict) -> dict:
    from .automation_service import _next_run
    sb = _admin_client()
    scheduled_for = workflow.get("next_run") or _now()
    key = f"schedule:{workflow['id']}:{scheduled_for}"
    rows = sb.table("automation_executions").upsert({
        "workspace_id": workflow["workspace_id"], "workflow_id": workflow["id"],
        "report_id": workflow.get("report_id"), "requested_by": workflow.get("owner_id"),
        "trigger_type": "schedule", "status": "queued", "idempotency_key": key,
        "definition_snapshot": {"trigger": workflow.get("trigger") or {}, "steps": workflow.get("steps") or []},
    }, on_conflict="idempotency_key").execute().data or []
    sb.table("automation_workflows").update({
        "next_run": _next_run(workflow.get("cron_expr"), workflow.get("timezone") or "UTC"),
        "locked_at": None, "locked_by": None, "updated_at": _now(),
    }).eq("id", workflow["id"]).execute()
    return rows[0] if rows else {"idempotency_key": key, "status": "queued"}


def execute_workflow_execution(execution: dict) -> dict:
    """Execute a version-pinned workflow sequentially with durable step records.

    Expensive report rendering and delivery is delegated to the existing subscription
    engine, preserving its idempotency, RLS checks, artifacts, and email retries.
    """
    from .automation_service import evaluate_alert, execute_subscription
    sb = _admin_client()
    snapshot = execution.get("definition_snapshot") or {}
    steps = snapshot.get("steps") or []
    completed = []
    try:
        for index, step in enumerate(steps):
            kind = str(step.get("type") or "")
            step_row = (sb.table("automation_execution_steps").upsert({
                "execution_id": execution["id"], "step_index": index, "step_type": kind,
                "status": "running", "input": step, "started_at": _now(),
            }, on_conflict="execution_id,step_index").execute().data or [])[0]
            output: dict[str, Any] = {}
            if kind in {"validate_refresh", "record_audit"}:
                output = {"ok": True}
            elif kind in {"generate_report", "export", "send_email"}:
                subscription_id = str(step.get("subscription_id") or "")
                rows = sb.table("report_subscriptions").select("*").eq("id", subscription_id).eq("workspace_id", execution["workspace_id"]).limit(1).execute().data or []
                if not rows:
                    raise ValueError(f"Workflow step {index + 1} needs a valid subscription_id.")
                output = execute_subscription({**rows[0], "next_run": _now()}, "workflow")
            elif kind == "evaluate_alert":
                alert_id = str(step.get("alert_id") or "")
                rows = sb.table("alert_rules").select("*").eq("id", alert_id).eq("workspace_id", execution["workspace_id"]).limit(1).execute().data or []
                if not rows:
                    raise ValueError(f"Workflow step {index + 1} needs a valid alert_id.")
                output = evaluate_alert(rows[0], "workflow")
            elif kind == "notify":
                from .notification_service import notify_workspace_members
                output = {"notifications": notify_workspace_members(
                    workspace_id=execution["workspace_id"], event_type="workflow.notification",
                    title=str(step.get("title") or "Automation completed"),
                    message=str(step.get("message") or "A VTAB workflow step completed."),
                    category="automation", severity=str(step.get("severity") or "info"),
                    report_id=execution.get("report_id"),
                    dedupe_prefix=f"workflow:{execution['id']}:{index}",
                    fallback_user_id=execution.get("requested_by"),
                )}
            elif kind == "refresh":
                # A refresh action is intentionally event-driven. The connector owns
                # provider execution and posts completion back to the refresh worker.
                output = {"queued": True, "report_id": execution.get("report_id")}
            else:
                raise ValueError(f"Unsupported workflow action: {kind}")
            sb.table("automation_execution_steps").update({"status": "succeeded", "output": output, "completed_at": _now()}).eq("id", step_row["id"]).execute()
            completed.append({"index": index, "type": kind, "status": "succeeded"})
            sb.table("automation_executions").update({"current_step": index + 1, "details": {"steps": completed}}).eq("id", execution["id"]).execute()
        patch = {"status": "succeeded", "completed_at": _now(), "details": {"steps": completed}}
        sb.table("automation_executions").update(patch).eq("id", execution["id"]).execute()
        if execution.get("workflow_id"):
            sb.table("automation_workflows").update({"last_run": _now(), "last_status": "succeeded", "last_error": None}).eq("id", execution["workflow_id"]).execute()
        return {**execution, **patch}
    except Exception as error:
        message = str(error)[:2000]
        retry = int(execution.get("attempt_count") or 1) < int(execution.get("max_attempts") or 3)
        patch = {"status": "queued" if retry else "dead_letter", "error_message": message, "details": {"steps": completed}, "completed_at": None if retry else _now()}
        if retry:
            from datetime import timedelta
            patch["retry_after"] = (datetime.now(timezone.utc) + timedelta(minutes=2 ** int(execution.get("attempt_count") or 1))).isoformat()
        sb.table("automation_executions").update(patch).eq("id", execution["id"]).execute()
        if execution.get("workflow_id"):
            sb.table("automation_workflows").update({"last_run": _now(), "last_status": "failed", "last_error": message}).eq("id", execution["workflow_id"]).execute()
        raise


def templates(workspace_id: str, user_id: str) -> list[dict]:
    require_feature(workspace_id, user_id, "template")
    return _admin_client().table("automation_email_templates").select("*").eq("workspace_id", workspace_id).order("name").execute().data or []


def save_template(workspace_id: str, payload: dict, user_id: str, template_id: str | None = None) -> dict:
    policy = require_feature(workspace_id, user_id, "template", manage=True)
    if not (policy.get("can_manage_policy") or policy.get("member_manage_own")):
        raise PermissionError("You cannot manage email templates.")
    values = {
        "workspace_id": workspace_id,
        "owner_id": user_id,
        "name": str(payload.get("name") or "Email template").strip()[:160],
        "subject": str(payload.get("subject") or "VTAB report delivery").strip()[:300],
        "html_body": str(payload.get("html_body") or "")[:100000],
        "text_body": str(payload.get("text_body") or "")[:100000],
        "updated_at": _now(),
    }
    sb = _admin_client()
    rows = (sb.table("automation_email_templates").update(values).eq("id", template_id).eq("workspace_id", workspace_id).execute().data if template_id else sb.table("automation_email_templates").insert(values).execute().data) or []
    return rows[0]
