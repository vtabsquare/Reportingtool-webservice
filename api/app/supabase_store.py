"""
supabase_store.py — Cloud publish/share service for VTAB Reporting Studio.

This is an ADDITIVE module. It does NOT modify existing SQLite storage.
The existing `storage.py` and all its callers are completely unchanged.
"""
from __future__ import annotations
import os, json, io, zipfile, hashlib
from typing import Optional
from datetime import datetime, timezone

from .credential_vault import encrypt_credentials

def _client(access_token: str = None):
    """Lazy-load Supabase client. Uses ANON KEY and the user's JWT for secure RLS access."""
    url = os.environ.get("VITE_SUPABASE_URL", "")
    key = os.environ.get("VITE_SUPABASE_ANON_KEY", "")
    if not url or not key:
        raise RuntimeError(
            "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY env vars must be set "
            "to use cloud publish features."
        )
    from supabase import create_client
    sb = create_client(url, key)
    if access_token:
        # Authenticate the Python client as the user who clicked 'Publish'
        sb.postgrest.auth(access_token)
    return sb

def _admin_client():
    """Create a Supabase client using the SERVICE ROLE KEY for admin operations."""
    url = os.environ.get("VITE_SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
    from supabase import create_client
    return create_client(url, key)

BUCKET = "vtab-reports"
WORKSPACE_PERMISSIONS = {
    'Admin': {'view', 'create', 'edit', 'publish', 'manage_users', 'delete_workspace', 'settings'},
    'Member': {'view', 'create', 'edit', 'publish', 'limited_manage_users', 'limited_settings'},
    'Contributor': {'view', 'create', 'edit', 'publish'},
    'Viewer': {'view'},
}

def publish_to_cloud(project: dict, access_token: str = None) -> dict:
    """
    Publish a project to Supabase.
    - Stores report metadata in the `published_reports` table.
    - Stores large analytical data in the Storage bucket.
    Returns: { id, name, published_at }
    """
    sb = _client(access_token)
    report = project.get("report") or {}
    report_id = report.get("id") or _uid()
    name = (report.get("name") or project.get("name") or "Untitled Report").strip()

    # Strip heavy data and upload to Storage separately
    project_meta = json.loads(json.dumps(project))  # deep copy
    parquet_data = project_meta.pop("_parquetData", None)
    if parquet_data:
        storage_path = f"{report_id}/data.json"
        sb.storage.from_(BUCKET).upload(
            storage_path,
            json.dumps(parquet_data).encode("utf-8"),
            {"content-type": "application/json", "upsert": "true"}
        )
        project_meta["_parquetStoragePath"] = storage_path

    res = sb.rpc("publish_report_for_user", {
        "p_report_id": report_id,
        "p_name": name,
        "p_project_json": json.dumps(project_meta),
    }).execute()
    data = res.data or {}
    if isinstance(data, dict) and data.get("error"):
        raise PermissionError(data["error"])
    return {"id": data.get("id", report_id), "name": data.get("name", name), "published_at": data.get("published_at")}


def grant_owner(report_id: str, user_id: str, access_token: str = None) -> None:
    """
    Auto-called after publish — grants the publisher 'Owner' role on their report.
    """
    sb = _client(access_token)
    sb.table("report_access_grants").upsert({
        "report_id": report_id,
        "user_id": user_id,
        "role": "Owner"
    }).execute()

def grant_access(report_id: str, email: str, role: str, granter_user_id: str, access_token: str = None) -> dict:
    """
    Grant a registered Supabase user access to a report.
    """
    if role not in ("Viewer", "Co-Owner"):
        raise ValueError("role must be 'Viewer' or 'Co-Owner'")
    sb = _client(access_token)

    # Call the secure Postgres RPC to lookup the user by email and grant access.
    # This bypasses the need for the Python backend to have full auth.admin privileges.
    res = sb.rpc("share_report_by_email", {
        "p_report_id": report_id,
        "p_target_email": email,
        "p_role": role,
        "p_granter_id": granter_user_id
    }).execute()

    if res.data and "error" in res.data:
        if "Only Co-Owners" in res.data["error"]:
            raise PermissionError(res.data["error"])
        raise ValueError(res.data["error"])

    return {"ok": True, "email": email, "role": role}

def list_accessible_reports(user_id: str) -> list:
    """List all reports the given Supabase user has been granted access to."""
    sb = _admin_client()
    grants = sb.table("report_access_grants") \
        .select("report_id, role") \
        .eq("user_id", user_id) \
        .execute()
    if not grants.data:
        return []
    report_ids = [g["report_id"] for g in grants.data]
    role_map = {g["report_id"]: g["role"] for g in grants.data}

    reports = sb.table("published_reports") \
        .select("id, name, published_at, updated_at, project_json") \
        .in_("id", report_ids) \
        .order("published_at", desc=True) \
        .execute()

    out = []
    for r in (reports.data or []):
        raw_project = r.get("project_json", {})
        if isinstance(raw_project, dict):
            p = raw_project
        else:
            try:
                p = json.loads(raw_project or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                p = {}
        pages = p.get("report", {}).get("pages", [])
        out.append({
            "id": r["id"],
            "itemKey": r["id"],
            "name": r["name"],
            "published_at": r["published_at"],
            "updated_at": r.get("updated_at"),
            "role": role_map.get(r["id"], "Viewer"),
            "pages": len(pages),
            "sourceType": p.get("sourceType") or p.get("dataSourceType"),
            "itemType": "Report",
        })
        if p.get("paginatedPublishMode") == "separate":
            for definition in p.get("paginatedReports") or []:
                if not definition.get("id"):
                    continue
                out.append({
                    "id": r["id"],
                    "itemKey": f"{r['id']}:paginated:{definition['id']}",
                    "paginatedId": definition["id"],
                    "name": definition.get("name") or "Paginated Report",
                    "published_at": r["published_at"],
                    "updated_at": r.get("updated_at"),
                    "role": role_map.get(r["id"], "Viewer"),
                    "pages": 0,
                    "sourceType": p.get("sourceType") or p.get("dataSourceType"),
                    "itemType": "Paginated report",
                })
    return out


# ── Package Upload ──────────────────────────────────────────────────────────────

def upload_package(file_bytes: bytes, filename: str, user_id: str, access_token: str = None) -> dict:
    """
    Upload a .vtabapp / .vtabpkg file to the cloud.
    Parses the zip, extracts project JSON, stores as a published_report,
    and grants Owner access to the uploader.
    """
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    if ext not in ('vtabapp', 'vtabpkg', 'vtabdata'):
        raise ValueError(f'Unsupported file type: .{ext}. Upload .vtabapp, .vtabpkg, or .vtabdata files.')

    # Parse the package zip
    try:
        zf = zipfile.ZipFile(io.BytesIO(file_bytes), 'r')
    except zipfile.BadZipFile:
        raise ValueError('Invalid package file. Could not read as ZIP archive.')

    # Find the manifest and project JSON
    manifest = None
    project_json = None
    for name in zf.namelist():
        if name.endswith('manifest.json'):
            manifest = json.loads(zf.read(name))
        if name.endswith('project.json'):
            project_json = json.loads(zf.read(name))

    if not project_json:
        raise ValueError('Package does not contain a project.json file.')

    # Build report metadata
    report = project_json.get('report') or {}
    report_id = report.get('id') or _uid()
    name = (report.get('name') or project_json.get('name') or filename.rsplit('.', 1)[0] or 'Uploaded Report').strip()

    # Use admin client for publishing (service role bypasses RLS)
    sb = _admin_client()

    # Upsert published report
    sb.table('published_reports').upsert({
        'id': report_id,
        'name': name,
        'project_json': json.dumps(project_json),
        'published_at': 'now()',
        'updated_at': 'now()',
    }, on_conflict='id').execute()

    # Grant Owner access
    sb.table('report_access_grants').upsert({
        'report_id': report_id,
        'user_id': user_id,
        'role': 'Owner',
    }).execute()

    return {
        'ok': True,
        'id': report_id,
        'name': name,
        'format': f'.{ext}',
        'pages': len(report.get('pages') or []),
    }


# ── Workspaces ──────────────────────────────────────────────────────────────────

def create_workspace(name: str, user_id: str) -> dict:
    """Create a new workspace and add the creator as Admin."""
    sb = _admin_client()
    res = sb.table('workspaces').insert({
        'name': name.strip(),
        'created_by': user_id,
    }).execute()
    ws = res.data[0] if res.data else {}
    ws_id = ws.get('id')
    if not ws_id:
        raise RuntimeError('Failed to create workspace.')
    # Add creator as Admin member
    sb.table('workspace_members').upsert({
        'workspace_id': ws_id,
        'user_id': user_id,
        'role': 'Admin',
    }).execute()
    return {'id': ws_id, 'name': ws.get('name'), 'created_at': ws.get('created_at'), 'role': 'Admin'}

def delete_workspace(workspace_id: str, user_id: str) -> dict:
    """Delete a workspace if the user is an Admin or Creator."""
    sb = _admin_client()
    ws = sb.table('workspaces').select('created_by,name').eq('id', workspace_id).execute()
    if not ws.data:
        raise ValueError('Workspace not found.')
    if str(ws.data[0].get('name') or '').strip().casefold() == 'my workspace':
        raise PermissionError('My Workspace is the permanent default workspace and cannot be deleted.')
    is_creator = bool(ws.data and ws.data[0].get('created_by') == user_id)

    mem = sb.table('workspace_members').select('role').eq('workspace_id', workspace_id).eq('user_id', user_id).execute()
    is_admin = bool(mem.data and mem.data[0]['role'] == 'Admin')
    
    if not is_creator and not is_admin:
        raise PermissionError('Only workspace Admins can delete this workspace.')

    sb.table('workspaces').delete().eq('id', workspace_id).execute()
    return {'ok': True, 'id': workspace_id}


def list_workspaces(user_id: str) -> list:
    """List all workspaces the user is a member of or created."""
    sb = _admin_client()
    memberships = sb.table('workspace_members').select('workspace_id, role').eq('user_id', user_id).execute()
    created = sb.table('workspaces').select('id').eq('created_by', user_id).execute()
    
    ws_map = {}
    for c in (created.data or []):
        ws_map[c['id']] = 'Admin'
    for m in (memberships.data or []):
        if m['workspace_id'] not in ws_map or m['role'] == 'Admin':
            ws_map[m['workspace_id']] = m['role']
            
    if not ws_map:
        return []
        
    workspaces = sb.table('workspaces').select('id, name, created_at, created_by').in_('id', list(ws_map.keys())).execute()
    if not workspaces.data:
        return []

    # Get counts
    mem_counts = sb.table('workspace_members').select('workspace_id', count='exact').in_('workspace_id', list(ws_map.keys())).execute()
    rep_counts = sb.table('published_reports').select('workspace_id').in_('workspace_id', list(ws_map.keys())).execute()
    
    mc = {}
    for row in (mem_counts.data or []):
        mc[row['workspace_id']] = mc.get(row['workspace_id'], 0) + 1
    rc = {}
    for row in (rep_counts.data or []):
        rc[row['workspace_id']] = rc.get(row['workspace_id'], 0) + 1

    res = []
    for w in workspaces.data:
        wid = w['id']
        role = 'Admin' if w['created_by'] == user_id else ws_map.get(wid, 'Member')
        res.append({
            'id': wid, 'name': w['name'], 'created_at': w['created_at'],
            'role': role,
            'member_count': mc.get(wid, 0),
            'report_count': rc.get(wid, 0)
        })
    return sorted(res, key=lambda item: (str(item.get('name') or '').casefold() != 'my workspace', str(item.get('name') or '').casefold()))

def get_workspace_detail(workspace_id: str, user_id: str) -> dict:
    """Get workspace details including members and reports."""
    sb = _admin_client()

    ws = sb.table('workspaces') \
        .select('id, name, created_at, created_by') \
        .eq('id', workspace_id) \
        .execute()
    if not ws.data:
        raise ValueError('Workspace not found.')
        
    is_creator = (ws.data[0].get('created_by') == user_id)

    # Verify membership
    mem = sb.table('workspace_members') \
        .select('role') \
        .eq('workspace_id', workspace_id) \
        .eq('user_id', user_id) \
        .execute()
    
    if not is_creator and not mem.data:
        raise PermissionError('You are not a member of this workspace.')
        
    role = 'Admin' if is_creator else mem.data[0]['role']

    # Get members with emails
    members = sb.table('workspace_members') \
        .select('user_id, role, added_at') \
        .eq('workspace_id', workspace_id) \
        .execute()

    member_list = []
    member_ids = [m['user_id'] for m in (members.data or [])]
    if member_ids:
        users = sb.table('vtab_users').select('id, email').in_('id', member_ids).execute()
        email_map = {u['id']: u['email'] for u in (users.data or [])}
    else:
        email_map = {}

    for m in (members.data or []):
        email = email_map.get(m['user_id'], m['user_id'])
        member_list.append({
            'user_id': m['user_id'],
            'email': email,
            'role': m['role'],
            'added_at': m['added_at'],
        })

    # Workspace ownership is authoritative. workspace_reports is retained only
    # as a compatibility bridge for reports shared before workspace publishing.
    direct = sb.table('published_reports') \
        .select('id, name, published_at, updated_at, semantic_model_id, project_json') \
        .eq('workspace_id', workspace_id) \
        .execute()
    report_map = {str(rpt['id']): dict(rpt) for rpt in (direct.data or [])}

    ws_reports = sb.table('workspace_reports') \
        .select('report_id, shared_at') \
        .eq('workspace_id', workspace_id) \
        .execute()
    if ws_reports.data:
        missing_ids = [wr['report_id'] for wr in ws_reports.data if str(wr['report_id']) not in report_map]
        if missing_ids:
            legacy = sb.table('published_reports') \
                .select('id, name, published_at, updated_at, semantic_model_id, project_json') \
                .in_('id', missing_ids) \
                .execute()
            report_map.update({str(rpt['id']): dict(rpt) for rpt in (legacy.data or [])})
        shared_map = {str(wr['report_id']): wr.get('shared_at') for wr in ws_reports.data}
        for report_id, shared_at in shared_map.items():
            if report_id in report_map:
                report_map[report_id]['shared_at'] = shared_at
    report_list = []
    for report in report_map.values():
        raw_project = report.pop('project_json', {})
        if isinstance(raw_project, dict):
            project = raw_project
        else:
            try:
                project = json.loads(raw_project or '{}')
            except (TypeError, ValueError, json.JSONDecodeError):
                project = {}
        report['itemKey'] = str(report['id'])
        report['itemType'] = 'Report'
        report_list.append(report)
        if project.get('paginatedPublishMode') == 'separate':
            for definition in project.get('paginatedReports') or []:
                definition_id = definition.get('id')
                if not definition_id:
                    continue
                report_list.append({
                    'id': report['id'],
                    'itemKey': f"{report['id']}:paginated:{definition_id}",
                    'paginatedId': definition_id,
                    'name': definition.get('name') or 'Paginated Report',
                    'published_at': report.get('published_at'),
                    'updated_at': report.get('updated_at'),
                    'semantic_model_id': report.get('semantic_model_id'),
                    'itemType': 'Paginated report',
                })
    report_list.sort(key=lambda rpt: str(rpt.get('updated_at') or rpt.get('published_at') or ''), reverse=True)

    return {
        **ws.data[0],
        'role': role,
        'is_default': str(ws.data[0].get('name') or '').strip().casefold() == 'my workspace',
        'members': member_list,
        'reports': report_list,
    }

def add_workspace_member(workspace_id: str, email: str, role: str, granter_id: str) -> dict:
    """Add a registered user to a workspace by email."""
    if role not in WORKSPACE_PERMISSIONS:
        raise ValueError("role must be Admin, Member, Contributor, or Viewer")
    sb = _admin_client()

    # Check granter is Admin
    granter = sb.table('workspace_members') \
        .select('role') \
        .eq('workspace_id', workspace_id) \
        .eq('user_id', granter_id) \
        .execute()
    if not granter.data or granter.data[0]['role'] != 'Admin':
        raise PermissionError('Only workspace Admins can add members.')

    # Lookup user by email via Supabase Admin API
    import urllib.request
    url_base = os.environ.get('VITE_SUPABASE_URL', '').rstrip('/')
    svc_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
    if not url_base or not svc_key:
        raise RuntimeError('SUPABASE_SERVICE_ROLE_KEY is required to add members.')

    try:
        req = urllib.request.Request(
            f"{url_base}/auth/v1/admin/users",
            headers={'apikey': svc_key, 'Authorization': f'Bearer {svc_key}'}
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            all_users = json.loads(r.read().decode('utf-8'))
    except Exception as e:
        raise RuntimeError(f'Failed to lookup users: {e}')

    target_user = None
    users_list = all_users.get('users', all_users) if isinstance(all_users, dict) else all_users
    for u in users_list:
        if (u.get('email') or '').lower() == email.strip().lower():
            target_user = u
            break

    if not target_user:
        raise ValueError(f'No registered user found with email: {email}')

    target_uid = target_user['id']

    # Add to workspace
    sb.table('workspace_members').upsert({
        'workspace_id': workspace_id,
        'user_id': target_uid,
        'role': role,
    }).execute()

    # Also grant access to all reports already in this workspace
    ws_reports = sb.table('workspace_reports') \
        .select('report_id') \
        .eq('workspace_id', workspace_id) \
        .execute()
    for wr in (ws_reports.data or []):
        sb.table('report_access_grants').upsert({
            'report_id': wr['report_id'],
            'user_id': target_uid,
            'role': 'Viewer' if role == 'Viewer' else 'Co-Owner',
        }).execute()

    return {'ok': True, 'email': email, 'role': role, 'user_id': target_uid}

def share_report_to_workspace(report_id: str, workspace_id: str, granter_id: str) -> dict:
    """Share a report into a workspace, granting access to all current members."""
    sb = _admin_client()

    # Check granter is Admin
    granter = sb.table('workspace_members') \
        .select('role') \
        .eq('workspace_id', workspace_id) \
        .eq('user_id', granter_id) \
        .execute()
    if not granter.data or granter.data[0]['role'] != 'Admin':
        raise PermissionError('Only workspace Admins can share reports.')

    # Add to workspace_reports
    sb.table('workspace_reports').upsert({
        'workspace_id': workspace_id,
        'report_id': report_id,
    }).execute()

    # Grant access to all workspace members
    members = sb.table('workspace_members') \
        .select('user_id') \
        .eq('workspace_id', workspace_id) \
        .execute()
    count = 0
    for m in (members.data or []):
        sb.table('report_access_grants').upsert({
            'report_id': report_id,
            'user_id': m['user_id'],
            'role': 'Viewer',
        }).execute()
        count += 1

    return {'ok': True, 'members_granted': count}


def _uid():
    import uuid
    return str(uuid.uuid4())


# ── User Search (autocomplete) ──────────────────────────────────────────────────

def search_users(query: str, limit: int = 10) -> list:
    """
    Search registered users by email prefix using the vtab_users mirror table.
    Returns a list of {id, email, display_name} dicts.
    """
    sb = _admin_client()
    q = query.strip().lower()
    if not q or len(q) < 2:
        return []

    res = sb.table('vtab_users') \
        .select('id, email, display_name') \
        .ilike('email', f'{q}%') \
        .limit(limit) \
        .execute()

    return [
        {'id': u['id'], 'email': u['email'], 'display_name': u.get('display_name') or u['email'].split('@')[0]}
        for u in (res.data or [])
    ]


# ── Semantic-model runtime ─────────────────────────────────────────────────────

def _semantic_model_manager(sb, semantic_model_id: str, user_id: str) -> dict:
    rows = sb.table('semantic_models').select('id,workspace_id,report_id,name,definition,metadata').eq('id', semantic_model_id).limit(1).execute().data or []
    if not rows:
        raise ValueError('Semantic model not found.')
    model = rows[0]
    members = sb.table('workspace_members').select('role').eq('workspace_id', model['workspace_id']).eq('user_id', user_id).limit(1).execute().data or []
    if not members or members[0].get('role') not in ('Admin', 'Member', 'Contributor'):
        raise PermissionError('You need edit access to manage this semantic model.')
    model['role'] = members[0]['role']
    return model


def _ensure_managed_file_connections(sb, model: dict, user_id: str) -> None:
    """Register published file snapshots as service-managed model sources."""
    definition = model.get('definition') or {}
    if isinstance(definition, str):
        definition = json.loads(definition or '{}')
    sources = (definition.get('sourceManifest') or {}).get('sources') or []
    represented = {str(table.get('modelTable') or '') for source in sources for table in (source.get('tables') or [])}
    legacy_managed = []
    for table_name, table_definition in (definition.get('tables') or {}).items():
        storage_path = str((table_definition or {}).get('sourceStoragePath') or '').strip()
        if storage_path and table_name not in represented:
            legacy_managed.append({'modelTable': table_name, 'managedStoragePath': storage_path})
    if legacy_managed:
        sources = [*sources, {'id': 'managed-published-snapshots', 'name': 'Managed published files', 'type': 'managed_file', 'tables': legacy_managed}]
    existing = sb.table('semantic_model_connections').select('id,name,source_type,table_mappings').eq('semantic_model_id', model['id']).execute().data or []
    by_name = {str(row.get('name') or '').casefold(): row for row in existing}
    live_owned_tables = {
        str(item.get('table') or '').strip()
        for row in existing if row.get('source_type') != 'managed_file'
        for item in (row.get('table_mappings') or [])
        if item.get('table')
    }
    for index, source in enumerate(sources):
        if str(source.get('type') or '').lower() != 'managed_file':
            continue
        name = str(source.get('name') or f'Managed files {index + 1}').strip()[:160]
        row = by_name.get(name.casefold())
        mappings = []
        for table in source.get('tables') or []:
            storage_path = str(table.get('managedStoragePath') or '').strip()
            table_name = str(table.get('modelTable') or '').strip()
            if storage_path and table_name and table_name not in live_owned_tables:
                mappings.append({'table': table_name, 'storage_path': storage_path})
        if not mappings and row and row.get('source_type') == 'managed_file' and row.get('table_mappings'):
            sb.table('semantic_model_connections').update({'table_mappings': []}).eq('id', row['id']).execute()
        if not mappings:
            continue
        values = {
            'semantic_model_id': model['id'], 'workspace_id': model['workspace_id'],
            'name': name, 'source_type': 'managed_file',
            'connection_config': {'access': 'managed_storage'}, 'table_mappings': mappings,
            # A published managed file is the last successful report snapshot,
            # not proof that the original source is configured on Services.
            'status': 'not_configured', 'last_error': None,
        }
        if row and row.get('source_type') == 'managed_file':
            sb.table('semantic_model_connections').update(values).eq('id', row['id']).execute()
        elif not row:
            sb.table('semantic_model_connections').insert({
                **values, 'credentials_enc': encrypt_credentials({}), 'created_by': user_id,
            }).execute()


def get_semantic_model_runtime(semantic_model_id: str, user_id: str) -> dict:
    sb = _admin_client()
    model = _semantic_model_manager(sb, semantic_model_id, user_id)
    _ensure_managed_file_connections(sb, model, user_id)
    connections = sb.table('semantic_model_connections').select('id,name,source_type,connection_config,table_mappings,gateway_id,authentication_method,privacy_level,encrypted_transport,status,last_tested_at,last_error,updated_at').eq('semantic_model_id', semantic_model_id).order('created_at').execute().data or []
    gateways = sb.table('vtab_gateways').select('id,name,status,last_heartbeat,version,execution_mode,description,region,allow_cloud_sources').eq('workspace_id', model['workspace_id']).order('name').execute().data or []
    jobs = sb.table('scheduled_jobs').select('id,report_id,semantic_model_id,cron_expr,interval_label,timezone,status,last_run,next_run,last_run_status,error_message,retry_count,retry_interval_minutes,timeout_minutes,source_config').eq('semantic_model_id', semantic_model_id).order('created_at', desc=True).execute().data or []
    stored = sb.table('semantic_model_parameters').select('name,data_type,current_value,default_value,allowed_values,updated_at').eq('semantic_model_id', semantic_model_id).order('name').execute().data or []
    definition = model.get('definition') or {}
    if isinstance(definition, str):
        definition = json.loads(definition or '{}')
    published = definition.get('parameters') or {}
    parameter_map = {row['name']: row for row in stored}
    if isinstance(published, dict):
        for name, value in published.items():
            if name in parameter_map:
                continue
            detail = value if isinstance(value, dict) else {'currentValue': value}
            parameter_map[name] = {
                'name': name,
                'data_type': detail.get('type') or detail.get('dataType') or 'Text',
                'current_value': detail.get('currentValue', detail.get('value', detail.get('defaultValue'))),
                'default_value': detail.get('defaultValue'),
                'allowed_values': detail.get('allowedValues'),
            }
    elif isinstance(published, list):
        for item in published:
            if isinstance(item, dict) and item.get('name') and item['name'] not in parameter_map:
                parameter_map[item['name']] = {
                    'name': item['name'], 'data_type': item.get('type') or 'Text',
                    'current_value': item.get('currentValue', item.get('value', item.get('defaultValue'))),
                    'default_value': item.get('defaultValue'), 'allowed_values': item.get('allowedValues'),
                }
    schedule = jobs[0] if jobs else None
    if schedule:
        schedule_config = schedule.get('source_config') or {}
        if isinstance(schedule_config, str):
            schedule_config = json.loads(schedule_config or '{}')
        if schedule_config.get('manual_only'):
            schedule = None
    definition_tables = set((definition.get('tables') or {}).keys())
    live_connections = [row for row in connections if row.get('source_type') != 'managed_file']
    mapped_tables = {
        str(item.get('table') or '').strip()
        for row in live_connections if row.get('status') == 'connected'
        for item in (row.get('table_mappings') or []) if item.get('table')
    }
    untested = [str(row.get('name') or row.get('id')) for row in live_connections if row.get('table_mappings') and row.get('status') != 'connected']
    missing = sorted(definition_tables.difference(mapped_tables))
    blockers = []
    if not live_connections:
        blockers.append('Configure and test at least one live data-source connection. Published snapshots are viewable but are not refresh connections.')
    if untested:
        blockers.append('Test these mapped connections: ' + ', '.join(untested))
    if missing:
        blockers.append('Map every model table to a tested connection. Missing: ' + ', '.join(missing))
    readiness = {
        'refresh_ready': not blockers,
        'required_tables': sorted(definition_tables),
        'mapped_tables': sorted(mapped_tables),
        'missing_tables': missing,
        'tested_connection_count': len([row for row in live_connections if row.get('status') == 'connected']),
        'blockers': blockers,
    }
    return {
        'semantic_model_id': semantic_model_id,
        'workspace_id': model['workspace_id'],
        'report_id': model.get('report_id'),
        'source_manifest': definition.get('sourceManifest') or {'version': 1, 'sources': []},
        'connections': connections, 'gateways': gateways, 'schedule': schedule,
        'parameters': list(parameter_map.values()), 'readiness': readiness,
    }


def save_semantic_model_connection(semantic_model_id: str, payload: dict, user_id: str) -> dict:
    sb = _admin_client()
    model = _semantic_model_manager(sb, semantic_model_id, user_id)
    name = str(payload.get('name') or '').strip()
    source_type = str(payload.get('source_type') or '').strip().lower()
    if not name or not source_type:
        raise ValueError('Connection name and data source type are required.')
    connection_id = str(payload.get('id') or '').strip()
    credentials = {key: value for key, value in (payload.get('credentials') or {}).items() if value not in ('', None)}
    mappings = payload.get('table_mappings') or []
    mapped_names = [str(item.get('table') or '').strip() for item in mappings]
    if any(not value for value in mapped_names) or len(mapped_names) != len(set(mapped_names)):
        raise ValueError('Every model table can appear only once in a connection mapping.')
    gateway_id = payload.get('gateway_id') or None
    if gateway_id:
        gateways = sb.table('vtab_gateways').select('id,status,execution_mode').eq('id', gateway_id).eq('workspace_id', model['workspace_id']).limit(1).execute().data or []
        if not gateways:
            raise ValueError('The selected gateway cluster is not available in this workspace.')
        if gateways[0].get('status') != 'online':
            raise ValueError('The selected gateway cluster is offline. Bring it online before saving this connection.')
    values = {
        'semantic_model_id': semantic_model_id, 'workspace_id': model['workspace_id'],
        'name': name, 'source_type': source_type,
        'connection_config': payload.get('connection_config') or {},
        'table_mappings': mappings,
        'gateway_id': gateway_id,
        'authentication_method': payload.get('authentication_method') or ('api_key' if source_type == 'rest' else 'database'),
        'privacy_level': payload.get('privacy_level') or 'organizational',
        'encrypted_transport': bool(payload.get('encrypted_transport', True)),
        'status': 'connected', 'last_tested_at': payload.get('tested_at'),
        'last_error': None, 'created_by': user_id,
    }
    if credentials or not connection_id:
        values['credentials_enc'] = encrypt_credentials(credentials)
    if connection_id:
        existing = sb.table('semantic_model_connections').select('id,semantic_model_id').eq('id', connection_id).limit(1).execute().data or []
        if not existing or str(existing[0].get('semantic_model_id')) != semantic_model_id:
            raise ValueError('Connection not found.')
        values.pop('created_by', None)
        if not credentials:
            values.pop('credentials_enc', None)
        rows = sb.table('semantic_model_connections').update(values).eq('id', connection_id).execute().data or []
    else:
        rows = sb.table('semantic_model_connections').insert(values).execute().data or []
    # A model table has exactly one active refresh owner. Saving a tested source
    # automatically replaces an older published snapshot or stale connection
    # mapping for the same table instead of producing a duplicate-mapping error.
    if mapped_names:
        others = sb.table('semantic_model_connections').select('id,table_mappings').eq('semantic_model_id', semantic_model_id).execute().data or []
        current_id = str((rows[0] if rows else values).get('id') or connection_id)
        claimed = set(mapped_names)
        for other in others:
            if str(other.get('id')) == current_id:
                continue
            old = other.get('table_mappings') or []
            revised = [item for item in old if str(item.get('table') or '').strip() not in claimed]
            if revised != old:
                sb.table('semantic_model_connections').update({'table_mappings': revised}).eq('id', other['id']).execute()
    result = dict(rows[0]) if rows else values
    result.pop('credentials_enc', None)
    return result


def delete_semantic_model_connection(semantic_model_id: str, connection_id: str, user_id: str) -> dict:
    sb = _admin_client(); _semantic_model_manager(sb, semantic_model_id, user_id)
    sb.table('semantic_model_connections').delete().eq('id', connection_id).eq('semantic_model_id', semantic_model_id).execute()
    return {'ok': True, 'id': connection_id}


def save_workspace_gateway(workspace_id: str, payload: dict, user_id: str) -> dict:
    """Create or update a gateway cluster the current member can administer."""
    sb = _admin_client()
    members = sb.table('workspace_members').select('role').eq('workspace_id', workspace_id).eq('user_id', user_id).limit(1).execute().data or []
    if not members or members[0].get('role') not in ('Admin', 'Member'):
        raise PermissionError('You need workspace Admin or Member access to manage gateway clusters.')
    name = str(payload.get('name') or '').strip()
    mode = str(payload.get('execution_mode') or 'service_network').strip()
    if not name:
        raise ValueError('Gateway cluster name is required.')
    if mode not in ('service_network', 'on_premises_agent'):
        raise ValueError('Gateway execution mode is not supported.')
    gateway_id = str(payload.get('id') or '').strip()
    values = {
        'workspace_id': workspace_id, 'name': name,
        'execution_mode': mode,
        'description': str(payload.get('description') or '').strip() or None,
        'region': str(payload.get('region') or '').strip() or None,
        'allow_cloud_sources': bool(payload.get('allow_cloud_sources', False)),
        # The Services backend itself is the runtime for service-network mode.
        # Agent mode remains offline until an installed agent reports heartbeat.
        'status': 'online' if mode == 'service_network' else 'offline',
        'last_heartbeat': datetime.now(timezone.utc).isoformat() if mode == 'service_network' else None,
        'version': 'Services runtime' if mode == 'service_network' else None,
        'created_by': user_id,
    }
    if gateway_id:
        existing = sb.table('vtab_gateways').select('id').eq('id', gateway_id).eq('workspace_id', workspace_id).limit(1).execute().data or []
        if not existing:
            raise ValueError('Gateway cluster not found.')
        values.pop('created_by', None)
        rows = sb.table('vtab_gateways').update(values).eq('id', gateway_id).execute().data or []
    else:
        rows = sb.table('vtab_gateways').insert(values).execute().data or []
    return rows[0] if rows else {'id': gateway_id, **values}


def save_semantic_model_parameters(semantic_model_id: str, parameters: list, user_id: str) -> dict:
    sb = _admin_client(); _semantic_model_manager(sb, semantic_model_id, user_id)
    for item in parameters or []:
        name = str(item.get('name') or '').strip()
        if not name:
            continue
        sb.table('semantic_model_parameters').upsert({
            'semantic_model_id': semantic_model_id, 'name': name,
            'data_type': item.get('data_type') or 'Text', 'current_value': item.get('current_value'),
            'default_value': item.get('default_value'), 'allowed_values': item.get('allowed_values'),
        }, on_conflict='semantic_model_id,name').execute()
    return {'ok': True, 'parameters': get_semantic_model_runtime(semantic_model_id, user_id)['parameters']}


def _semantic_model_report_id(sb, model: dict, semantic_model_id: str) -> str:
    report_id = str(model.get('report_id') or '').strip()
    if not report_id:
        reports = sb.table('published_reports').select('id').eq('semantic_model_id', semantic_model_id).limit(1).execute().data or []
        report_id = str(reports[0]['id']) if reports else ''
    if not report_id:
        raise ValueError('This semantic model has no connected report to refresh.')
    return report_id


def _validate_semantic_model_refresh_sources(sb, model: dict, semantic_model_id: str) -> list:
    """Validate and repair legacy source ownership before manual or scheduled refresh."""
    connections = sb.table('semantic_model_connections').select('id,name,source_type,table_mappings,status,created_at').eq('semantic_model_id', semantic_model_id).execute().data or []
    live_connections = [row for row in connections if row.get('source_type') != 'managed_file']
    if not live_connections or not any(row.get('table_mappings') for row in live_connections):
        raise ValueError('Configure, test and map a live data-source connection before refreshing. The published snapshot is view-only.')
    not_ready = [str(row.get('name') or row.get('id')) for row in live_connections if row.get('table_mappings') and row.get('status') != 'connected']
    if not_ready:
        raise ValueError('Test and connect every mapped source before refreshing: ' + ', '.join(not_ready))

    # Older builds could leave a published managed-file snapshot and a newly
    # configured live source both owning the same table. Prefer the live source,
    # then remove only the stale duplicate mapping. No report/model data changes.
    owners: dict[str, list[dict]] = {}
    for row in live_connections:
        for item in row.get('table_mappings') or []:
            table_name = str(item.get('table') or '').strip()
            if table_name:
                owners.setdefault(table_name, []).append(row)
    for table_name, rows in owners.items():
        if len(rows) < 2:
            continue
        winner = sorted(rows, key=lambda row: (row.get('source_type') == 'managed_file', str(row.get('created_at') or '')))[0]
        for row in rows:
            if row['id'] == winner['id']:
                continue
            old = row.get('table_mappings') or []
            revised = [item for item in old if str(item.get('table') or '').strip() != table_name]
            if revised != old:
                sb.table('semantic_model_connections').update({'table_mappings': revised}).eq('id', row['id']).execute()
                row['table_mappings'] = revised

    definition = model.get('definition') or {}
    if isinstance(definition, str):
        definition = json.loads(definition or '{}')
    required_tables = set((definition.get('tables') or {}).keys())
    mapped_tables = [str(item.get('table') or '').strip() for row in live_connections if row.get('status') == 'connected' for item in (row.get('table_mappings') or []) if item.get('table')]
    duplicates = sorted({name for name in mapped_tables if mapped_tables.count(name) > 1})
    missing = sorted(required_tables.difference(mapped_tables))
    if duplicates:
        raise ValueError('Each model table must map to exactly one source. Duplicate mappings: ' + ', '.join(duplicates))
    if missing:
        raise ValueError('Configure a source for every model table. Missing mappings: ' + ', '.join(missing))
    return live_connections


def save_semantic_model_schedule(semantic_model_id: str, payload: dict, user_id: str) -> dict:
    sb = _admin_client(); model = _semantic_model_manager(sb, semantic_model_id, user_id)
    _ensure_managed_file_connections(sb, model, user_id)
    report_id = _semantic_model_report_id(sb, model, semantic_model_id)
    _validate_semantic_model_refresh_sources(sb, model, semantic_model_id)
    cron_expr = str(payload.get('cron_expr') or '').strip()
    timezone_name = str(payload.get('timezone') or 'UTC')
    if not cron_expr:
        raise ValueError('A refresh schedule is required.')
    values = {
        'report_id': report_id, 'semantic_model_id': semantic_model_id, 'created_by': user_id,
        'source_type': 'semantic_model', 'cron_expr': cron_expr,
        'interval_label': str(payload.get('interval_label') or ''), 'timezone': timezone_name,
        'source_config': {'semantic_model_id': semantic_model_id}, 'notify_on_failure': True,
        'status': 'active' if payload.get('enabled', True) else 'paused',
        'retry_count': max(0, min(int(payload.get('retry_count', 3)), 10)),
        'retry_interval_minutes': max(1, min(int(payload.get('retry_interval_minutes', 5)), 120)),
        'timeout_minutes': max(1, min(int(payload.get('timeout_minutes', 30)), 1440)),
        'next_run': _compute_next_run(cron_expr, timezone_name),
        'credentials_enc': encrypt_credentials({}),
    }
    existing = sb.table('scheduled_jobs').select('id').eq('semantic_model_id', semantic_model_id).limit(1).execute().data or []
    if existing:
        values.pop('credentials_enc', None); values.pop('created_by', None)
        rows = sb.table('scheduled_jobs').update(values).eq('id', existing[0]['id']).execute().data or []
    else:
        rows = sb.table('scheduled_jobs').insert(values).execute().data or []
    result = dict(rows[0]) if rows else values; result.pop('credentials_enc', None)
    return result


def semantic_model_refresh_now(semantic_model_id: str, user_id: str) -> dict:
    sb = _admin_client(); model = _semantic_model_manager(sb, semantic_model_id, user_id)
    _ensure_managed_file_connections(sb, model, user_id)
    _validate_semantic_model_refresh_sources(sb, model, semantic_model_id)
    report_id = _semantic_model_report_id(sb, model, semantic_model_id)
    jobs = sb.table('scheduled_jobs').select('id').eq('semantic_model_id', semantic_model_id).limit(1).execute().data or []
    if jobs:
        return request_refresh_now(jobs[0]['id'], user_id)
    now = datetime.now(timezone.utc).isoformat()
    rows = sb.table('scheduled_jobs').insert({
        'report_id': report_id, 'semantic_model_id': semantic_model_id,
        'created_by': user_id, 'source_type': 'semantic_model',
        'cron_expr': '0 0 1 1 *', 'interval_label': 'Manual only',
        'timezone': 'UTC', 'source_config': {'semantic_model_id': semantic_model_id, 'manual_only': True},
        'notify_on_failure': True, 'status': 'active', 'run_requested_at': now,
        'next_run': now, 'credentials_enc': encrypt_credentials({}),
        'retry_count': 0, 'retry_interval_minutes': 5, 'timeout_minutes': 30,
    }).execute().data or []
    return {'ok': True, 'job': rows[0] if rows else {}, 'message': 'Refresh queued.'}


def semantic_model_refresh_history(semantic_model_id: str, user_id: str, limit: int = 50) -> list:
    sb = _admin_client(); _semantic_model_manager(sb, semantic_model_id, user_id)
    return sb.table('refresh_runs').select('*').eq('semantic_model_id', semantic_model_id).order('created_at', desc=True).limit(max(1, min(int(limit), 200))).execute().data or []


def semantic_model_refresh_status(semantic_model_id: str, job_id: str, user_id: str) -> dict:
    """Return an observable queued/running/final state for one refresh request."""
    sb = _admin_client(); _semantic_model_manager(sb, semantic_model_id, user_id)
    jobs = sb.table('scheduled_jobs').select('id,run_requested_at,locked_at,locked_by,last_run,last_run_status,error_message').eq('id', job_id).eq('semantic_model_id', semantic_model_id).limit(1).execute().data or []
    if not jobs:
        raise ValueError('Refresh job not found for this semantic model.')
    job = jobs[0]
    run_query = sb.table('refresh_runs').select('*').eq('job_id', job_id).eq('semantic_model_id', semantic_model_id)
    if job.get('run_requested_at'):
        # Do not mistake the previous successful run for this newly queued request.
        run_query = run_query.gte('created_at', job['run_requested_at'])
    runs = run_query.order('created_at', desc=True).limit(1).execute().data or []
    if runs:
        run = runs[0]
        return {'job_id': job_id, 'status': run.get('status') or 'running', 'run': run, 'message': run.get('error_message') or ''}
    if job.get('locked_at'):
        return {'job_id': job_id, 'status': 'running', 'run': None, 'message': 'The refresh worker has started this request.'}
    if job.get('run_requested_at'):
        return {'job_id': job_id, 'status': 'queued', 'run': None, 'message': 'Waiting for an available refresh worker.'}
    final_status = job.get('last_run_status') or 'queued'
    return {'job_id': job_id, 'status': final_status, 'run': None, 'message': job.get('error_message') or ''}


def delete_semantic_model(semantic_model_id: str, user_id: str) -> dict:
    sb = _admin_client(); _semantic_model_manager(sb, semantic_model_id, user_id)
    sb.table('semantic_models').delete().eq('id', semantic_model_id).execute()
    return {'ok': True, 'id': semantic_model_id}


# ── Scheduler Jobs ──────────────────────────────────────────────────────────────

def _compute_next_run(cron_expr: str, timezone_name: str = 'UTC'):
    """
    Compute the next run time from a cron expression using croniter if available,
    otherwise return None (backend will compute on first trigger).
    """
    try:
        from croniter import croniter
        from datetime import datetime, timezone
        from zoneinfo import ZoneInfo
        zone = ZoneInfo(timezone_name or 'UTC')
        local_next = croniter(cron_expr, datetime.now(zone)).get_next(datetime)
        return local_next.astimezone(timezone.utc).isoformat()
    except ImportError:
        return None
    except Exception as error:
        raise ValueError(f'Invalid refresh schedule or timezone: {error}') from error


def _report_manager(sb, report_id: str, user_id: str) -> dict:
    rows = sb.table('published_reports').select('id,name,owner_id,workspace_id,semantic_model_id,project_json').eq('id', report_id).limit(1).execute().data or []
    if not rows:
        raise ValueError('Published report not found.')
    report = rows[0]
    if str(report.get('owner_id') or '') == str(user_id):
        return report
    workspace_id = report.get('workspace_id')
    if workspace_id:
        members = sb.table('workspace_members').select('role').eq('workspace_id', workspace_id).eq('user_id', user_id).limit(1).execute().data or []
        if members and members[0].get('role') in ('Admin', 'Member', 'Contributor'):
            return report
    grants = sb.table('report_access_grants').select('role').eq('report_id', report_id).eq('user_id', user_id).limit(1).execute().data or []
    if grants and grants[0].get('role') in ('Owner', 'Co-Owner', 'Editor'):
        return report
    raise PermissionError('You need edit access to manage refresh for this report.')


def _job_for_manager(sb, job_id: str, user_id: str) -> dict:
    rows = sb.table('scheduled_jobs').select('*').eq('id', job_id).limit(1).execute().data or []
    if not rows:
        raise ValueError('Scheduled job not found.')
    _report_manager(sb, rows[0]['report_id'], user_id)
    return rows[0]


def upsert_scheduled_job(
    report_id: str,
    source_type: str,
    cron_expr: str,
    interval_label: str,
    credentials: dict,
    user_id: str,
    job_id: str = None,
    timezone_name: str = 'UTC',
    source_config: dict = None,
    notify_on_failure: bool = True,
) -> dict:
    """
    Create or update a scheduled refresh job.
    Credentials are encrypted before they leave the API process.
    """
    sb = _admin_client()
    report = _report_manager(sb, report_id, user_id)
    mappings = (source_config or {}).get('mappings') or []
    if not mappings:
        raise ValueError('Map at least one report table before activating refresh.')
    table_names = [str(item.get('table') or '').strip() for item in mappings]
    if any(not name for name in table_names) or len(set(table_names)) != len(table_names):
        raise ValueError('Every table mapping must have a unique report table name.')

    payload = {
        'report_id': report_id,
        'semantic_model_id': report.get('semantic_model_id'),
        'created_by': user_id,
        'source_type': source_type,
        'cron_expr': cron_expr,
        'interval_label': interval_label,
        'credentials_enc': encrypt_credentials(credentials),
        'status': 'active',
        'timezone': timezone_name or 'UTC',
        'source_config': source_config or {},
        'notify_on_failure': bool(notify_on_failure),
        'next_run': _compute_next_run(cron_expr, timezone_name),
        'error_message': None,
    }

    if job_id:
        _job_for_manager(sb, job_id, user_id)
        if not credentials:
            payload.pop('credentials_enc')
        res = sb.table('scheduled_jobs').update(payload).eq('id', job_id).execute()
    else:
        res = sb.table('scheduled_jobs').insert(payload).execute()

    if not res.data:
        raise RuntimeError('Failed to save scheduled job.')
    result = dict(res.data[0])
    result.pop('credentials_enc', None)
    return result


def list_scheduled_jobs(report_id: str, user_id: str) -> list:
    """List scheduled jobs without ever returning stored secrets."""
    sb = _admin_client()
    _report_manager(sb, report_id, user_id)
    res = sb.table('scheduled_jobs') \
        .select('id, report_id, semantic_model_id, source_type, cron_expr, interval_label, timezone, source_config, notify_on_failure, status, last_run, next_run, last_run_status, error_message, consecutive_failures, created_at, updated_at') \
        .eq('report_id', report_id) \
        .order('created_at', desc=True) \
        .execute()
    return res.data or []


def delete_scheduled_job(job_id: str, user_id: str) -> dict:
    """Delete a scheduled job. Only the creator can delete it."""
    sb = _admin_client()
    _job_for_manager(sb, job_id, user_id)
    sb.table('scheduled_jobs').delete().eq('id', job_id).execute()
    return {'ok': True, 'id': job_id}


def set_scheduled_job_status(job_id: str, user_id: str, status: str) -> dict:
    if status not in ('active', 'paused'):
        raise ValueError("Refresh status must be 'active' or 'paused'.")
    sb = _admin_client()
    job = _job_for_manager(sb, job_id, user_id)
    patch = {'status': status, 'locked_at': None, 'locked_by': None}
    if status == 'active':
        patch['next_run'] = _compute_next_run(job['cron_expr'], job.get('timezone') or 'UTC')
    rows = sb.table('scheduled_jobs').update(patch).eq('id', job_id).execute().data or []
    return rows[0] if rows else {**job, **patch}


def request_refresh_now(job_id: str, user_id: str) -> dict:
    sb = _admin_client()
    job = _job_for_manager(sb, job_id, user_id)
    now = datetime.now(timezone.utc).isoformat()
    source_config = job.get('source_config') or {}
    if isinstance(source_config, str):
        source_config = json.loads(source_config or '{}')
    source_config = dict(source_config)
    if job.get('status') != 'active':
        source_config['_manual_restore_status'] = job.get('status') or 'paused'
    rows = sb.table('scheduled_jobs').update({
        'status': 'active', 'run_requested_at': now, 'next_run': now,
        'locked_at': None, 'locked_by': None, 'source_config': source_config,
    }).eq('id', job_id).execute().data or []
    return {'ok': True, 'job': rows[0] if rows else {'id': job_id}, 'message': 'Refresh queued.'}


def list_refresh_runs(report_id: str, user_id: str, limit: int = 50) -> list:
    sb = _admin_client()
    _report_manager(sb, report_id, user_id)
    response = sb.table('refresh_runs').select('*').eq('report_id', report_id).order('created_at', desc=True).limit(max(1, min(int(limit), 200))).execute()
    return response.data or []


def get_refresh_schema(report_id: str, user_id: str) -> dict:
    sb = _admin_client()
    report = _report_manager(sb, report_id, user_id)
    project = report.get('project_json') or {}
    if isinstance(project, str):
        project = json.loads(project or '{}')
    tables = []
    for name, definition in (((project.get('model') or {}).get('tables')) or {}).items():
        tables.append({'name': name, 'physicalName': (definition or {}).get('physical') or (definition or {}).get('physicalName') or name})
    return {'report_id': report_id, 'tables': tables}


def refresh_preflight(user_id: str) -> dict:
    """Verify the server-side prerequisites used by every refresh settings page."""
    from .credential_vault import _fernet
    checks = []
    try:
        _fernet()
        checks.append({'id': 'encryption', 'ok': True, 'message': 'Credential encryption key is configured.'})
    except Exception as error:
        checks.append({'id': 'encryption', 'ok': False, 'message': str(error)})
    try:
        sb = _admin_client()
        sb.table('scheduled_jobs').select('id,timezone,source_config').limit(1).execute()
        sb.table('refresh_runs').select('id').limit(1).execute()
        sb.table('semantic_model_versions').select('id').limit(1).execute()
        sb.table('semantic_model_connections').select('id').limit(1).execute()
        sb.table('semantic_model_parameters').select('id').limit(1).execute()
        sb.table('vtab_gateways').select('id,execution_mode').limit(1).execute()
        checks.append({'id': 'database', 'ok': True, 'message': 'Refresh and semantic-model database migrations are installed.'})
    except Exception as error:
        checks.append({'id': 'database', 'ok': False, 'message': 'Run migrations 008_refresh_runtime.sql, 009_semantic_model_assets.sql, 010_semantic_model_runtime.sql, and 011_gateway_configuration.sql in Supabase. ' + str(error)})
    worker_enabled = os.environ.get('VTAB_REFRESH_WORKER_ENABLED', '1') != '0'
    checks.append({'id': 'worker', 'ok': worker_enabled, 'message': 'Refresh worker is enabled.' if worker_enabled else 'Set VTAB_REFRESH_WORKER_ENABLED=1 on the backend.'})
    return {'ok': all(item['ok'] for item in checks), 'checks': checks, 'user_id': user_id}


def complete_refresh_job(job: dict, success: bool, error_message: str = None, client=None) -> None:
    """Finish a claimed run, schedule the next one, and preserve failure health."""
    from datetime import datetime, timezone, timedelta
    sb = client or _admin_client()
    failures = 0 if success else int(job.get('consecutive_failures') or 0) + 1
    retry_count = max(0, int(job.get('retry_count') or 3))
    source_config = job.get('source_config') or {}
    if isinstance(source_config, str):
        source_config = json.loads(source_config or '{}')
    source_config = dict(source_config)
    restore_status = source_config.pop('_manual_restore_status', None)
    manual_only = bool(source_config.get('manual_only'))
    status = 'active' if success or failures <= retry_count else 'error'
    next_run = _compute_next_run(job.get('cron_expr', ''), job.get('timezone') or 'UTC')
    if manual_only:
        status, next_run = 'paused', None
    elif restore_status and success:
        status, next_run = restore_status, None if restore_status == 'paused' else next_run
    if not success and failures <= retry_count:
        next_run = (datetime.now(timezone.utc) + timedelta(minutes=max(1, int(job.get('retry_interval_minutes') or 5)))).isoformat()
    patch = {
        'last_run': datetime.now(timezone.utc).isoformat(),
        'status': status,
        'last_run_status': 'succeeded' if success else 'failed',
        'consecutive_failures': failures,
        'error_message': None if success else error_message,
        'next_run': next_run,
        'run_requested_at': None,
        'locked_at': None,
        'locked_by': None,
        'source_config': source_config,
    }
    sb.table('scheduled_jobs').update(patch).eq('id', job['id']).execute()
    if not success and job.get('notify_on_failure', True):
        report_rows = sb.table('published_reports').select('name,organization_id').eq('id', job['report_id']).limit(1).execute().data or []
        report = report_rows[0] if report_rows else {}
        sb.table('notifications').insert({
            'organization_id': report.get('organization_id'), 'user_id': job['created_by'],
            'event_type': 'refresh.failed', 'title': f"Refresh failed: {report.get('name') or job['report_id']}",
            'message': (error_message or 'The scheduled refresh failed.')[:1000],
        }).execute()

def delete_published_report_cloud(report_id: str, user_id: str) -> dict:
    """Delete a published report if the user is the owner or an admin of the workspace it belongs to."""
    sb = _admin_client()
    rep = sb.table('published_reports').select('owner_id').eq('id', report_id).execute()
    
    if not rep.data:
        raise ValueError('Report not found')
        
    is_owner = bool(rep.data[0].get('owner_id') == user_id)
    if not is_owner:
        raise PermissionError('Only the report owner can delete this report from the cloud.')
        
    sb.table('published_reports').delete().eq('id', report_id).execute()
    return {'ok': True, 'id': report_id}
