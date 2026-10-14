-- VTAB Services: notification preferences and durable email delivery.
-- Apply after 005_reporting_service_foundation.sql and 008_refresh_runtime.sql.

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS report_id text REFERENCES public.published_reports(id) ON DELETE CASCADE;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'system';
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'info';
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS action_url text;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_user_dedupe
  ON public.notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON public.notifications(user_id, created_at DESC) WHERE read_at IS NULL AND dismissed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'UTC',
  locale text NOT NULL DEFAULT 'en-IN',
  in_app_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT true,
  collaboration_in_app boolean NOT NULL DEFAULT true,
  collaboration_email boolean NOT NULL DEFAULT true,
  refresh_failure_in_app boolean NOT NULL DEFAULT true,
  refresh_failure_email boolean NOT NULL DEFAULT true,
  refresh_success_in_app boolean NOT NULL DEFAULT false,
  refresh_success_email boolean NOT NULL DEFAULT false,
  subscriptions_in_app boolean NOT NULL DEFAULT true,
  subscriptions_email boolean NOT NULL DEFAULT true,
  alerts_in_app boolean NOT NULL DEFAULT true,
  alerts_email boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_delivery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notification_id uuid REFERENCES public.notifications(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  subject text NOT NULL,
  text_body text NOT NULL,
  html_body text,
  category text NOT NULL DEFAULT 'system',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','retrying','sent','failed')),
  idempotency_key text NOT NULL UNIQUE,
  provider text,
  provider_message_id text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 4,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  sent_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.email_delivery_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','failed')),
  provider text,
  provider_message_id text,
  error_message text,
  duration_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_email_jobs_due
  ON public.email_delivery_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_email_jobs_user_time
  ON public.email_delivery_jobs(user_id, created_at DESC);

ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS notify_on_success boolean NOT NULL DEFAULT false;
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS notification_channels text[] NOT NULL DEFAULT ARRAY['in_app','email']::text[];

ALTER TABLE public.user_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_delivery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_delivery_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage notification preferences" ON public.user_notification_preferences;
CREATE POLICY "Users manage notification preferences" ON public.user_notification_preferences
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users see their email delivery jobs" ON public.email_delivery_jobs;
CREATE POLICY "Users see their email delivery jobs" ON public.email_delivery_jobs
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users see their email attempts" ON public.email_delivery_attempts;
CREATE POLICY "Users see their email attempts" ON public.email_delivery_attempts
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.email_delivery_jobs j WHERE j.id = job_id AND j.user_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.claim_vtab_email_jobs(p_worker_id text, p_limit integer DEFAULT 10)
RETURNS SETOF public.email_delivery_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.email_delivery_jobs
    WHERE status IN ('queued','retrying')
      AND next_attempt_at <= now()
      AND (locked_at IS NULL OR locked_at < now() - interval '15 minutes')
    ORDER BY next_attempt_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 50))
  )
  UPDATE public.email_delivery_jobs j
  SET status = 'processing', locked_at = now(), locked_by = p_worker_id,
      attempts = attempts + 1, updated_at = now()
  FROM due WHERE j.id = due.id
  RETURNING j.*;
END $$;

REVOKE ALL ON FUNCTION public.claim_vtab_email_jobs(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_vtab_email_jobs(text, integer) TO service_role;

-- Include the extended table in Supabase Realtime when available. This block is
-- safe to rerun and harmless on installations that already publish the table.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

