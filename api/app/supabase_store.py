"""
supabase_store.py — Cloud publish/share service for VTAB Reporting Studio.

This is an ADDITIVE module. It does NOT modify existing SQLite storage.
The existing `storage.py` and all its callers are completely unchanged.
"""
from __future__ import annotations
import os, json, io, zipfile, hashlib
from typing import Optional

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
            "name": r["name"],
            "published_at": r["published_at"],
            "updated_at": r.get("updated_at"),
            "role": role_map.get(r["id"], "Viewer"),
            "pages": len(pages),
            "sourceType": p.get("sourceType") or p.get("dataSourceType")
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
    ws = sb.table('workspaces').select('created_by').eq('id', workspace_id).execute()
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
    rep_counts = sb.table('workspace_reports').select('workspace_id', count='exact').in_('workspace_id', list(ws_map.keys())).execute()
    
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
    return res

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

    # Get reports in workspace
    ws_reports = sb.table('workspace_reports') \
        .select('report_id, shared_at') \
        .eq('workspace_id', workspace_id) \
        .execute()

    report_list = []
    if ws_reports.data:
        rids = [wr['report_id'] for wr in ws_reports.data]
        reports = sb.table('published_reports') \
            .select('id, name, published_at') \
            .in_('id', rids) \
            .execute()
        shared_map = {wr['report_id']: wr['shared_at'] for wr in ws_reports.data}
        for rpt in (reports.data or []):
            report_list.append({
                'id': rpt['id'],
                'name': rpt['name'],
                'published_at': rpt['published_at'],
                'shared_at': shared_map.get(rpt['id']),
            })

    return {
        **ws.data[0],
        'role': mem.data[0]['role'],
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
    rows = sb.table('published_reports').select('id,name,owner_id,workspace_id,project_json').eq('id', report_id).limit(1).execute().data or []
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
    _report_manager(sb, report_id, user_id)
    mappings = (source_config or {}).get('mappings') or []
    if not mappings:
        raise ValueError('Map at least one report table before activating refresh.')
    table_names = [str(item.get('table') or '').strip() for item in mappings]
    if any(not name for name in table_names) or len(set(table_names)) != len(table_names):
        raise ValueError('Every table mapping must have a unique report table name.')

    payload = {
        'report_id': report_id,
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
        .select('id, report_id, source_type, cron_expr, interval_label, timezone, source_config, notify_on_failure, status, last_run, next_run, last_run_status, error_message, consecutive_failures, created_at, updated_at') \
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
    from datetime import datetime, timezone
    sb = _admin_client()
    _job_for_manager(sb, job_id, user_id)
    now = datetime.now(timezone.utc).isoformat()
    rows = sb.table('scheduled_jobs').update({
        'status': 'active', 'run_requested_at': now, 'next_run': now,
        'locked_at': None, 'locked_by': None,
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
        checks.append({'id': 'database', 'ok': True, 'message': 'Refresh database migration is installed.'})
    except Exception as error:
        checks.append({'id': 'database', 'ok': False, 'message': 'Run api/supabase_migrations/008_refresh_runtime.sql in Supabase. ' + str(error)})
    worker_enabled = os.environ.get('VTAB_REFRESH_WORKER_ENABLED', '1') != '0'
    checks.append({'id': 'worker', 'ok': worker_enabled, 'message': 'Refresh worker is enabled.' if worker_enabled else 'Set VTAB_REFRESH_WORKER_ENABLED=1 on the backend.'})
    return {'ok': all(item['ok'] for item in checks), 'checks': checks, 'user_id': user_id}


def complete_refresh_job(job: dict, success: bool, error_message: str = None, client=None) -> None:
    """Finish a claimed run, schedule the next one, and preserve failure health."""
    from datetime import datetime, timezone
    sb = client or _admin_client()
    failures = 0 if success else int(job.get('consecutive_failures') or 0) + 1
    status = 'active' if success or failures < 4 else 'error'
    patch = {
        'last_run': datetime.now(timezone.utc).isoformat(),
        'status': status,
        'last_run_status': 'succeeded' if success else 'failed',
        'consecutive_failures': failures,
        'error_message': None if success else error_message,
        'next_run': _compute_next_run(job.get('cron_expr', ''), job.get('timezone') or 'UTC'),
        'run_requested_at': None,
        'locked_at': None,
        'locked_by': None,
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
