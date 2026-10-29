from __future__ import annotations

import html
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from .supabase_store import _admin_client


DEFAULT_PREFERENCES = {
    "timezone": "UTC",
    "locale": "en-IN",
    "in_app_enabled": True,
    "email_enabled": True,
    "collaboration_in_app": True,
    "collaboration_email": True,
    "refresh_failure_in_app": True,
    "refresh_failure_email": True,
    "refresh_success_in_app": True,
    "refresh_success_email": True,
    "subscriptions_in_app": True,
    "subscriptions_email": True,
    "alerts_in_app": True,
    "alerts_email": True,
}

EDITABLE_PREFERENCE_FIELDS = set(DEFAULT_PREFERENCES)
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _database_error(error: Exception) -> RuntimeError:
    message = str(error)
    if "does not exist" in message or "schema cache" in message.lower():
        return RuntimeError("Notification services are not installed. Apply Supabase migration 017_notification_email_foundation.sql.")
    return RuntimeError(message)


def get_preferences(user_id: str) -> dict[str, Any]:
    sb = _admin_client()
    try:
        rows = sb.table("user_notification_preferences").select("*").eq("user_id", user_id).limit(1).execute().data or []
    except Exception as error:
        raise _database_error(error) from error
    return {**DEFAULT_PREFERENCES, **(rows[0] if rows else {}), "user_id": user_id}


def save_preferences(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    values = {key: payload[key] for key in EDITABLE_PREFERENCE_FIELDS if key in payload}
    values.update({"user_id": user_id, "updated_at": _now()})
    try:
        result = _admin_client().table("user_notification_preferences").upsert(values, on_conflict="user_id").execute().data or []
    except Exception as error:
        raise _database_error(error) from error
    return {**DEFAULT_PREFERENCES, **(result[0] if result else values)}


def list_notifications(user_id: str, *, limit: int = 30, cursor: str | None = None, unread_only: bool = False) -> dict[str, Any]:
    sb = _admin_client()
    safe_limit = max(1, min(int(limit), 100))
    try:
        query = sb.table("notifications").select("*").eq("user_id", user_id).is_("dismissed_at", "null")
        if unread_only:
            query = query.is_("read_at", "null")
        if cursor:
            query = query.lt("created_at", cursor)
        rows = query.order("created_at", desc=True).limit(safe_limit + 1).execute().data or []
        count_rows = sb.table("notifications").select("id", count="exact").eq("user_id", user_id).is_("dismissed_at", "null").is_("read_at", "null").execute()
    except Exception as error:
        raise _database_error(error) from error
    has_more = len(rows) > safe_limit
    items = rows[:safe_limit]
    return {
        "items": items,
        "unreadCount": int(count_rows.count or 0),
        "nextCursor": items[-1].get("created_at") if has_more and items else None,
    }


def update_notification(user_id: str, notification_id: str, *, read: bool | None = None, dismissed: bool | None = None) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    if read is not None:
        patch["read_at"] = _now() if read else None
    if dismissed is not None:
        patch["dismissed_at"] = _now() if dismissed else None
    if not patch:
        raise ValueError("Choose read or dismissed state to update.")
    rows = _admin_client().table("notifications").update(patch).eq("id", notification_id).eq("user_id", user_id).execute().data or []
    if not rows:
        raise ValueError("Notification not found.")
    return rows[0]


def mark_all_read(user_id: str) -> dict[str, Any]:
    _admin_client().table("notifications").update({"read_at": _now()}).eq("user_id", user_id).is_("read_at", "null").is_("dismissed_at", "null").execute()
    return {"ok": True}


def _user_email(sb, user_id: str) -> str:
    rows = sb.table("vtab_users").select("email").eq("id", user_id).limit(1).execute().data or []
    if rows and EMAIL_RE.match(str(rows[0].get("email") or "")):
        return str(rows[0]["email"]).strip().lower()
    try:
        response = sb.auth.admin.get_user_by_id(user_id)
        value = str(response.user.email or "") if response and response.user else ""
        return value.strip().lower() if EMAIL_RE.match(value.strip()) else ""
    except Exception:
        return ""


def _channel_flags(preferences: dict[str, Any], event_type: str, category: str) -> tuple[bool, bool]:
    if event_type.startswith("refresh.succeeded"):
        suffix = "refresh_success"
    elif event_type.startswith("refresh."):
        suffix = "refresh_failure"
    elif category == "alert":
        suffix = "alerts"
    elif category == "subscription":
        suffix = "subscriptions"
    else:
        suffix = "collaboration"
    return (
        bool(preferences.get("in_app_enabled", True) and preferences.get(f"{suffix}_in_app", True)),
        bool(preferences.get("email_enabled", True) and preferences.get(f"{suffix}_email", True)),
    )


def enqueue_email(
    *, user_id: str | None, recipient_email: str, subject: str, text_body: str,
    idempotency_key: str, category: str = "system", organization_id: str | None = None,
    workspace_id: str | None = None, notification_id: str | None = None,
    html_body: str | None = None, metadata: dict[str, Any] | None = None,
    attachment_storage_path: str | None = None, attachment_name: str | None = None,
    attachment_type: str | None = None,
) -> dict[str, Any]:
    recipient = recipient_email.strip().lower()
    if not EMAIL_RE.match(recipient):
        raise ValueError("A valid recipient email address is required.")
    sb = _admin_client()
    existing = sb.table("email_delivery_jobs").select("*").eq("idempotency_key", idempotency_key).limit(1).execute().data or []
    if existing:
        return existing[0]
    row = {
        "organization_id": organization_id, "workspace_id": workspace_id, "user_id": user_id,
        "notification_id": notification_id, "recipient_email": recipient, "subject": subject[:300],
        "text_body": text_body, "html_body": html_body, "category": category,
        "idempotency_key": idempotency_key, "metadata": metadata or {},
    }
    if attachment_storage_path:
        row.update({"attachment_storage_path": attachment_storage_path,"attachment_name": attachment_name,"attachment_type": attachment_type})
    try:
        result = sb.table("email_delivery_jobs").insert(row).execute().data or []
    except Exception as error:
        # A competing worker/request may have inserted the same logical message.
        existing = sb.table("email_delivery_jobs").select("*").eq("idempotency_key", idempotency_key).limit(1).execute().data or []
        if existing:
            try:
                from .email_worker import trigger_email_worker
                trigger_email_worker()
            except Exception:
                pass
            return existing[0]
        raise _database_error(error) from error
    try:
        from .email_worker import trigger_email_worker
        trigger_email_worker()
    except Exception:
        pass
    return result[0]


def create_notification(
    *, user_id: str, event_type: str, title: str, message: str, category: str = "system",
    severity: str = "info", organization_id: str | None = None, workspace_id: str | None = None,
    report_id: str | None = None, object_type: str | None = None, object_id: str | None = None,
    action_url: str | None = None, metadata: dict[str, Any] | None = None, dedupe_key: str | None = None,
    force_channels: list[str] | None = None,
    override_channels: list[str] | None = None,
) -> dict[str, Any]:
    sb = _admin_client()
    if override_channels is not None:
        in_app, email_enabled = "in_app" in override_channels, "email" in override_channels
    else:
        preferences = get_preferences(user_id)
        in_app, email_enabled = _channel_flags(preferences, event_type, category)
        if force_channels is not None:
            in_app, email_enabled = in_app and "in_app" in force_channels, email_enabled and "email" in force_channels
    notification: dict[str, Any] | None = None
    if in_app:
        row = {
            "organization_id": organization_id, "workspace_id": workspace_id, "report_id": report_id,
            "user_id": user_id, "event_type": event_type, "category": category, "severity": severity,
            "title": title[:300], "message": message[:4000], "object_type": object_type,
            "object_id": object_id, "action_url": action_url, "metadata": metadata or {}, "dedupe_key": dedupe_key,
        }
        try:
            rows = sb.table("notifications").insert(row).execute().data or []
            notification = rows[0] if rows else row
        except Exception as error:
            if dedupe_key:
                rows = sb.table("notifications").select("*").eq("user_id", user_id).eq("dedupe_key", dedupe_key).limit(1).execute().data or []
                if rows:
                    notification = rows[0]
                else:
                    raise _database_error(error) from error
            else:
                raise _database_error(error) from error
    if email_enabled:
        recipient = _user_email(sb, user_id)
        if recipient:
            safe_title = html.escape(title)
            safe_message = html.escape(message).replace("\n", "<br>")
            link = f'<p><a href="{html.escape(action_url, quote=True)}">Open in VTAB Services</a></p>' if action_url else ""
            enqueue_email(
                user_id=user_id, recipient_email=recipient, subject=title, text_body=message + (f"\n\nOpen: {action_url}" if action_url else ""),
                html_body=f"<h2>{safe_title}</h2><p>{safe_message}</p>{link}", category=category,
                organization_id=organization_id, workspace_id=workspace_id,
                notification_id=(notification or {}).get("id"), idempotency_key=f"notification:{dedupe_key or uuid.uuid4()}:{recipient}",
                metadata={"eventType": event_type, **(metadata or {})},
            )
    return {"notification": notification, "channels": {"inApp": in_app, "email": email_enabled}}


def get_workspace_member_users(workspace_id: str) -> list[dict[str, Any]]:
    """Return all members of a workspace with their user_id, role, and email."""
    if not workspace_id:
        return []
    sb = _admin_client()
    try:
        members = (
            sb.table("workspace_members")
            .select("user_id, role")
            .eq("workspace_id", workspace_id)
            .execute()
            .data or []
        )
        results = []
        for m in members:
            uid = str(m.get("user_id") or "").strip()
            if not uid:
                continue
            email = _user_email(sb, uid)
            results.append({
                "user_id": uid,
                "role": m.get("role") or "Member",
                "email": email,
            })
        return results
    except Exception as error:
        print(f"VTAB error fetching workspace members for {workspace_id}: {error}", flush=True)
        return []


def get_workspace_notification_policy(workspace_id: str) -> dict[str, str]:
    """Fetch the notification recipient policy for a workspace."""
    default_policy = {
        "scheduler": "all_members",
        "alert": "all_members",
        "subscription": "all_members"
    }
    if not workspace_id:
        return default_policy
    try:
        sb = _admin_client()
        row = sb.table("workspaces").select("description").eq("id", workspace_id).limit(1).execute().data or []
        if row and row[0].get("description"):
            desc = row[0]["description"]
            if desc and desc.startswith("{") and "notification_policy" in desc:
                data = json.loads(desc)
                p = data.get("notification_policy") or {}
                return {
                    "scheduler": p.get("scheduler") or "all_members",
                    "alert": p.get("alert") or "all_members",
                    "subscription": p.get("subscription") or "all_members",
                }
    except Exception as e:
        print(f"VTAB error reading workspace notification policy for {workspace_id}: {e}", flush=True)
    return default_policy


def save_workspace_notification_policy(workspace_id: str, policy: dict[str, str]) -> dict[str, str]:
    """Save the notification recipient policy for a workspace."""
    clean_policy = {
        "scheduler": "owner_only" if policy.get("scheduler") == "owner_only" else "all_members",
        "alert": "owner_only" if policy.get("alert") == "owner_only" else "all_members",
        "subscription": "owner_only" if policy.get("subscription") == "owner_only" else "all_members",
    }
    sb = _admin_client()
    row = sb.table("workspaces").select("description").eq("id", workspace_id).limit(1).execute().data or []
    existing_desc = row[0].get("description") if row else ""
    desc_text = ""
    if existing_desc:
        try:
            parsed = json.loads(existing_desc)
            if isinstance(parsed, dict):
                desc_text = parsed.get("text") or ""
            else:
                desc_text = str(existing_desc)
        except Exception:
            desc_text = str(existing_desc)
    payload = json.dumps({"text": desc_text, "notification_policy": clean_policy})
    sb.table("workspaces").update({"description": payload}).eq("id", workspace_id).execute()
    return clean_policy


def get_workspace_owner_info(workspace_id: str) -> dict[str, Any] | None:
    """Fetch the owner user_id and email for a workspace."""
    if not workspace_id:
        return None
    try:
        sb = _admin_client()
        ws_rows = sb.table("workspaces").select("id, name, owner_id, created_by").eq("id", workspace_id).limit(1).execute().data or []
        if not ws_rows:
            return None
        ws = ws_rows[0]
        owner_id = ws.get("owner_id") or ws.get("created_by")
        if not owner_id:
            admin_mem = sb.table("workspace_members").select("user_id").eq("workspace_id", workspace_id).eq("role", "Admin").limit(1).execute().data or []
            if admin_mem:
                owner_id = admin_mem[0].get("user_id")
        if owner_id:
            user_row = sb.table("vtab_users").select("id, email, display_name").eq("id", owner_id).limit(1).execute().data or []
            if user_row:
                return user_row[0]
            return {"id": owner_id, "email": _user_email(sb, owner_id), "display_name": "Workspace Owner"}
    except Exception as e:
        print(f"VTAB error resolving workspace owner for {workspace_id}: {e}", flush=True)
    return None


def notify_workspace_members(
    *,
    workspace_id: str,
    event_type: str,
    title: str,
    message: str,
    category: str = "system",
    severity: str = "info",
    report_id: str | None = None,
    object_type: str | None = None,
    object_id: str | None = None,
    action_url: str | None = None,
    metadata: dict[str, Any] | None = None,
    dedupe_prefix: str | None = None,
    override_channels: list[str] | None = None,
    force_channels: list[str] | None = None,
    fallback_user_id: str | None = None,
) -> list[dict[str, Any]]:
    """Send an in-app and email notification to members of the specified workspace according to configured policy."""
    policy = get_workspace_notification_policy(workspace_id)
    mode = "all_members"
    if category == "refresh":
        mode = policy.get("scheduler", "all_members")
    elif category == "alert":
        mode = policy.get("alert", "all_members")

    members = get_workspace_member_users(workspace_id)
    if mode == "owner_only":
        owner_info = get_workspace_owner_info(workspace_id)
        owner_id = owner_info.get("id") if owner_info else fallback_user_id
        target_user_ids = {owner_id} if owner_id else set()
    else:
        target_user_ids = {m["user_id"] for m in members if m.get("user_id")}

    if not target_user_ids and fallback_user_id:
        target_user_ids.add(fallback_user_id)

    results = []
    for uid in target_user_ids:
        dedupe = f"{dedupe_prefix}:{uid}" if dedupe_prefix else None
        try:
            res = create_notification(
                user_id=uid,
                event_type=event_type,
                category=category,
                severity=severity,
                title=title,
                message=message,
                workspace_id=workspace_id,
                report_id=report_id,
                object_type=object_type,
                object_id=object_id,
                action_url=action_url,
                metadata=metadata,
                dedupe_key=dedupe,
                override_channels=override_channels,
                force_channels=force_channels,
            )
            results.append(res)
        except Exception as error:
            print(f"VTAB notify member {uid} error: {error}", flush=True)
    return results


def publish_refresh_event(job: dict[str, Any], *, success: bool, error_message: str | None = None, details: dict[str, Any] | None = None, disabled: bool = False) -> dict[str, Any]:
    sb = _admin_client()
    report_rows = sb.table("published_reports").select("name,organization_id,workspace_id").eq("id", job["report_id"]).limit(1).execute().data or []
    report = report_rows[0] if report_rows else {}
    report_name = report.get("name") or job["report_id"]
    workspace_id = report.get("workspace_id")
    event_type = "refresh.disabled" if disabled else ("refresh.succeeded" if success else "refresh.failed")
    title = ("Refresh schedule disabled" if disabled else ("Refresh completed" if success else "Refresh failed")) + f": {report_name}"
    if success:
        rows = int((details or {}).get("rows") or 0)
        tables = len((details or {}).get("tables") or [])
        message = f"The scheduled refresh completed successfully. {tables} table(s) refreshed"
        if rows:
            message += f" with {rows:,} processed row(s)"
        message += "."
    else:
        message = (error_message or "The scheduled refresh failed.")[:3000]
        if disabled:
            message = "The refresh schedule was paused after repeated failures. " + message
    occurrence = (details or {}).get("runId") or job.get("last_run") or _now()
    dedupe_prefix = f"{event_type}:{job.get('id')}:{occurrence}"

    if workspace_id:
        results = notify_workspace_members(
            workspace_id=workspace_id,
            event_type=event_type,
            title=title,
            message=message,
            category="refresh",
            severity="success" if success else "error",
            report_id=job["report_id"],
            object_type="report",
            object_id=job["report_id"],
            action_url=f"/?viewer={job['report_id']}",
            metadata=details or {},
            dedupe_prefix=dedupe_prefix,
            fallback_user_id=job.get("created_by"),
            override_channels=["in_app", "email"],
        )
        return {"notifications": results, "count": len(results)}
    else:
        return create_notification(
            user_id=job["created_by"], event_type=event_type, category="refresh",
            severity="success" if success else "error", title=title, message=message,
            organization_id=report.get("organization_id"), workspace_id=workspace_id,
            report_id=job["report_id"], object_type="report", object_id=job["report_id"],
            action_url=f"/?viewer={job['report_id']}", metadata=details or {}, dedupe_key=dedupe_prefix,
            override_channels=["in_app", "email"],
        )

