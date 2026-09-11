-- VTAB Services 5.1: production scheduled refresh runtime.
-- Apply after 004_scheduler.sql and 005_reporting_service_foundation.sql.

ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS source_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS notify_on_failure boolean NOT NULL DEFAULT true;
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS locked_by text;
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS run_requested_at timestamptz;
ALTER TABLE public.scheduled_jobs DROP CONSTRAINT IF EXISTS scheduled_jobs_source_type_check;
ALTER TABLE public.scheduled_jobs ADD CONSTRAINT scheduled_jobs_source_type_check CHECK (
  source_type IN ('google_sheets','postgresql','postgres','redshift','sqlserver','synapse','fabric_warehouse','mysql','mariadb')
);

CREATE TABLE IF NOT EXISTS public.refresh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.scheduled_jobs(id) ON DELETE CASCADE,
  report_id text NOT NULL REFERENCES public.published_reports(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('scheduled','manual')),
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','warning')),
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms bigint,
  tables_total integer NOT NULL DEFAULT 0,
  tables_refreshed integer NOT NULL DEFAULT 0,
  rows_processed bigint NOT NULL DEFAULT 0,
  error_message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_runs_report_time ON public.refresh_runs(report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_runs_job_time ON public.refresh_runs(job_id, created_at DESC);
ALTER TABLE public.refresh_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Report members see refresh history" ON public.refresh_runs;
CREATE POLICY "Report members see refresh history" ON public.refresh_runs FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.published_reports pr
    LEFT JOIN public.workspace_members wm ON wm.workspace_id = pr.workspace_id AND wm.user_id = auth.uid()
    LEFT JOIN public.report_access_grants rag ON rag.report_id = pr.id AND rag.user_id = auth.uid()
    WHERE pr.id = refresh_runs.report_id
      AND (pr.owner_id = auth.uid() OR wm.user_id IS NOT NULL OR rag.user_id IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION public.claim_vtab_refresh_jobs(p_worker_id text, p_limit integer DEFAULT 2)
RETURNS SETOF public.scheduled_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.scheduled_jobs
    WHERE status = 'active'
      AND (next_run <= now() OR run_requested_at IS NOT NULL)
      AND (locked_at IS NULL OR locked_at < now() - interval '20 minutes')
    ORDER BY COALESCE(run_requested_at, next_run), created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 10))
  )
  UPDATE public.scheduled_jobs j
  SET locked_at = now(), locked_by = p_worker_id, updated_at = now()
  FROM due WHERE j.id = due.id
  RETURNING j.*;
END $$;

REVOKE ALL ON FUNCTION public.claim_vtab_refresh_jobs(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_vtab_refresh_jobs(text, integer) TO service_role;
