from __future__ import annotations

import os
import threading
import uuid


class AutomationWorker:
    def __init__(self,poll_seconds:int|None=None):
        self.poll_seconds=poll_seconds or int(os.environ.get("VTAB_AUTOMATION_POLL_SECONDS","30"))
        self.worker_id=os.environ.get("VTAB_AUTOMATION_WORKER_ID") or f"automation-{uuid.uuid4()}"
        self._stop=threading.Event();self._thread:threading.Thread|None=None

    def start(self):
        if os.environ.get("VTAB_AUTOMATION_WORKER_ENABLED","1")=="0" or self._thread:return self
        self._thread=threading.Thread(target=self._loop,name="vtab-automation-worker",daemon=True);self._thread.start();return self

    def stop(self):
        self._stop.set()
        if self._thread:self._thread.join(timeout=5)

    def _loop(self):
        while not self._stop.is_set():
            try:self.run_once()
            except Exception as error:print(f"VTAB automation worker poll failed: {error}",flush=True)
            self._stop.wait(self.poll_seconds)

    def run_once(self):
        from .supabase_store import _admin_client
        from .automation_service import execute_subscription,evaluate_alert,queue_after_refresh
        sb=_admin_client()

        # Check for completed Desktop Data Bridge refresh jobs that have not triggered after-refresh automation yet
        try:
            recent_bridge_jobs=(
                sb.table("vtab_bridge_refresh_jobs")
                .select("id,report_id,semantic_model_id,requested_by,status,error_message,result")
                .order("completed_at",desc=True)
                .limit(5)
                .execute()
                .data or []
            )
            for b_job in recent_bridge_jobs:
                res=b_job.get("result") or {}
                if isinstance(res,dict) and not res.get("after_refresh_queued"):
                    report_id=b_job.get("report_id")
                    user_id=b_job.get("requested_by")
                    status=b_job.get("status")
                    rep=sb.table("published_reports").select("name,workspace_id").eq("id",report_id).limit(1).execute().data or []
                    r_name=rep[0].get("name") if rep else "Report"
                    ws_id=rep[0].get("workspace_id") if rep else None
                    if status=="succeeded":
                        if report_id:
                            queue_after_refresh(report_id)
                        if ws_id:
                            try:
                                from .notification_service import notify_workspace_members
                                rows_cnt=res.get("rows") or 0
                                notify_workspace_members(
                                    workspace_id=ws_id,
                                    event_type="refresh.succeeded",
                                    category="refresh",
                                    severity="success",
                                    title=f"Refresh completed: {r_name}",
                                    message=f"The Desktop Data Bridge refresh completed successfully. {rows_cnt} row(s) processed.",
                                    report_id=report_id,
                                    action_url=f"/?viewer={report_id}",
                                    fallback_user_id=user_id,
                                    override_channels=["in_app","email"],
                                )
                            except Exception as notif_err:
                                print(f"VTAB bridge success notification error: {notif_err}",flush=True)
                    elif status=="failed":
                        if ws_id:
                            try:
                                from .notification_service import notify_workspace_members
                                err_msg=b_job.get("error_message") or "The Desktop Data Bridge refresh failed."
                                notify_workspace_members(
                                    workspace_id=ws_id,
                                    event_type="refresh.failed",
                                    category="refresh",
                                    severity="error",
                                    title=f"Refresh failed: {r_name}",
                                    message=err_msg,
                                    report_id=report_id,
                                    action_url=f"/?viewer={report_id}",
                                    fallback_user_id=user_id,
                                    override_channels=["in_app","email"],
                                )
                            except Exception as notif_err:
                                print(f"VTAB bridge failure notification error: {notif_err}",flush=True)
                    res["after_refresh_queued"]=True
                    sb.table("vtab_bridge_refresh_jobs").update({"result":res}).eq("id",b_job["id"]).execute()
        except Exception as bridge_auto_err:
            print(f"VTAB bridge after-refresh check failed: {bridge_auto_err}",flush=True)

        subscriptions=sb.rpc("claim_vtab_subscriptions",{"p_worker_id":self.worker_id,"p_limit":5}).execute().data or []
        for subscription in subscriptions:
            try:execute_subscription(subscription,"after_refresh" if subscription.get("frequency")=="after_refresh" else "schedule")
            except Exception as error:print(f"VTAB subscription {subscription.get('id')} failed: {error}",flush=True)
        alerts=sb.rpc("claim_vtab_alerts",{"p_worker_id":self.worker_id,"p_limit":10}).execute().data or []
        for rule in alerts:
            try:evaluate_alert(rule,"after_refresh" if rule.get("evaluation_mode")=="after_refresh" else "interval")
            except Exception as error:print(f"VTAB alert {rule.get('id')} failed: {error}",flush=True)


_worker:AutomationWorker|None=None
def start_automation_worker()->AutomationWorker:
    global _worker
    if _worker is None:_worker=AutomationWorker().start()
    return _worker

