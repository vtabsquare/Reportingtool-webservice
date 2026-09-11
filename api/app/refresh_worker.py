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
    response = client.table("published_reports").select("id,name,owner_id,project_json").eq("id", report_id).limit(1).execute()
    if not response.data:
        raise ValueError("Published report not found.")
    report_row = response.data[0]
    project = parse_project(report_row.get("project_json"))
    model_tables = (project.get("model") or {}).get("tables") or {}
    source_config = job.get("source_config") or {}
    if isinstance(source_config, str):
        source_config = json.loads(source_config or "{}")
    mappings = source_config.get("mappings") or []
    if not mappings:
        raise ValueError("The schedule has no report-table mappings. Edit the schedule and map at least one table.")
    credentials = decrypt_credentials(job.get("credentials_enc"))
    refreshed = []
    owner_id = str(report_row.get("owner_id") or job.get("created_by") or "service")
    bucket = client.storage.from_("vtab-reports")
    for mapping in mappings:
        table_name = str(mapping.get("table") or "").strip()
        if table_name not in model_tables:
            raise ValueError(f'Report table "{table_name}" no longer exists.')
        frame = source_frame(str(job.get("source_type")), credentials, mapping)
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
                client.table("refresh_runs").update({
                    "status": "failed", "completed_at": utc_now(),
                    "duration_ms": int((time.time()-started)*1000),
                    "error_message": message,
                }).eq("id", run_row["id"]).execute()
                complete_refresh_job(job, False, message, client)


_worker: RefreshWorker | None = None


def start_refresh_worker() -> RefreshWorker:
    global _worker
    if _worker is None:
        _worker = RefreshWorker().start()
    return _worker
