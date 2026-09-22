"""Reporting Service boundary used by both Desktop and Web clients.

The module deliberately keeps the existing VTAB project/report definition intact.
It validates and sanitizes a snapshot, then delegates the transactional publish to
Supabase/PostgreSQL.  No service-role credential is required by the Desktop app.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path
from typing import Any


SERVICE_API_VERSION = "v1"
REPORT_SCHEMA_VERSION = "1.0"
MAX_REPORT_BYTES = int(os.environ.get("VTAB_MAX_REPORT_BYTES", 25 * 1024 * 1024))
PUBLISH_ROLES = {"Admin", "Member", "Contributor"}
_SECRET_KEYS = {
    "password", "passwd", "pwd", "secret", "clientsecret", "client_secret",
    "accesstoken", "access_token", "refreshtoken", "refresh_token", "apikey",
    "api_key", "credentials", "credential",
}


class ServiceValidationError(ValueError):
    """Raised when a desktop report cannot safely be published."""


class ServiceConflictError(ServiceValidationError):
    """Raised when publishing would replace a report without confirmation."""


def _anon_client(access_token: str | None = None):
    url = os.environ.get("VITE_SUPABASE_URL", "")
    key = os.environ.get("VITE_SUPABASE_ANON_KEY", "")
    if not url or not key:
        raise RuntimeError("Reporting Service is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.")
    from supabase import create_client

    client = create_client(url, key)
    if access_token:
        client.postgrest.auth(access_token)
    return client


def authenticate(access_token: str) -> dict[str, Any]:
    """Validate a Supabase access token with the auth service (not by decoding it)."""
    if not access_token:
        raise PermissionError("Sign in to the Reporting Service first.")
    try:
        response = _anon_client().auth.get_user(access_token)
    except Exception as error:
        raise PermissionError("Your Reporting Service session is invalid or expired. Sign in again.") from error
    user = getattr(response, "user", None)
    user_id = str(getattr(user, "id", "") or "")
    if not user_id:
        raise PermissionError("Your Reporting Service session is invalid or expired. Sign in again.")
    return {"id": user_id, "email": getattr(user, "email", None)}


def _key_token(value: Any) -> str:
    return str(value or "").replace("-", "").replace(" ", "").lower()


def _sanitize(value: Any) -> Any:
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    if not isinstance(value, dict):
        return value
    clean: dict[str, Any] = {}
    for key, item in value.items():
        if _key_token(key) in _SECRET_KEYS:
            continue
        clean[key] = _sanitize(item)
    return clean


def prepare_report_snapshot(project: dict[str, Any]) -> dict[str, Any]:
    """Validate the common report definition and remove inline credentials."""
    if not isinstance(project, dict):
        raise ServiceValidationError("Report definition must be a JSON object.")
    report = project.get("report")
    model = project.get("model")
    if not isinstance(report, dict):
        raise ServiceValidationError("The project does not contain a report definition.")
    if not isinstance(model, dict):
        raise ServiceValidationError("The project does not contain a semantic model.")
    pages = report.get("pages")
    if not isinstance(pages, list) or not pages:
        raise ServiceValidationError("Add at least one report page before publishing.")
    page_ids: set[str] = set()
    visual_ids: set[str] = set()
    for index, page in enumerate(pages, start=1):
        if not isinstance(page, dict) or "visuals" not in page or not isinstance(page.get("visuals"), list):
            raise ServiceValidationError(f"Report page {index} has an invalid visual definition.")
        page_id = str(page.get("id") or "").strip()
        if not page_id:
            raise ServiceValidationError(f"Report page {index} is missing its persistent page id.")
        if page_id in page_ids:
            raise ServiceValidationError(f"Report page {index} duplicates page id {page_id}.")
        page_ids.add(page_id)
        settings = page.get("settings")
        if settings is not None and not isinstance(settings, dict):
            raise ServiceValidationError(f"Report page {index} has invalid page settings.")
        for visual_index, visual in enumerate(page["visuals"], start=1):
            if not isinstance(visual, dict):
                raise ServiceValidationError(f"Visual {visual_index} on report page {index} is invalid.")
            visual_id = str(visual.get("id") or "").strip()
            if not visual_id:
                raise ServiceValidationError(f"Visual {visual_index} on report page {index} is missing its persistent visual id.")
            if visual_id in visual_ids:
                raise ServiceValidationError(f"Visual id {visual_id} is duplicated in the report definition.")
            visual_ids.add(visual_id)
            if not isinstance(visual.get("bindings"), dict) or not isinstance(visual.get("format"), dict):
                raise ServiceValidationError(f"Visual {visual_id} is missing its data bindings or formatting definition.")
            geometry = [visual.get(key) for key in ("x", "y", "w", "h")]
            if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in geometry):
                raise ServiceValidationError(f"Visual {visual_id} has invalid x/y/width/height geometry.")
            if visual["w"] <= 0 or visual["h"] <= 0:
                raise ServiceValidationError(f"Visual {visual_id} must have a positive width and height.")
            if visual.get("geometryVersion") == 2:
                for optional_number in ("rotation", "zIndex"):
                    value = visual.get(optional_number)
                    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                        raise ServiceValidationError(f"Visual {visual_id} has an invalid {optional_number} value.")

    paginated_reports = project.get("paginatedReports") or []
    if not isinstance(paginated_reports, list):
        raise ServiceValidationError("Paginated reports must be an array.")
    paginated_ids: set[str] = set()
    for index, definition in enumerate(paginated_reports, start=1):
        if not isinstance(definition, dict):
            raise ServiceValidationError(f"Paginated report {index} is invalid.")
        definition_id = str(definition.get("id") or "").strip()
        if not definition_id or definition_id in paginated_ids:
            raise ServiceValidationError(f"Paginated report {index} has a missing or duplicate id.")
        paginated_ids.add(definition_id)
        page_definition = definition.get("page") or {}
        if page_definition.get("orientation") not in ("portrait", "landscape"):
            raise ServiceValidationError(f"Paginated report {index} has an invalid orientation.")
        for key in ("widthMm", "heightMm"):
            value = page_definition.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ServiceValidationError(f"Paginated report {index} has an invalid {key}.")
        columns = (definition.get("table") or {}).get("columns") or []
        if not isinstance(columns, list):
            raise ServiceValidationError(f"Paginated report {index} has invalid table columns.")
        for column in columns:
            if not isinstance(column, dict) or not str(column.get("field") or "").strip():
                raise ServiceValidationError(f"Paginated report {index} contains an invalid table column.")

    clean = _sanitize(copy.deepcopy(project))
    encoded = json.dumps(clean, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_REPORT_BYTES:
        raise ServiceValidationError(
            f"Report definition is {len(encoded) / 1024 / 1024:.1f} MB; the service limit is "
            f"{MAX_REPORT_BYTES / 1024 / 1024:.0f} MB. Publish large data through object storage."
        )
    return clean


def _attach_source_manifest(snapshot: dict[str, Any]) -> None:
    """Persist non-secret source lineage with the semantic model.

    Desktop projects have evolved through several schema versions, so the
    manifest deliberately reads the known source/query locations without
    removing any existing project fields.  Credentials have already been
    removed by ``prepare_report_snapshot``.
    """
    model = snapshot.setdefault("model", {})
    table_names = list((model.get("tables") or {}).keys())
    transform = snapshot.get("transform") or {}
    queries = transform.get("queries") or snapshot.get("queries") or []
    data_sources = snapshot.get("dataSources") or snapshot.get("sources") or []
    if isinstance(data_sources, dict):
        data_sources = [{"id": key, **(value if isinstance(value, dict) else {"name": str(value)})} for key, value in data_sources.items()]

    sources: list[dict[str, Any]] = []
    for index, raw in enumerate(data_sources if isinstance(data_sources, list) else []):
        if not isinstance(raw, dict):
            continue
        source_id = str(raw.get("id") or raw.get("name") or f"source-{index + 1}")
        sources.append({
            "id": source_id,
            "name": str(raw.get("name") or raw.get("displayName") or source_id),
            "type": str(raw.get("type") or raw.get("sourceType") or "unknown"),
            "configuration": _sanitize(raw.get("configuration") or raw.get("config") or {}),
            "tables": [],
        })

    source_by_id = {item["id"]: item for item in sources}
    model_tables = model.get("tables") or {}
    for index, query in enumerate(queries if isinstance(queries, list) else []):
        if not isinstance(query, dict):
            continue
        source_ref = str(query.get("sourceId") or query.get("source") or query.get("sourceType") or f"query-source-{index + 1}")
        source = source_by_id.get(source_ref)
        if source is None:
            source = {
                "id": source_ref,
                "name": str(query.get("sourceName") or query.get("source") or source_ref),
                "type": str(query.get("sourceType") or "unknown"),
                "configuration": _sanitize(query.get("sourceConfig") or {}),
                "tables": [],
            }
            sources.append(source)
            source_by_id[source_ref] = source
        table_name = str(query.get("semanticName") or query.get("outputTable") or query.get("name") or "").strip()
        if table_name:
            table_definition = model_tables.get(table_name) or {}
            inferred_type = str(query.get("sourceType") or table_definition.get("sourceType") or source.get("type") or "unknown").lower()
            storage_path = str(table_definition.get("sourceStoragePath") or "").strip()
            if storage_path and inferred_type in ("", "unknown", "file", "csv", "excel", "json", "parquet", "xml"):
                inferred_type = "managed_file"
            if str(source.get("type") or "unknown").lower() in ("", "unknown", "file"):
                source["type"] = inferred_type
            source["tables"].append({
                "modelTable": table_name,
                "sourceObject": str(query.get("sourceObject") or query.get("physicalTable") or query.get("physical") or ""),
                "query": str(query.get("sourceQuery") or query.get("query") or query.get("sql") or ""),
                "managedStoragePath": storage_path or None,
            })

    mapped = {str(item.get("modelTable")) for source in sources for item in source.get("tables", [])}
    for table_name in table_names:
        if table_name not in mapped:
            table = (model.get("tables") or {}).get(table_name) or {}
            source_type = str(table.get("sourceType") or "unknown").lower()
            storage_path = str(table.get("sourceStoragePath") or "").strip()
            if storage_path and source_type in ("", "unknown", "file", "csv", "excel", "json", "parquet", "xml"):
                source_type = "managed_file"
            target_source = next((item for item in sources if item.get("type") == source_type), None)
            if target_source is None:
                target_source = {"id": f"source-{source_type}-{len(sources) + 1}", "name": "Managed files" if source_type == "managed_file" else source_type, "type": source_type, "configuration": {}, "tables": []}
                sources.append(target_source)
            target_source["tables"].append({
                "modelTable": table_name,
                "sourceObject": str(table.get("physical") or table.get("physicalName") or table_name),
                "query": "",
                "managedStoragePath": storage_path or None,
            })

    model["sourceManifest"] = {"version": 1, "sources": sources}
    parameters = transform.get("parameters") or snapshot.get("parameters") or model.get("parameters")
    if parameters:
        model["parameters"] = _sanitize(parameters)


def report_definition_hash(project: dict[str, Any]) -> str:
    """Return a stable digest proving the stored definition matches Desktop."""
    canonical = json.dumps(project, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def hydrate_snapshot_sources(project: dict[str, Any], access_token: str, expires_in: int = 900) -> dict[str, Any]:
    """Download authorized private snapshots to a content-addressed local cache.

    DuckDB's optional HTTP extension is not guaranteed to be present in a packaged
    Desktop or Services runtime.  Downloading through the authenticated Supabase
    client keeps RLS enforcement while making every query use a normal local
    Parquet path.
    """
    authenticate(access_token)
    snapshot = copy.deepcopy(project)
    report_id = str((snapshot.get("report") or {}).get("id") or "").strip()
    if not report_id:
        raise ServiceValidationError("Published report id is missing from the snapshot.")
    client = _anon_client(access_token)
    visible = client.table("published_reports").select("id").eq("id", report_id).limit(1).execute()
    if not getattr(visible, "data", None):
        raise PermissionError("You do not have access to this published report.")
    tables = (snapshot.get("model") or {}).get("tables") or {}
    
    url = os.environ.get("VITE_SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("VITE_SUPABASE_ANON_KEY", "")
    if url and key:
        # Build an explicitly viewer-authenticated storage client. Merely
        # applying a token to PostgREST does not update every supabase-py
        # sub-client, so the bearer must be attached to Storage as well.
        from storage3._sync.client import SyncStorageClient
        sb_storage = SyncStorageClient(
            f"{url}/storage/v1/",
            {"apiKey": key, "Authorization": f"Bearer {access_token}"},
        )
        storage = sb_storage.from_("vtab-reports")
    else:
        # This fallback supports an injected/configured Supabase client (and
        # keeps local tests independent of a live cloud project). Production
        # deployments are expected to take the explicit branch above.
        client_storage = getattr(client, "storage", None)
        if client_storage is None:
            raise RuntimeError(
                "Reporting Service storage is not configured. Set "
                "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
            )
        storage = client_storage.from_("vtab-reports")
    
    cache_root = Path(tempfile.gettempdir()) / "vtab-report-snapshots"
    cache_root.mkdir(parents=True, exist_ok=True)
    for table in tables.values():
        if not isinstance(table, dict):
            continue
        storage_path = str(table.get("sourceStoragePath") or "").strip()
        if not storage_path:
            raise ServiceValidationError(
                "This published report has no private data snapshot. Publish it again from Desktop 5.0.15 or newer."
            )
        suffix = Path(storage_path).suffix or ".parquet"
        cache_name = hashlib.sha256(storage_path.encode("utf-8")).hexdigest() + suffix
        cache_path = cache_root / cache_name
        if not cache_path.is_file() or cache_path.stat().st_size == 0:
            try:
                payload = storage.download(storage_path)
            except Exception as error:
                raise RuntimeError(f"Could not download the private data snapshot: {storage_path}") from error
            if not isinstance(payload, (bytes, bytearray)) or not payload:
                raise RuntimeError(f"The private data snapshot is empty: {storage_path}")
            temporary_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(dir=cache_root, suffix=".tmp", delete=False) as temporary:
                    temporary.write(bytes(payload))
                    temporary_path = Path(temporary.name)
                try:
                    os.replace(temporary_path, cache_path)
                except PermissionError:
                    if not cache_path.is_file() or cache_path.stat().st_size == 0:
                        raise
            finally:
                if temporary_path and temporary_path.exists():
                    try:
                        temporary_path.unlink(missing_ok=True)
                    except PermissionError:
                        pass
        table["sourceUrl"] = str(cache_path)
    return snapshot


def publish_context(access_token: str) -> dict[str, Any]:
    user = authenticate(access_token)
    result = _anon_client(access_token).rpc("get_vtab_publish_context").execute()
    data = result.data or {}
    if isinstance(data, dict) and data.get("error"):
        raise PermissionError(data["error"])
    return {
        "user": user,
        "workspaces": data.get("workspaces", []) if isinstance(data, dict) else [],
        "serviceApiVersion": SERVICE_API_VERSION,
        "reportSchemaVersion": REPORT_SCHEMA_VERSION,
    }


def list_workspace_reports(workspace_id: str, access_token: str) -> list[dict[str, Any]]:
    """Return reports visible in one publishable workspace for overwrite detection."""
    context = publish_context(access_token)
    workspace = next((item for item in context["workspaces"] if str(item.get("id")) == workspace_id), None)
    if not workspace:
        raise PermissionError("You are not a member of this workspace.")
    if not workspace.get("canPublish"):
        raise PermissionError("Your workspace role does not include publish permission.")
    response = (
        _anon_client(access_token)
        .table("published_reports")
        .select("id,name,workspace_id,updated_at,current_version_id,semantic_model_id")
        .eq("workspace_id", workspace_id)
        .order("updated_at", desc=True)
        .execute()
    )
    return response.data or []


def _workspace_access(workspace_id: str, access_token: str, require_manage: bool = False) -> dict[str, Any]:
    """Return the caller's workspace entry and enforce model-management roles."""
    context = publish_context(access_token)
    workspace = next((item for item in context["workspaces"] if str(item.get("id")) == workspace_id), None)
    if not workspace:
        raise PermissionError("You are not a member of this workspace.")
    if require_manage and not workspace.get("canPublish"):
        raise PermissionError("Your workspace role does not include semantic model management permission.")
    return workspace


def list_workspace_semantic_models(workspace_id: str, access_token: str) -> list[dict[str, Any]]:
    """List first-class semantic model assets visible in a workspace."""
    _workspace_access(workspace_id, access_token)
    client = _anon_client(access_token)
    response = (
        client.table("semantic_models")
        .select("id,workspace_id,report_id,name,description,status,schema_version,created_at,updated_at,current_version_id,definition,metadata")
        .eq("workspace_id", workspace_id)
        .order("updated_at", desc=True)
        .execute()
    )
    models = response.data or []
    report_response = (
        client.table("published_reports")
        .select("id,name,semantic_model_id,updated_at")
        .eq("workspace_id", workspace_id)
        .execute()
    )
    reports_by_model: dict[str, list[dict[str, Any]]] = {}
    for report in report_response.data or []:
        model_id = str(report.get("semantic_model_id") or "")
        if model_id:
            reports_by_model.setdefault(model_id, []).append(report)
    for model in models:
        definition = model.get("definition") if isinstance(model.get("definition"), dict) else {}
        tables = (definition or {}).get("tables") or {}
        model["tableCount"] = len(tables) if isinstance(tables, dict) else 0
        model["measureCount"] = len((definition or {}).get("measures") or {})
        model["relationshipCount"] = len((definition or {}).get("relationships") or [])
        model["reports"] = reports_by_model.get(str(model.get("id")), [])
        model.pop("definition", None)
    return models


def get_semantic_model(semantic_model_id: str, access_token: str) -> dict[str, Any]:
    """Return one model definition, version history and connected-report lineage."""
    authenticate(access_token)
    client = _anon_client(access_token)
    result = (
        client.table("semantic_models")
        .select("id,workspace_id,report_id,name,description,status,schema_version,created_at,updated_at,current_version_id,definition,metadata")
        .eq("id", semantic_model_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise PermissionError("Semantic model was not found or you do not have access.")
    model = rows[0]
    reports = (
        client.table("published_reports")
        .select("id,name,updated_at")
        .eq("semantic_model_id", semantic_model_id)
        .order("updated_at", desc=True)
        .execute()
    )
    model["reports"] = reports.data or []
    versions = (
        client.table("semantic_model_versions")
        .select("id,version_number,change_description,published_at,published_by")
        .eq("semantic_model_id", semantic_model_id)
        .order("version_number", desc=True)
        .execute()
    )
    model["versions"] = [
        {**item, "version": f"1.{max(0, int(item.get('version_number') or 1) - 1)}"}
        for item in (versions.data or [])
    ]
    return model


def update_semantic_model(semantic_model_id: str, payload: dict[str, Any], access_token: str) -> dict[str, Any]:
    """Update safe model metadata without accepting definitions or credentials."""
    current = get_semantic_model(semantic_model_id, access_token)
    _workspace_access(str(current["workspace_id"]), access_token, require_manage=True)
    updates: dict[str, Any] = {
        "name": str(current.get("name") or "").strip(),
        "description": str(current.get("description") or "").strip(),
    }
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ServiceValidationError("Semantic model name is required.")
        if len(name) > 160:
            raise ServiceValidationError("Semantic model name must be 160 characters or fewer.")
        updates["name"] = name
    if "description" in payload:
        updates["description"] = str(payload.get("description") or "").strip()[:1000]
    result = _anon_client(access_token).rpc("update_vtab_semantic_model_metadata", {
        "p_semantic_model_id": semantic_model_id,
        "p_name": updates["name"],
        "p_description": updates["description"],
    }).execute()
    data = result.data or {}
    if isinstance(data, dict) and data.get("error"):
        raise PermissionError(data["error"])
    return get_semantic_model(semantic_model_id, access_token)


def publish_report(payload: dict[str, Any], access_token: str, service_base_url: str = "") -> dict[str, Any]:
    user = authenticate(access_token)
    workspace_id = str(payload.get("workspaceId") or "").strip()
    report_name = str(payload.get("reportName") or "").strip()
    desktop_version = str(payload.get("desktopVersion") or "").strip()
    schema_version = str(payload.get("reportSchemaVersion") or REPORT_SCHEMA_VERSION).strip()
    if not workspace_id:
        raise ServiceValidationError("Select a workspace before publishing.")
    if not report_name:
        raise ServiceValidationError("Report name is required.")
    if len(report_name) > 160:
        raise ServiceValidationError("Report name must be 160 characters or fewer.")
    if schema_version != REPORT_SCHEMA_VERSION:
        raise ServiceValidationError(
            f"Report schema {schema_version} is not supported by this service. Supported schema: {REPORT_SCHEMA_VERSION}."
        )

    snapshot = prepare_report_snapshot(payload.get("project") or {})
    _attach_source_manifest(snapshot)
    report = snapshot.setdefault("report", {})
    report_id = str(payload.get("reportId") or report.get("id") or "").strip()
    overwrite = bool(payload.get("overwrite", False))
    existing_reports = list_workspace_reports(workspace_id, access_token)
    existing = next((item for item in existing_reports if report_id and str(item.get("id")) == report_id), None)
    if not existing:
        existing = next((item for item in existing_reports if str(item.get("name") or "").strip().casefold() == report_name.casefold()), None)
    if existing and not overwrite:
        raise ServiceConflictError(
            f'A report named "{existing.get("name") or report_name}" already exists in this workspace. Confirm Replace to publish the updated version.'
        )
    if existing:
        report_id = str(existing["id"])
    report["name"] = report_name
    report["id"] = report_id or report.get("id")
    snapshot["name"] = report_name
    definition_hash = report_definition_hash(snapshot)

    response = _anon_client(access_token).rpc("publish_vtab_report", {
        "p_workspace_id": workspace_id,
        "p_report_id": report_id or None,
        "p_report_name": report_name,
        "p_project_json": snapshot,
        "p_semantic_model": snapshot.get("model") or {},
        "p_metadata": {**(payload.get("metadata") or {}), "reportDefinitionHash": definition_hash},
        "p_desktop_version": desktop_version,
        "p_schema_version": schema_version,
        "p_change_description": str(payload.get("changeDescription") or "").strip(),
    }).execute()
    data = response.data or {}
    if isinstance(data, dict) and data.get("error"):
        message = data["error"]
        if "permission" in message.lower() or "member" in message.lower():
            raise PermissionError(message)
        raise ServiceValidationError(message)
    if not isinstance(data, dict) or not data.get("report_id"):
        raise RuntimeError("The Reporting Service returned an invalid publish response.")

    report_id = str(data["report_id"])
    base = service_base_url.rstrip("/")
    data.update({
        "ok": True,
        "publishStatus": "Published",
        "reportId": report_id,
        "workspaceId": str(data.get("workspace_id") or workspace_id),
        "versionId": str(data.get("version_id") or ""),
        "version": str(data.get("version") or "1.0"),
        "semanticModelId": str(data.get("semantic_model_id") or ""),
        "semanticModelName": str(data.get("semantic_model_name") or f"{report_name} Semantic Model"),
        "semanticModelVersionId": str(data.get("semantic_model_version_id") or ""),
        "semanticModelVersion": str(data.get("semantic_model_version") or data.get("version") or "1.0"),
        "publishedAt": data.get("published_at"),
        "publishedBy": user.get("email") or user["id"],
        "reportUrl": f"{base}/?workspace=1&report={report_id}" if base else f"/?workspace=1&report={report_id}",
        "serviceApiVersion": SERVICE_API_VERSION,
        "reportSchemaVersion": REPORT_SCHEMA_VERSION,
        "reportDefinitionHash": definition_hash,
    })
    return data


def list_versions(report_id: str, access_token: str) -> list[dict[str, Any]]:
    authenticate(access_token)
    result = _anon_client(access_token).rpc("list_vtab_report_versions", {"p_report_id": report_id}).execute()
    data = result.data or {}
    if isinstance(data, dict) and data.get("error"):
        raise PermissionError(data["error"])
    return data.get("versions", []) if isinstance(data, dict) else []


def restore_version(report_id: str, version_id: str, access_token: str) -> dict[str, Any]:
    authenticate(access_token)
    result = _anon_client(access_token).rpc("restore_vtab_report_version", {
        "p_report_id": report_id,
        "p_version_id": version_id,
    }).execute()
    data = result.data or {}
    if isinstance(data, dict) and data.get("error"):
        raise PermissionError(data["error"])
    return data
