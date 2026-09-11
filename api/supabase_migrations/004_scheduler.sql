-- ============================================================
-- Migration 004: Scheduled Refresh Jobs
-- Run this in: Supabase Dashboard -> SQL Editor
-- ============================================================

-- 1. Scheduled jobs table
CREATE TABLE IF NOT EXISTS public.scheduled_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       text NOT NULL REFERENCES public.published_reports(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type     text NOT NULL CHECK (source_type IN ('google_sheets', 'postgres', 'sqlserver')),
  cron_expr       text NOT NULL,           -- e.g. '0 9 * * *' = daily 9am UTC
  interval_label  text NOT NULL,           -- human label: 'Daily at 09:00', 'Hourly', etc.
  credentials_enc text,                    -- encrypted JSON (pgcrypto)

  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  last_run        timestamptz,
  last_run_status text,
  next_run        timestamptz,
  error_message   text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sched_jobs_report ON public.scheduled_jobs (report_id);
CREATE INDEX IF NOT EXISTS idx_sched_jobs_next_run ON public.scheduled_jobs (next_run) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sched_jobs_created_by ON public.scheduled_jobs (created_by);

-- 2. Row-Level Security
ALTER TABLE public.scheduled_jobs ENABLE ROW LEVEL SECURITY;

-- Only the creator can view/modify their own scheduled jobs
DROP POLICY IF EXISTS "Users can manage their own scheduled jobs" ON public.scheduled_jobs;
CREATE POLICY "Users can manage their own scheduled jobs"
  ON public.scheduled_jobs
  FOR ALL
  TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- 3. Updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sched_jobs_updated_at ON public.scheduled_jobs;
CREATE TRIGGER trg_sched_jobs_updated_at
  BEFORE UPDATE ON public.scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
