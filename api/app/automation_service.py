from __future__ import annotations

import copy
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from croniter import croniter

from .exports import report_pdf
from .notification_service import create_notification, enqueue_email, notify_workspace_members
from .semantic_engine import execute
from .supabase_store import _admin_client, is_admin_user

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
OPERATORS = {
    "gt": lambda value, threshold: value > threshold,
    "gte": lambda value, threshold: value >= threshold,
    "lt": lambda value, threshold: value < threshold,
    "lte": lambda value, threshold: value <= threshold,
    "eq": lambda value, threshold: value == threshold,
    "neq": lambda value, threshold: value != threshold,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _report_access(sb, report_id: str, user_id: str, require_manage: bool = False) -> dict:
    rows = sb.table("published_reports").select("id,name,organization_id,workspace_id,owner_id,project_json").eq("id", report_id).limit(1).execute().data or []
    if not rows:
        raise ValueError("Published report not found.")
    report = rows[0]
    members = sb.table("workspace_members").select("role").eq("workspace_id", report.get("workspace_id")).eq("user_id", user_id).limit(1).execute().data or []
    grants = sb.table("report_access_grants").select("role").eq("report_id", report_id).eq("user_id", user_id).limit(1).execute().data or []
    roles = [str(row.get("role") or "") for row in [*members, *grants]]
    if str(report.get("owner_id")) == user_id:
        roles.append("Owner")
    if is_admin_user(user_id):
        roles.append("Admin")
    if not roles:
        raise PermissionError("You do not have access to this report.")
    if require_manage and not any(role in ("Owner", "Co-Owner", "Admin", "Member", "Contributor") for role in roles):
        raise PermissionError("You need edit access to manage this automation.")
    return report


def _managed_row(sb, table: str, item_id: str, user_id: str) -> dict:
    rows = sb.table(table).select("*").eq("id", item_id).limit(1).execute().data or []
    if not rows:
        raise ValueError("Automation item not found.")
    row = rows[0]
    if str(row.get("owner_id")) == user_id or is_admin_user(user_id):
        return row
    membership = sb.table("workspace_members").select("role").eq("workspace_id", row.get("workspace_id")).eq("user_id", user_id).eq("role", "Admin").limit(1).execute().data or []
    if not membership:
        raise PermissionError("You cannot manage another user's automation.")
    return row


def _schedule(payload: dict) -> tuple[str | None, str | None]:
    frequency = str(payload.get("frequency") or "daily")
    timezone_name = str(payload.get("timezone") or "UTC")
    try:
        local_now = datetime.now(ZoneInfo(timezone_name))
    except Exception as error:
        raise ValueError("Choose a valid IANA time zone.") from error
    if frequency == "after_refresh":
        return None, None
    time_value = str(payload.get("time") or "08:00")
    try:
        hour, minute = [int(part) for part in time_value.split(":", 1)]
        if not (0 <= hour <= 23 and 0 <= minute <= 59): raise ValueError
    except Exception as error:
        raise ValueError("Delivery time must use HH:MM format.") from error
    if frequency == "hourly":
        cron_expr = f"{minute} * * * *"
    elif frequency == "daily":
        cron_expr = f"{minute} {hour} * * *"
    elif frequency == "weekly":
        weekdays = payload.get("weekdays") or [local_now.weekday()]
        cron_days = sorted({(int(day) + 1) % 7 for day in weekdays if 0 <= int(day) <= 6})
        cron_expr = f"{minute} {hour} * * {','.join(map(str, cron_days))}"
    elif frequency == "monthly":
        day = max(1, min(int(payload.get("month_day") or 1), 28))
        cron_expr = f"{minute} {hour} {day} * *"
    else:
        raise ValueError("Frequency must be hourly, daily, weekly, monthly, or after_refresh.")
    next_local = croniter(cron_expr, local_now).get_next(datetime)
    return cron_expr, next_local.astimezone(timezone.utc).isoformat()


def _next_run(cron_expr: str | None, timezone_name: str) -> str | None:
    if not cron_expr:
        return None
    now = datetime.now(ZoneInfo(timezone_name or "UTC"))
    return croniter(cron_expr, now).get_next(datetime).astimezone(timezone.utc).isoformat()


def _recipient(sb, email: str, report_id: str, allow_external: bool) -> dict:
    value = email.strip().lower()
    if not EMAIL_RE.match(value):
        raise ValueError(f"Invalid recipient email: {email}")
    users = sb.table("vtab_users").select("id,email").ilike("email", value).limit(1).execute().data or []
    if not users:
        if allow_external:
            return {"user_id": None, "email": value, "external": True}
        raise ValueError(f"{value} is not a registered VTAB user. External delivery is disabled.")
    user_id = str(users[0]["id"])
    _report_access(sb, report_id, user_id)
    return {"user_id": user_id, "email": value, "external": False}


def list_subscriptions(user_id: str) -> list[dict]:
    sb = _admin_client()
    owned = sb.table("report_subscriptions").select("*").eq("owner_id", user_id).order("updated_at", desc=True).execute().data or []
    memberships = sb.table("workspace_members").select("workspace_id").eq("user_id", user_id).eq("role", "Admin").execute().data or []
    administered = []
    if memberships:
        administered = sb.table("report_subscriptions").select("*").in_("workspace_id", [row["workspace_id"] for row in memberships]).order("updated_at", desc=True).execute().data or []
    by_id = {row["id"]: row for row in [*owned, *administered]}
    for item in by_id.values():
        item["recipients"] = sb.table("subscription_recipients").select("id,user_id,email,status").eq("subscription_id", item["id"]).execute().data or []
    return sorted(by_id.values(), key=lambda row: row.get("updated_at") or "", reverse=True)


def save_subscription(payload: dict, user_id: str, subscription_id: str | None = None) -> dict:
    sb = _admin_client()
    if payload.get("include_preview"):
        raise ValueError("Inline email previews are not enabled. Use a secure report link or PDF attachment.")
    if subscription_id:
        existing = _managed_row(sb, "report_subscriptions", subscription_id, user_id)
        report_id = str(existing["report_id"])
        owner_id = str(existing["owner_id"])
    else:
        report_id = str(payload.get("report_id") or "").strip()
        owner_id = user_id
    report = _report_access(sb, report_id, user_id)
    recipients_payload = payload.get("recipients") or []
    if isinstance(recipients_payload, str):
        recipients_payload = [part.strip() for part in recipients_payload.split(",") if part.strip()]
    ws_id = report.get("workspace_id")
    if not recipients_payload and ws_id:
        from .notification_service import get_workspace_member_users
        ws_members = get_workspace_member_users(ws_id)
        recipients_payload = [m["email"] for m in ws_members if m.get("email")]
    if not recipients_payload:
        raise ValueError("Add at least one recipient.")
    max_recipients = max(1, min(int(os.environ.get("VTAB_SUBSCRIPTION_MAX_RECIPIENTS", "25")), 200))
    if len(set(recipients_payload)) > max_recipients:
        raise ValueError(f"A subscription can contain at most {max_recipients} recipients.")
    allow_external = os.environ.get("VTAB_ALLOW_EXTERNAL_EMAIL", "0") == "1"
    recipients = [_recipient(sb, str(email), report_id, allow_external) for email in sorted(set(recipients_payload))]
    attachment = (str(payload.get("attachment_format") or "").lower() or None)
    if attachment not in (None, "pdf"):
        raise ValueError("Only PDF attachments are currently supported.")
    if attachment and any(item["external"] for item in recipients):
        raise ValueError("External recipients cannot receive report attachments.")
    cron_expr, next_run = _schedule(payload)
    values = {
        "organization_id": report.get("organization_id"), "workspace_id": report.get("workspace_id"),
        "report_id": report_id, "owner_id": owner_id,
        "name": str(payload.get("name") or f"{report.get('name')} subscription").strip()[:200],
        "page_id": payload.get("page_id") or None,
        "subject": str(payload.get("subject") or f"VTAB Report: {report.get('name')}").strip()[:300],
        "message": str(payload.get("message") or ""), "frequency": payload.get("frequency") or "daily",
        "cron_expr": cron_expr, "timezone": payload.get("timezone") or "UTC",
        "include_link": bool(payload.get("include_link", True)), "include_preview": bool(payload.get("include_preview", False)),
        "attachment_format": attachment, "filter_context": payload.get("filter_context") or [],
        "parameter_context": payload.get("parameter_context") or {}, "status": payload.get("status") or "active",
        "next_run": next_run if (payload.get("status") or "active") == "active" else None, "updated_at": utc_now(),
    }
    if subscription_id:
        rows = sb.table("report_subscriptions").update(values).eq("id", subscription_id).execute().data or []
        sb.table("subscription_recipients").delete().eq("subscription_id", subscription_id).execute()
    else:
        rows = sb.table("report_subscriptions").insert(values).execute().data or []
    ws_id = report.get("workspace_id")
    if ws_id:
        from .notification_service import get_workspace_member_users
        ws_members = get_workspace_member_users(ws_id)
        existing_emails = {str(item.get("email") or "").strip().lower() for item in recipients if item.get("email")}
        for mem in ws_members:
            mem_email = str(mem.get("email") or "").strip().lower()
            if mem_email and mem_email not in existing_emails:
                recipients.append({"email": mem["email"], "user_id": mem["user_id"], "name": mem.get("role")})
                existing_emails.add(mem_email)
    saved = rows[0]
    sb.table("subscription_recipients").insert([
        {
            "subscription_id": saved["id"],
            "user_id": item.get("user_id"),
            "email": item["email"],
            "status": "active",
        }
        for item in recipients
    ]).execute()
    create_notification(user_id=owner_id,event_type="subscription.saved",category="subscription",title="Subscription saved",message=f"{saved['name']} is {saved['status']}.",workspace_id=saved.get("workspace_id"),report_id=report_id,object_type="subscription",object_id=saved["id"],dedupe_key=f"subscription.saved:{saved['id']}:{saved.get('updated_at')}")
    saved["recipients"] = recipients
    return saved


def set_subscription_status(subscription_id: str, status: str, user_id: str) -> dict:
    if status not in ("active", "paused"):
        raise ValueError("Subscription status must be active or paused.")
    sb = _admin_client(); row = _managed_row(sb,"report_subscriptions",subscription_id,user_id)
    patch = {"status":status,"locked_at":None,"locked_by":None,"updated_at":utc_now(),"next_run":_next_run(row.get("cron_expr"),row.get("timezone") or "UTC") if status=="active" else None}
    return (sb.table("report_subscriptions").update(patch).eq("id",subscription_id).execute().data or [{**row,**patch}])[0]


def delete_subscription(subscription_id: str, user_id: str) -> dict:
    sb=_admin_client();_managed_row(sb,"report_subscriptions",subscription_id,user_id);sb.table("report_subscriptions").delete().eq("id",subscription_id).execute();return {"ok":True}


def _hydrate_project(project: dict) -> dict:
    from .reporting_service import _hydrate_snapshot_sources_uncached
    token = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("VITE_SUPABASE_SERVICE_ROLE_KEY") or "service"
    return _hydrate_snapshot_sources_uncached(project, token, skip_auth_check=True)


def execute_subscription(subscription: dict, trigger_type: str = "schedule") -> dict:
    sb = _admin_client(); scheduled_for = subscription.get("next_run") or utc_now()
    existing = sb.table("subscription_executions").select("*").eq("subscription_id",subscription["id"]).eq("scheduled_for",scheduled_for).eq("trigger_type",trigger_type).limit(1).execute().data or []
    if existing and existing[0].get("status") in ("succeeded","partial"):
        return existing[0]
    recipients = sb.table("subscription_recipients").select("*").eq("subscription_id",subscription["id"]).eq("status","active").execute().data or []
    ws_id = subscription.get("workspace_id")
    if not ws_id:
        rep_ws = sb.table("published_reports").select("workspace_id").eq("id", subscription["report_id"]).limit(1).execute().data or []
        ws_id = rep_ws[0].get("workspace_id") if rep_ws else None
    if ws_id:
        from .notification_service import get_workspace_member_users, get_workspace_notification_policy, get_workspace_owner_info
        policy = get_workspace_notification_policy(ws_id)
        sub_mode = policy.get("subscription", "all_members")
        if sub_mode == "owner_only":
            owner = get_workspace_owner_info(ws_id)
            owner_email = (owner.get("email") or "").strip().lower() if owner else ""
            owner_uid = owner.get("id") if owner else None
            recipients = []
            if owner_email:
                recipients.append({
                    "id": f"ws-{owner_uid or 'owner'}",
                    "subscription_id": subscription["id"],
                    "user_id": owner_uid,
                    "email": owner_email,
                    "status": "active",
                })
        else:
            ws_members = get_workspace_member_users(ws_id)
            current_member_uids = {m["user_id"] for m in ws_members if m.get("user_id")}
            # Prune any recipient whose user_id was removed from this workspace
            recipients = [
                r for r in recipients
                if not r.get("user_id") or r.get("user_id") in current_member_uids
            ]
            existing_emails = {str(r.get("email") or "").strip().lower() for r in recipients if r.get("email")}
            for mem in ws_members:
                mem_email = str(mem.get("email") or "").strip().lower()
                if mem_email and mem_email not in existing_emails:
                    recipients.append({
                        "id": f"ws-{mem['user_id']}",
                        "subscription_id": subscription["id"],
                        "user_id": mem["user_id"],
                        "email": mem["email"],
                        "status": "active",
                    })
                    existing_emails.add(mem_email)
    execution_values={"subscription_id":subscription["id"],"scheduled_for":scheduled_for,"trigger_type":trigger_type,"status":"rendering","render_status":"pending","delivery_status":"pending","recipients_total":len(recipients),"started_at":utc_now()}
    if existing:
        execution=(sb.table("subscription_executions").update(execution_values).eq("id",existing[0]["id"]).execute().data or [existing[0]])[0]
    else:
        execution=(sb.table("subscription_executions").insert(execution_values).execute().data or [execution_values])[0]
    try:
        report_rows=sb.table("published_reports").select("name,project_json,workspace_id").eq("id",subscription["report_id"]).limit(1).execute().data or []
        if not report_rows:raise ValueError("The subscribed report no longer exists.")
        report=report_rows[0];project=report.get("project_json") or {}
        if isinstance(project,str):
            import json;project=json.loads(project or "{}")
        if subscription.get("page_id"):
            project=copy.deepcopy(project);pages=((project.get("report") or {}).get("pages") or [])
            project.setdefault("report",{})["pages"]=[page for page in pages if str(page.get("id"))==str(subscription["page_id"])]
            if not project["report"]["pages"]:raise ValueError("The subscribed report page no longer exists.")
        attachment=None
        if subscription.get("attachment_format")=="pdf":
            attachment=report_pdf(_hydrate_project(project))
            limit=int(os.environ.get("VTAB_SUBSCRIPTION_ATTACHMENT_MAX_BYTES",str(20*1024*1024)))
            if len(attachment)>limit:raise ValueError("The generated PDF exceeds the configured attachment limit.")
        sent=0;blocked=[];base=(os.environ.get("VTAB_WORKSPACE_BASE_URL") or "").rstrip("/")
        url=f"{base}/?viewer={subscription['report_id']}" if base else f"/?viewer={subscription['report_id']}"
        for recipient in recipients:
            try:
                if recipient.get("user_id"):_report_access(sb,subscription["report_id"],str(recipient["user_id"]))
                elif os.environ.get("VTAB_ALLOW_EXTERNAL_EMAIL","0")!="1":raise PermissionError("External delivery is disabled.")
                body=subscription.get("message") or f"Your VTAB report subscription for {report.get('name')} is ready."
                attachment_path=None
                if attachment:
                    attachment_path=f"{subscription['owner_id']}/{execution['id']}/{recipient['id']}.pdf"
                    sb.storage.from_("vtab-email-artifacts").upload(attachment_path,attachment,{"content-type":"application/pdf","upsert":"true"})
                enqueue_email(user_id=recipient.get("user_id"),recipient_email=recipient["email"],subject=subscription["subject"],text_body=body+(f"\n\nOpen report: {url}" if subscription.get("include_link",True) else ""),html_body=f"<p>{body}</p>"+(f'<p><a href="{url}">Open report</a></p>' if subscription.get("include_link",True) else ""),idempotency_key=f"subscription:{subscription['id']}:{scheduled_for}:{recipient['id']}",category="subscription",workspace_id=subscription.get("workspace_id"),attachment_storage_path=attachment_path,attachment_name=f"{report.get('name') or 'VTAB Report'}.pdf" if attachment_path else None,attachment_type="pdf" if attachment_path else None,metadata={"subscriptionId":subscription["id"],"executionId":execution["id"]});sent+=1
            except Exception as error:blocked.append({"email":recipient["email"],"error":str(error)})
        final="succeeded" if sent==len(recipients) else ("partial" if sent else "failed")
        patch={"status":final,"render_status":"succeeded","delivery_status":"queued" if sent else "failed","recipients_sent":sent,"error_message":"; ".join(item["error"] for item in blocked)[:2000] or None,"details":{"blocked":blocked},"completed_at":utc_now()}
        sb.table("subscription_executions").update(patch).eq("id",execution["id"]).execute()
        sb.table("report_subscriptions").update({"last_run":utc_now(),"last_status":final,"last_error":patch["error_message"],"next_run":_next_run(subscription.get("cron_expr"),subscription.get("timezone") or "UTC"),"locked_at":None,"locked_by":None,"updated_at":utc_now()}).eq("id",subscription["id"]).execute()
        if final=="failed":
            ws_sub_id=subscription.get("workspace_id")
            if ws_sub_id:
                notify_workspace_members(
                    workspace_id=ws_sub_id,
                    event_type="subscription.failed",
                    title="Subscription delivery failed",
                    message=patch["error_message"] or "No authorized recipient could be queued.",
                    category="subscription",
                    severity="error",
                    report_id=subscription["report_id"],
                    object_type="subscription",
                    object_id=subscription["id"],
                    dedupe_prefix=f"subscription.failed:{execution['id']}",
                    fallback_user_id=subscription["owner_id"],
                )
            else:
                create_notification(user_id=subscription["owner_id"],event_type="subscription.failed",category="subscription",severity="error",title="Subscription delivery failed",message=patch["error_message"] or "No authorized recipient could be queued.",workspace_id=ws_sub_id,report_id=subscription["report_id"],object_type="subscription",object_id=subscription["id"],dedupe_key=f"subscription.failed:{execution['id']}")
        return {**execution,**patch}
    except Exception as error:
        message=str(error)[:2000];sb.table("subscription_executions").update({"status":"failed","render_status":"failed","delivery_status":"not_started","error_message":message,"completed_at":utc_now()}).eq("id",execution["id"]).execute();sb.table("report_subscriptions").update({"last_run":utc_now(),"last_status":"failed","last_error":message,"next_run":_next_run(subscription.get("cron_expr"),subscription.get("timezone") or "UTC"),"locked_at":None,"locked_by":None,"updated_at":utc_now()}).eq("id",subscription["id"]).execute();raise


def test_subscription(subscription_id: str,user_id: str)->dict:
    sb=_admin_client();row=_managed_row(sb,"report_subscriptions",subscription_id,user_id);row={**row,"next_run":utc_now()};return execute_subscription(row,"test")


def list_alerts(user_id:str)->list[dict]:
    sb=_admin_client();owned=sb.table("alert_rules").select("*").eq("owner_id",user_id).order("updated_at",desc=True).execute().data or []
    memberships=sb.table("workspace_members").select("workspace_id").eq("user_id",user_id).eq("role","Admin").execute().data or [];admin=[]
    if memberships:admin=sb.table("alert_rules").select("*").in_("workspace_id",[row["workspace_id"] for row in memberships]).execute().data or []
    return sorted({row["id"]:row for row in [*owned,*admin]}.values(),key=lambda row:row.get("updated_at") or "",reverse=True)


def save_alert(payload:dict,user_id:str,alert_id:str|None=None)->dict:
    sb=_admin_client()
    if alert_id:
        existing=_managed_row(sb,"alert_rules",alert_id,user_id);report_id=str(existing["report_id"]);owner_id=str(existing["owner_id"])
    else:report_id=str(payload.get("report_id") or "").strip();owner_id=user_id
    report=_report_access(sb,report_id,user_id);project=report.get("project_json") or {}
    if isinstance(project,str):
        import json;project=json.loads(project or "{}")
    measure_name=str(payload.get("measure_name") or "").strip()
    if measure_name not in ((project.get("model") or {}).get("measures") or {}):raise ValueError("Choose an existing semantic-model measure.")
    operator=str(payload.get("operator") or "gte");
    if operator not in OPERATORS:raise ValueError("Choose a supported comparison operator.")
    try:threshold=Decimal(str(payload.get("threshold")))
    except Exception as error:raise ValueError("Threshold must be numeric.") from error
    mode=str(payload.get("evaluation_mode") or "after_refresh");minutes=max(5,min(int(payload.get("evaluation_minutes") or 60),10080))
    values={"organization_id":report.get("organization_id"),"workspace_id":report.get("workspace_id"),"report_id":report_id,"owner_id":owner_id,"name":str(payload.get("name") or f"{measure_name} alert")[:200],"measure_name":measure_name,"visual_id":payload.get("visual_id") or None,"operator":operator,"threshold":str(threshold),"filter_context":payload.get("filter_context") or [],"channels":[channel for channel in (payload.get("channels") or ["in_app","email"]) if channel in ("in_app","email")],"evaluation_mode":mode,"evaluation_minutes":minutes,"cooldown_minutes":max(0,min(int(payload.get("cooldown_minutes") or 60),43200)),"repeat_enabled":bool(payload.get("repeat_enabled",False)),"recovery_enabled":bool(payload.get("recovery_enabled",True)),"status":payload.get("status") or "active","next_evaluation_at":(datetime.now(timezone.utc)+timedelta(minutes=minutes)).isoformat() if mode=="interval" else None,"locked_at":None,"locked_by":None,"updated_at":utc_now()}
    rows=(sb.table("alert_rules").update(values).eq("id",alert_id).execute().data if alert_id else sb.table("alert_rules").insert(values).execute().data) or []
    if not rows:raise RuntimeError("The alert could not be saved.")
    return rows[0]


def _numeric(value:Any)->Decimal:
    if value is None or isinstance(value,bool):raise ValueError("The alert measure did not return a numeric value.")
    return Decimal(str(value))


def evaluate_alert(rule:dict,trigger_type:str="interval")->dict:
    sb=_admin_client();previous=str(rule.get("current_state") or "normal");now=datetime.now(timezone.utc)
    try:
        report=_report_access(sb,rule["report_id"],rule["owner_id"]);project=report.get("project_json") or {}
        if isinstance(project,str):
            import json;project=json.loads(project or "{}")
        project=_hydrate_project(project)
        from .rls_runtime import resolve_published_rls_for_user
        resolved=resolve_published_rls_for_user(rule["report_id"],project,rule["owner_id"])
        rows,_=execute(project["model"],{"dimensions":[],"measures":[rule["measure_name"]],"filters":rule.get("filter_context") or [],"sort":[],"limit":1},resolved["rules"])
        value=_numeric((rows[0] if rows else {}).get(rule["measure_name"]));threshold=_numeric(rule["threshold"]);met=OPERATORS[rule["operator"]](value,threshold)
        if met:new_state="triggered" if previous in ("normal","recovered","error") else "sustained"
        else:new_state="recovered" if previous in ("triggered","sustained") else "normal"
        evaluation=(sb.table("alert_evaluations").insert({"alert_rule_id":rule["id"],"value":str(value),"previous_state":previous,"new_state":new_state,"condition_met":met,"data_context":{"trigger":trigger_type}}).execute().data or [])[0]
        notify_type=None
        if new_state=="triggered":notify_type="triggered"
        elif new_state=="recovered" and rule.get("recovery_enabled",True):notify_type="recovered"
        elif new_state=="sustained" and rule.get("repeat_enabled"):
            last=rule.get("last_notified_at");elapsed=(now-datetime.fromisoformat(last.replace("Z","+00:00"))).total_seconds()/60 if last else 10**9
            if elapsed>=int(rule.get("cooldown_minutes") or 60):notify_type="repeated"
        state_version=int(rule.get("state_version") or 0)+(1 if notify_type else 0);notification_id=None
        if notify_type:
            title=("Alert recovered" if notify_type=="recovered" else "Data alert")+f": {rule['name']}"
            message=f"{rule['measure_name']} is {value} (threshold {rule['operator']} {threshold})."
            ws_id=rule.get("workspace_id") or (report.get("workspace_id") if isinstance(report, dict) else None)
            channels=rule.get("channels") or ["in_app","email"]
            if ws_id:
                member_results=notify_workspace_members(
                    workspace_id=ws_id,
                    event_type=f"alert.{notify_type}",
                    title=title,
                    message=message,
                    category="alert",
                    severity="success" if notify_type=="recovered" else "warning",
                    report_id=rule["report_id"],
                    object_type="alert",
                    object_id=rule["id"],
                    action_url=f"/?viewer={rule['report_id']}",
                    metadata={"value":str(value),"threshold":str(threshold)},
                    dedupe_prefix=f"alert:{rule['id']}:{state_version}:{notify_type}",
                    force_channels=channels,
                    fallback_user_id=rule["owner_id"],
                )
                owner_res=next((r for r in member_results if (r.get("notification") or {}).get("user_id")==rule["owner_id"]), member_results[0] if member_results else {})
                notification_id=(owner_res.get("notification") or {}).get("id")
            else:
                result=create_notification(user_id=rule["owner_id"],event_type=f"alert.{notify_type}",category="alert",severity="success" if notify_type=="recovered" else "warning",title=title,message=message,workspace_id=ws_id,report_id=rule["report_id"],object_type="alert",object_id=rule["id"],action_url=f"/?viewer={rule['report_id']}",metadata={"value":str(value),"threshold":str(threshold)},dedupe_key=f"alert:{rule['id']}:{state_version}:{notify_type}",force_channels=channels)
                notification_id=(result.get("notification") or {}).get("id")
            sb.table("alert_events").insert({"alert_rule_id":rule["id"],"evaluation_id":evaluation["id"],"event_type":notify_type,"value":str(value),"threshold":str(threshold),"notification_id":notification_id,"delivery_status":"queued"}).execute()
        patch={"current_state":new_state,"current_value":str(value),"last_evaluated_at":utc_now(),"last_triggered_at":utc_now() if new_state=="triggered" else rule.get("last_triggered_at"),"last_notified_at":utc_now() if notify_type else rule.get("last_notified_at"),"last_error":None,"next_evaluation_at":(now+timedelta(minutes=int(rule.get("evaluation_minutes") or 60))).isoformat() if rule.get("evaluation_mode")=="interval" else None,"locked_at":None,"locked_by":None,"state_version":state_version,"updated_at":utc_now()};sb.table("alert_rules").update(patch).eq("id",rule["id"]).execute();return {**patch,"condition_met":met,"evaluation_id":evaluation["id"],"notification_event":notify_type}
    except Exception as error:
        message=str(error)[:2000];evaluation=(sb.table("alert_evaluations").insert({"alert_rule_id":rule["id"],"previous_state":previous,"new_state":"error","condition_met":None,"error_message":message,"data_context":{"trigger":trigger_type}}).execute().data or [{}])[0];state_version=int(rule.get("state_version") or 0)+1
        if previous!="error":
            ws_id=rule.get("workspace_id")
            channels=rule.get("channels") or ["in_app","email"]
            notification_id=None
            if ws_id:
                member_results=notify_workspace_members(
                    workspace_id=ws_id,
                    event_type="alert.error",
                    title=f"Alert evaluation failed: {rule['name']}",
                    message=message,
                    category="alert",
                    severity="error",
                    report_id=rule["report_id"],
                    object_type="alert",
                    object_id=rule["id"],
                    dedupe_prefix=f"alert:{rule['id']}:{state_version}:error",
                    force_channels=channels,
                    fallback_user_id=rule["owner_id"],
                )
                owner_res=next((r for r in member_results if (r.get("notification") or {}).get("user_id")==rule["owner_id"]), member_results[0] if member_results else {})
                notification_id=(owner_res.get("notification") or {}).get("id")
            else:
                result=create_notification(user_id=rule["owner_id"],event_type="alert.error",category="alert",severity="error",title=f"Alert evaluation failed: {rule['name']}",message=message,workspace_id=ws_id,report_id=rule["report_id"],object_type="alert",object_id=rule["id"],dedupe_key=f"alert:{rule['id']}:{state_version}:error",force_channels=channels)
                notification_id=(result.get("notification") or {}).get("id")
            sb.table("alert_events").insert({"alert_rule_id":rule["id"],"evaluation_id":evaluation.get("id"),"event_type":"error","notification_id":notification_id,"delivery_status":"queued"}).execute()
        sb.table("alert_rules").update({"current_state":"error","last_evaluated_at":utc_now(),"last_error":message,"next_evaluation_at":(now+timedelta(minutes=int(rule.get("evaluation_minutes") or 60))).isoformat() if rule.get("evaluation_mode")=="interval" else None,"locked_at":None,"locked_by":None,"state_version":state_version,"updated_at":utc_now()}).eq("id",rule["id"]).execute();raise


def alert_history(alert_id:str,user_id:str)->dict:
    sb=_admin_client();rule=_managed_row(sb,"alert_rules",alert_id,user_id);evaluations=sb.table("alert_evaluations").select("*").eq("alert_rule_id",alert_id).order("evaluated_at",desc=True).limit(100).execute().data or [];events=sb.table("alert_events").select("*").eq("alert_rule_id",alert_id).order("created_at",desc=True).limit(100).execute().data or [];return {"rule":rule,"evaluations":evaluations,"events":events}


def set_alert_status(alert_id:str,status:str,user_id:str)->dict:
    if status not in ("active","paused"):raise ValueError("Alert status must be active or paused.")
    sb=_admin_client();row=_managed_row(sb,"alert_rules",alert_id,user_id);patch={"status":status,"locked_at":None,"locked_by":None,"next_evaluation_at":utc_now() if status=="active" and row.get("evaluation_mode")=="interval" else None,"updated_at":utc_now()};return (sb.table("alert_rules").update(patch).eq("id",alert_id).execute().data or [{**row,**patch}])[0]


def delete_alert(alert_id:str,user_id:str)->dict:
    sb=_admin_client();_managed_row(sb,"alert_rules",alert_id,user_id);sb.table("alert_rules").delete().eq("id",alert_id).execute();return {"ok":True}


def queue_after_refresh(report_id:str)->None:
    sb=_admin_client();now=utc_now();sb.table("report_subscriptions").update({"next_run":now,"updated_at":now}).eq("report_id",report_id).eq("frequency","after_refresh").eq("status","active").execute();sb.table("alert_rules").update({"next_evaluation_at":now,"updated_at":now}).eq("report_id",report_id).eq("evaluation_mode","after_refresh").eq("status","active").execute()

