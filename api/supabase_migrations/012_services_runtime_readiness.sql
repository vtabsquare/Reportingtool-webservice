-- Services hardening: a publish-time managed snapshot is viewable content,
-- but it is not a tested live refresh connection.
UPDATE public.semantic_model_connections
SET status = 'not_configured',
    last_error = NULL,
    updated_at = now()
WHERE source_type = 'managed_file'
  AND status = 'connected';

CREATE INDEX IF NOT EXISTS idx_refresh_runs_job_status
  ON public.refresh_runs(job_id, created_at DESC);
