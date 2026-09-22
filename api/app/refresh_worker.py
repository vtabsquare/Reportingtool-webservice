from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import tempfile
import threading
import time
import uuid
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from .credential_vault import decrypt_credentials
from .connectors import _database_connect, _safe_select


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_project(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return copy.deepcopy(value)
    return json.loads(value or "{}")


def source_frame(source_type: str, credentials: dict, mapping: dict) -> pd.DataFrame:
    source_type = (source_type or "").lower()
    if source_type == "google_sheets":
        from .connectors import _download_public_xlsx, _google_sheet_csv, _validate_remote_url
        url = str(mapping.get("url") or credentials.get("sheet_url") or "").strip()
        if not url:
            raise ValueError("A Google Sheets URL is required for every refreshed table.")

        # New schedules store the selected worksheet name. Read that worksheet
        # from the XLSX export so multi-tab spreadsheets refresh the correct table.
        sheet_name = str(mapping.get("sheet") or mapping.get("sheet_name") or "").strip()
        if sheet_name:
            try:
                xlsx_data = _download_public_xlsx(url)
                return pd.read_excel(io.BytesIO(xlsx_data), sheet_name=sheet_name, engine="openpyxl")
            except Exception as error:
                raise ValueError(f'Google Sheets worksheet "{sheet_name}" could not be refreshed: {error}') from error

        # Backward compatibility for schedules created before worksheet mapping
        # was added. If the original link includes a gid it is preserved; otherwise
        # Google exports the first worksheet instead of forcing the invalid gid=0.
        csv_url = _google_sheet_csv(url)
        _validate_remote_url(csv_url)
        return pd.read_csv(csv_url)
    if source_type in ("rest", "odata", "graphql"):
        from .connectors import _validate_remote_url
        url = str(mapping.get("url") or credentials.get("url") or credentials.get("endpoint") or credentials.get("base_url") or "").strip()
        if not url:
            raise ValueError("An endpoint URL is required for every API-backed table.")
        _validate_remote_url(url)
        headers = {str(k): str(v) for k, v in (credentials.get("headers") or {}).items()}
        token = credentials.get("api_key") or credentials.get("token") or credentials.get("access_token")
        if token and "Authorization" not in headers:
            headers["Authorization"] = f"Bearer {token}"
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=max(1, min(int(credentials.get("timeout") or 30), 120))) as response:
            content_type = (response.headers.get("Content-Type") or "").lower()
            payload = response.read()
        if "csv" in content_type or url.lower().split("?")[0].endswith(".csv"):
            return pd.read_csv(io.BytesIO(payload))
        data = json.loads(payload.decode("utf-8"))
        record_path = str(mapping.get("record_path") or "").strip()
        for part in [item for item in record_path.split(".") if item]:
            data = data[part]
        if isinstance(data, dict):
            data = data.get("value") or data.get("items") or data.get("data") or [data]
        return pd.json_normalize(data)
    query = _safe_select(str(mapping.get("query") or ""))
    connection = _database_connect(source_type, credentials)
    try:
        return pd.read_sql_query(query, connection)
    finally:
        connection.close()


def parquet_bytes(frame: pd.DataFrame) -> bytes:
    import duckdb
    with tempfile.TemporaryDirectory(prefix="vtab-refresh-") as directory:
        target = Path(directory) / "snapshot.parquet"
        con = duckdb.connect()
        try:
            con.register("refresh_frame", frame)
            escaped = target.as_posix().replace("'", "''")
            con.execute(f"COPY refresh_frame TO '{escaped}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        finally:
            con.close()
        return target.read_bytes()


def execute_refresh(job: dict[str, Any], client=None) -> dict[str, Any]:
    from .supabase_store import _admin_client
    client = client or _admin_client()
    report_id = str(job["report_id"])
    response = client.table("published_reports").select("id,name,owner_id,semantic_model_id,project_json").eq("id", report_id).limit(1).execute()
    if not response.data:
        raise ValueError("Published report not found.")
    report_row = response.data[0]
    project = parse_project(report_row.get("project_json"))
    model_tables = (project.get("model") or {}).get("tables") or {}
    source_config = job.get("source_config") or {}
    if isinstance(source_config, str):
        source_config = json.loads(source_config or "{}")
    mappings = source_config.get("mappings") or []
    runtime_connections = []
    semantic_model_id = str(report_row.get("semantic_model_id") or job.get("semantic_model_id") or "").strip()
    if str(job.get("source_type") or "") == "semantic_model":
        runtime_connections = client.table("semantic_model_connections").select("id,name,source_type,connection_config,credentials_enc,table_mappings,gateway_id,status").eq("semantic_model_id", semantic_model_id).execute().data or []
        if not runtime_connections:
            raise ValueError("The semantic model has no configured data sources.")
        mappings = []
        for connection_row in runtime_connections:
            if connection_row.get("status") != "connected":
                raise ValueError(f'Data source "{connection_row.get("name")}" is not connected.')
            gateway_id = connection_row.get("gateway_id")
            if gateway_id:
                gateways = client.table("vtab_gateways").select("name,status,last_heartbeat,execution_mode").eq("id", gateway_id).limit(1).execute().data or []
                if not gateways or gateways[0].get("status") != "online":
                    gateway_name = gateways[0].get("name") if gateways else gateway_id
                    raise ValueError(f'Gateway "{gateway_name}" is unavailable. The previous successful model remains active.')
                if gateways[0].get("execution_mode") != "service_network":
                    raise ValueError(f'Gateway "{gateways[0].get("name") or gateway_id}" has no connected on-premises agent runtime. The previous successful model remains active.')
            for mapping in connection_row.get("table_mappings") or []:
                mappings.append({**mapping, "_connection": connection_row})
    if not mappings:
        raise ValueError("The schedule has no report-table mappings. Edit the schedule and map at least one table.")
    credentials = decrypt_credentials(job.get("credentials_enc"))
    parameter_rows = client.table("semantic_model_parameters").select("name,current_value").eq("semantic_model_id", semantic_model_id).execute().data or [] if semantic_model_id else []
    parameters = {str(row.get("name")): row.get("current_value") for row in parameter_rows}
    refreshed = []
    owner_id = str(report_row.get("owner_id") or job.get("created_by") or "service")
    bucket = client.storage.from_("vtab-reports")
    for mapping in mappings:
        table_name = str(mapping.get("table") or "").strip()
        if table_name not in model_tables:
            raise ValueError(f'Report table "{table_name}" no longer exists.')
        current_mapping = dict(mapping)
        for parameter_name, parameter_value in parameters.items():
            token = "{{" + parameter_name + "}}"
            if token in str(current_mapping.get("query") or ""):
                if parameter_value is None:
                    replacement = "NULL"
                elif isinstance(parameter_value, bool):
                    replacement = "TRUE" if parameter_value else "FALSE"
                elif isinstance(parameter_value, (int, float)):
                    replacement = str(parameter_value)
                else:
                    replacement = "'" + str(parameter_value).replace("'", "''") + "'"
                current_mapping["query"] = str(current_mapping.get("query") or "").replace(token, replacement)
            if token in str(current_mapping.get("url") or ""):
                from urllib.parse import quote
                current_mapping["url"] = str(current_mapping.get("url") or "").replace(token, quote(str(parameter_value), safe=""))
        connection_row = current_mapping.pop("_connection", None)
        if connection_row:
            connection_config = connection_row.get("connection_config") or {}
            if isinstance(connection_config, str):
                connection_config = json.loads(connection_config or "{}")
            connection_credentials = decrypt_credentials(connection_row.get("credentials_enc"))
            active_credentials = {**connection_config, **connection_credentials}
            active_source_type = str(connection_row.get("source_type") or "")
        else:
            active_credentials = credentials
            active_source_type = str(job.get("source_type"))
        if active_source_type == "managed_file":
            storage_path = str(current_mapping.get("storage_path") or "").strip()
            if not storage_path:
                raise ValueError(f'Managed file mapping for "{table_name}" has no storage asset.')
            try:
                managed_payload = client.storage.from_("vtab-reports").download(storage_path)
                frame = pd.read_parquet(io.BytesIO(managed_payload))
            except Exception as error:
                raise ValueError(f'Managed file for "{table_name}" is unavailable: {error}') from error
        else:
            frame = source_frame(active_source_type, active_credentials, current_mapping)
        payload = parquet_bytes(frame)
        digest = hashlib.sha256(payload).hexdigest()[:16]
        safe = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in table_name)[:80] or "Table"
        storage_path = f"{owner_id}/{report_id}/refresh/{safe}_{digest}.parquet"
        bucket.upload(storage_path, payload, {"content-type": "application/octet-stream", "upsert": "true"})
        model_tables[table_name]["sourceStoragePath"] = storage_path
        model_tables[table_name].pop("sourceUrl", None)
        refreshed.append({"table": table_name, "rows": int(len(frame)), "storagePath": storage_path})
    # Only switch the report after every table upload succeeds. A failed run
    # therefore leaves the last known-good report snapshot online.
    client.table("published_reports").update({"project_json": json.dumps(project), "updated_at": utc_now()}).eq("id", report_id).execute()
    if semantic_model_id:
        client.table("semantic_models").update({"definition": project.get("model") or {}, "updated_at": utc_now()}).eq("id", semantic_model_id).execute()
    return {"tables": refreshed, "rows": sum(item["rows"] for item in refreshed)}


class RefreshWorker:
    def __init__(self, poll_seconds: int | None = None):
        self.poll_seconds = poll_seconds or int(os.environ.get("VTAB_REFRESH_POLL_SECONDS", "30"))
        self.worker_id = os.environ.get("VTAB_REFRESH_WORKER_ID") or f"worker-{uuid.uuid4()}"
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self):
        if os.environ.get("VTAB_REFRESH_WORKER_ENABLED", "1") == "0" or self._thread:
            return self
        self._thread = threading.Thread(target=self._loop, name="vtab-refresh-worker", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception as error:
                print(f"VTAB refresh worker poll failed: {error}")
            self._stop.wait(self.poll_seconds)

    def run_once(self):
        from .supabase_store import _admin_client, complete_refresh_job
        client = _admin_client()
        claimed = client.rpc("claim_vtab_refresh_jobs", {"p_worker_id": self.worker_id, "p_limit": 2}).execute().data or []
        for job in claimed:
            started = time.time()
            trigger = "manual" if job.get("run_requested_at") else "scheduled"
            config = job.get("source_config") or {}
            if isinstance(config, str):
                config = json.loads(config or "{}")
            run_row = client.table("refresh_runs").insert({
                "job_id": job["id"], "report_id": job["report_id"],
                "semantic_model_id": job.get("semantic_model_id"),
                "requested_by": job.get("created_by"), "trigger_type": trigger,
                "status": "running", "started_at": utc_now(),
                "tables_total": len(config.get("mappings") or []),
            }).execute().data[0]
            try:
                result = execute_refresh(job, client)
                client.table("refresh_runs").update({
                    "status": "succeeded", "completed_at": utc_now(),
                    "duration_ms": int((time.time()-started)*1000),
                    "tables_refreshed": len(result["tables"]),
                    "rows_processed": result["rows"], "details": result,
                }).eq("id", run_row["id"]).execute()
                complete_refresh_job(job, True, None, client)
            except Exception as error:
                message = str(error)[:2000]
                lowered = message.lower()
                stage = "Gateway" if "gateway" in lowered else "Connection / Extraction"
                client.table("refresh_runs").update({
                    "status": "failed", "completed_at": utc_now(),
                    "duration_ms": int((time.time()-started)*1000),
                    "error_message": message,
                    "details": {
                        "stage": stage,
                        "suggestedDiagnostic": "Check gateway status and data-source credentials." if stage == "Gateway" else "Test the affected connection and verify its credentials, endpoint, and table mapping.",
                    },
                }).eq("id", run_row["id"]).execute()
                complete_refresh_job(job, False, message, client)


_worker: RefreshWorker | None = None


def start_refresh_worker() -> RefreshWorker:
    global _worker
    if _worker is None:
        _worker = RefreshWorker().start()
    return _worker
