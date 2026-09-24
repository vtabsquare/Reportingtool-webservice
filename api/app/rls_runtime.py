"""Trusted Row-Level Security resolution for published semantic queries.

Desktop may simulate a role, but Services never trusts a browser supplied role id.
The authenticated Supabase identity, application access and stored semantic-model
memberships are resolved here before query compilation.
"""
from __future__ import annotations

from typing import Any

from .reporting_service import authenticate, get_semantic_model, _workspace_access
from .supabase_store import _admin_client

EDITOR_ROLES = {"Admin", "Member", "Contributor", "Owner", "Co-Owner"}


def _roles(project: dict[str, Any]) -> list[dict[str, Any]]:
    security = project.get("security") if isinstance(project.get("security"), dict) else {}
    return [r for r in (security.get("roles") or []) if isinstance(r, dict) and r.get("enabled", True)]


def _replace_identity(value: Any, user: dict[str, Any]) -> Any:
    if not isinstance(value, str):
        return value
    token = value.strip().upper()
    if token in {"CURRENT_USER_EMAIL()", "USERPRINCIPALNAME()", "USERNAME()"}:
        return str(user.get("email") or "").strip().lower()
    if token == "CURRENT_USER_ID()":
        return str(user.get("id") or "")
    if token == "CURRENT_USER_NAME()":
        metadata = user.get("user_metadata") if isinstance(user.get("user_metadata"), dict) else {}
        return str(metadata.get("display_name") or metadata.get("full_name") or user.get("email") or "")
    return value


def _deny_rule(project: dict[str, Any]) -> list[dict[str, Any]]:
    tables = (project.get("model") or {}).get("tables") or {}
    for table_name, table in tables.items():
        columns = (table or {}).get("columns") or {}
        if columns:
            return [{"table": table_name, "column": next(iter(columns)), "operator": "deny_all", "value": None, "_roleId": "__deny__"}]
    return [{"table": "", "column": "", "operator": "deny_all", "value": None, "_roleId": "__deny__"}]


def resolve_published_rls(report_id: str, project: dict[str, Any], access_token: str) -> dict[str, Any]:
    """Return trusted application/RLS context and compiled role rules.

    Editors mirror Power BI and bypass RLS during normal viewing. A Viewer with
    published RLS roles but no assignment is denied all rows (fail closed).
    """
    user = authenticate(access_token)
    user_id = str(user.get("id") or "")
    sb = _admin_client()
    report_rows = sb.table("published_reports").select("id,workspace_id,semantic_model_id").eq("id", report_id).limit(1).execute().data or []
    if not report_rows:
        raise PermissionError("Published report was not found or is no longer available.")
    report = report_rows[0]
    workspace_id = str(report.get("workspace_id") or "")
    workspace_rows = sb.table("workspace_members").select("role").eq("workspace_id", workspace_id).eq("user_id", user_id).limit(1).execute().data or []
    grant_rows = sb.table("report_access_grants").select("role").eq("report_id", report_id).eq("user_id", user_id).limit(1).execute().data or []
    if not workspace_rows and not grant_rows:
        raise PermissionError("You do not have access to this report.")
    access_roles = [str(row.get("role") or "Viewer") for row in [*workspace_rows, *grant_rows]]
    application_role = next((role for role in access_roles if role in EDITOR_ROLES), access_roles[0] if access_roles else "Viewer")
    role_defs = _roles(project)
    context = {
        "userId": user_id,
        "email": str(user.get("email") or "").strip().lower(),
        "applicationRole": application_role,
        "semanticModelId": str(report.get("semantic_model_id") or ""),
        "rlsRoleIds": [],
        "bypassed": application_role in EDITOR_ROLES,
    }
    if not role_defs or context["bypassed"]:
        return {"context": context, "rules": []}

    model_id = context["semanticModelId"]
    direct = sb.table("semantic_model_rls_members").select("role_id").eq("semantic_model_id", model_id).eq("principal_type", "user").eq("principal_id", user_id).execute().data or []
    group_rows = sb.table("security_group_members").select("group_id").eq("user_id", user_id).execute().data or []
    group_ids = [str(row.get("group_id")) for row in group_rows if row.get("group_id")]
    grouped: list[dict[str, Any]] = []
    if group_ids:
        grouped = sb.table("semantic_model_rls_members").select("role_id").eq("semantic_model_id", model_id).eq("principal_type", "group").in_("principal_id", group_ids).execute().data or []
    assigned = {str(row.get("role_id")) for row in [*direct, *grouped] if row.get("role_id")}
    context["rlsRoleIds"] = sorted(assigned)
    if not assigned:
        return {"context": context, "rules": _deny_rule(project)}

    rules: list[dict[str, Any]] = []
    for role in role_defs:
        role_id = str(role.get("id") or "")
        if role_id not in assigned:
            continue
        for rule in role.get("rules") or []:
            if not isinstance(rule, dict):
                continue
            rules.append({**rule, "value": _replace_identity(rule.get("value"), user), "_roleId": role_id})
    return {"context": context, "rules": rules or _deny_rule(project)}


def get_configuration(semantic_model_id: str, access_token: str) -> dict[str, Any]:
    model = get_semantic_model(semantic_model_id, access_token)
    workspace = _workspace_access(str(model["workspace_id"]), access_token)
    sb = _admin_client()
    memberships = sb.table("semantic_model_rls_members").select("id,role_id,principal_type,principal_id,principal_email,created_at").eq("semantic_model_id", semantic_model_id).order("created_at").execute().data or []
    groups = sb.table("security_groups").select("id,name,description").eq("workspace_id", model["workspace_id"]).order("name").execute().data or []
    for group in groups:
        group["members"] = sb.table("security_group_members").select("user_id").eq("group_id", group["id"]).execute().data or []
    definition = model.get("definition") if isinstance(model.get("definition"), dict) else {}
    security = definition.get("security") if isinstance(definition.get("security"), dict) else {}
    return {"roles": security.get("roles") or [], "memberships": memberships, "groups": groups, "canManage": bool(workspace.get("canPublish")), "workspaceRole": workspace.get("role")}


def add_member(semantic_model_id: str, role_id: str, principal_type: str, principal: str, access_token: str) -> dict[str, Any]:
    model = get_semantic_model(semantic_model_id, access_token)
    workspace = _workspace_access(str(model["workspace_id"]), access_token, require_manage=True)
    definition = model.get("definition") if isinstance(model.get("definition"), dict) else {}
    roles = ((definition.get("security") or {}).get("roles") or [])
    if not any(str(r.get("id")) == role_id for r in roles if isinstance(r, dict)):
        raise ValueError("The selected RLS role is not part of this semantic model.")
    sb = _admin_client()
    if principal_type == "group":
        rows = sb.table("security_groups").select("id,name").eq("id", principal).eq("workspace_id", model["workspace_id"]).limit(1).execute().data or []
        if not rows:
            raise ValueError("Security group not found in this workspace.")
        principal_id, label = str(rows[0]["id"]), str(rows[0]["name"])
    else:
        email = principal.strip().lower()
        rows = sb.table("vtab_users").select("id,email").ilike("email", email).limit(1).execute().data or []
        if not rows:
            raise ValueError("Only registered VTAB users can be assigned to an RLS role.")
        principal_type, principal_id, label = "user", str(rows[0]["id"]), str(rows[0]["email"]).lower()
    payload = {"semantic_model_id": semantic_model_id, "role_id": role_id, "principal_type": principal_type, "principal_id": principal_id, "principal_email": label if principal_type == "user" else None, "assigned_by": authenticate(access_token)["id"]}
    sb.table("semantic_model_rls_members").upsert(payload, on_conflict="semantic_model_id,role_id,principal_type,principal_id").execute()
    sb.table("audit_logs").insert({"workspace_id": model["workspace_id"], "actor_id": payload["assigned_by"], "action": "rls.member.assign", "object_type": "semantic_model", "object_id": semantic_model_id, "details": {"roleId": role_id, "principalType": principal_type, "principal": label}}).execute()
    return get_configuration(semantic_model_id, access_token)


def remove_member(semantic_model_id: str, membership_id: str, access_token: str) -> dict[str, Any]:
    model = get_semantic_model(semantic_model_id, access_token)
    _workspace_access(str(model["workspace_id"]), access_token, require_manage=True)
    _admin_client().table("semantic_model_rls_members").delete().eq("id", membership_id).eq("semantic_model_id", semantic_model_id).execute()
    return get_configuration(semantic_model_id, access_token)


def test_user(semantic_model_id: str, email: str, access_token: str) -> dict[str, Any]:
    model = get_semantic_model(semantic_model_id, access_token)
    _workspace_access(str(model["workspace_id"]), access_token, require_manage=True)
    sb = _admin_client();email=email.strip().lower()
    users=sb.table("vtab_users").select("id,email,display_name").ilike("email",email).limit(1).execute().data or []
    if not users:raise ValueError("Registered VTAB user not found.")
    user=users[0];uid=str(user["id"])
    direct=sb.table("semantic_model_rls_members").select("role_id").eq("semantic_model_id",semantic_model_id).eq("principal_type","user").eq("principal_id",uid).execute().data or []
    groups=sb.table("security_group_members").select("group_id").eq("user_id",uid).execute().data or []
    group_ids=[str(x["group_id"]) for x in groups if x.get("group_id")]
    inherited=[]
    if group_ids:inherited=sb.table("semantic_model_rls_members").select("role_id").eq("semantic_model_id",semantic_model_id).eq("principal_type","group").in_("principal_id",group_ids).execute().data or []
    ids=sorted({str(x["role_id"]) for x in [*direct,*inherited] if x.get("role_id")})
    names={str(r.get("id")):str(r.get("name") or r.get("id")) for r in (((model.get("definition") or {}).get("security") or {}).get("roles") or []) if isinstance(r,dict)}
    return {"user":user,"roleIds":ids,"roles":[names.get(x,x) for x in ids],"result":"restricted" if ids else "deny_all"}


def create_group(semantic_model_id: str, name: str, access_token: str) -> dict[str, Any]:
    model=get_semantic_model(semantic_model_id,access_token);_workspace_access(str(model["workspace_id"]),access_token,require_manage=True)
    name=name.strip()
    if not name:raise ValueError("Security group name is required.")
    _admin_client().table("security_groups").insert({"workspace_id":model["workspace_id"],"name":name,"created_by":authenticate(access_token)["id"]}).execute()
    return get_configuration(semantic_model_id,access_token)


def add_group_user(semantic_model_id: str, group_id: str, email: str, access_token: str) -> dict[str, Any]:
    model=get_semantic_model(semantic_model_id,access_token);_workspace_access(str(model["workspace_id"]),access_token,require_manage=True);sb=_admin_client()
    group=sb.table("security_groups").select("id").eq("id",group_id).eq("workspace_id",model["workspace_id"]).limit(1).execute().data or []
    if not group:raise ValueError("Security group not found.")
    users=sb.table("vtab_users").select("id,email").ilike("email",email.strip().lower()).limit(1).execute().data or []
    if not users:raise ValueError("Registered VTAB user not found.")
    sb.table("security_group_members").upsert({"group_id":group_id,"user_id":users[0]["id"],"added_by":authenticate(access_token)["id"]},on_conflict="group_id,user_id").execute()
    return get_configuration(semantic_model_id,access_token)
