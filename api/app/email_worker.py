from __future__ import annotations

import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from .exports import send_report_email
from .storage import Store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _provider_config() -> dict:
    # Environment values take priority. The settings-store fallback preserves
    # compatibility with existing installations while never exposing secrets.
    stored = Store().get_setting("workspace_email", {}) or {}
    return {
        "host": os.environ.get("VTAB_SMTP_HOST") or stored.get("smtpHost"),
        "port": os.environ.get("VTAB_SMTP_PORT") or stored.get("smtpPort") or 587,
        "username": os.environ.get("VTAB_SMTP_USERNAME") or stored.get("smtpUsername"),
        "password": os.environ.get("VTAB_SMTP_PASSWORD") or stored.get("smtpPassword"),
        "fromEmail": os.environ.get("VTAB_BREVO_FROM_EMAIL") or os.environ.get("VTAB_SMTP_FROM") or stored.get("smtpFrom"),
        "senderName": os.environ.get("VTAB_BREVO_SENDER_NAME") or stored.get("senderName") or "VTAB Reporting Services",
        "ssl": os.environ.get("VTAB_SMTP_SSL", "1" if stored.get("smtpSsl") else "0") == "1",
        "startTls": os.environ.get("VTAB_SMTP_STARTTLS", "1" if stored.get("smtpStartTls", True) else "0") != "0",
        "brevoApiKey": os.environ.get("VTAB_BREVO_API_KEY") or os.environ.get("BREVO_API_KEY"),
    }


class EmailDeliveryWorker:
    def __init__(self, poll_seconds: int | None = None):
        self.poll_seconds = poll_seconds or int(os.environ.get("VTAB_EMAIL_POLL_SECONDS", "15"))
        self.worker_id = os.environ.get("VTAB_EMAIL_WORKER_ID") or f"email-{uuid.uuid4()}"
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self):
        if os.environ.get("VTAB_EMAIL_WORKER_ENABLED", "1") == "0" or self._thread:
            return self
        self._thread = threading.Thread(target=self._loop, name="vtab-email-worker", daemon=True)
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
                print(f"VTAB email worker poll failed: {error}", flush=True)
            self._stop.wait(self.poll_seconds)

    def run_once(self):
        from .supabase_store import _admin_client
        sb = _admin_client()
        jobs = sb.rpc("claim_vtab_email_jobs", {"p_worker_id": self.worker_id, "p_limit": 10}).execute().data or []
        for job in jobs:
            started = time.time()
            attempt = int(job.get("attempts") or 1)
            provider = "brevo" if (_provider_config().get("brevoApiKey")) else "smtp"
            try:
                attachment = None
                if job.get("attachment_storage_path"):
                    attachment = sb.storage.from_("vtab-email-artifacts").download(job["attachment_storage_path"])
                result = send_report_email(
                    smtp_cfg=_provider_config(), to=[job["recipient_email"]], subject=job["subject"],
                    body=job["text_body"], html_body=job.get("html_body"), attachment=attachment,
                    attachment_name=job.get("attachment_name"), attachment_type=job.get("attachment_type"),
                )
                provider_message_id = result.get("providerMessageId") if isinstance(result, dict) else None
                sb.table("email_delivery_attempts").insert({
                    "job_id": job["id"], "attempt_number": attempt, "status": "accepted",
                    "provider": provider, "provider_message_id": provider_message_id,
                    "duration_ms": int((time.time() - started) * 1000),
                }).execute()
                sb.table("email_delivery_jobs").update({
                    "status": "sent", "provider": provider, "provider_message_id": provider_message_id,
                    "sent_at": _now(), "last_error": None, "locked_at": None, "locked_by": None, "updated_at": _now(),
                }).eq("id", job["id"]).execute()
                if job.get("attachment_storage_path"):
                    try: sb.storage.from_("vtab-email-artifacts").remove([job["attachment_storage_path"]])
                    except Exception: pass
            except Exception as error:
                message = str(error)[:1500]
                final = attempt >= int(job.get("max_attempts") or 4)
                delay = min(60, 2 ** max(0, attempt - 1))
                sb.table("email_delivery_attempts").insert({
                    "job_id": job["id"], "attempt_number": attempt, "status": "failed",
                    "provider": provider, "error_message": message,
                    "duration_ms": int((time.time() - started) * 1000),
                }).execute()
                sb.table("email_delivery_jobs").update({
                    "status": "failed" if final else "retrying", "provider": provider,
                    "last_error": message, "next_attempt_at": (datetime.now(timezone.utc) + timedelta(minutes=delay)).isoformat(),
                    "locked_at": None, "locked_by": None, "updated_at": _now(),
                }).eq("id", job["id"]).execute()


_worker: EmailDeliveryWorker | None = None


def start_email_worker() -> EmailDeliveryWorker:
    global _worker
    if _worker is None:
        _worker = EmailDeliveryWorker().start()
    return _worker

