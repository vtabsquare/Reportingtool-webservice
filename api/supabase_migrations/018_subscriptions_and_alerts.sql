-- VTAB Services: report subscriptions and data-driven alerts.
-- Apply after 017_notification_email_foundation.sql.

ALTER TABLE public.email_delivery_jobs ADD COLUMN IF NOT EXISTS attachment_storage_path text;
ALTER TABLE public.email_delivery_jobs ADD COLUMN IF NOT EXISTS attachment_name text;
ALTER TABLE public.email_delivery_jobs ADD COLUMN IF NOT EXISTS attachment_type text;

INSERT INTO storage.buckets(id,name,public,file_size_limit)
VALUES ('vtab-email-artifacts','vtab-email-artifacts',false,26214400)
ON CONFLICT (id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit;

CREATE TABLE IF NOT EXISTS public.report_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  report_id text NOT NULL REFERENCES public.published_reports(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  page_id text,
  subject text NOT NULL,
  message text NOT NULL DEFAULT '',
  frequency text NOT NULL CHECK (frequency IN ('hourly','daily','weekly','monthly','after_refresh')),
  cron_expr text,
  timezone text NOT NULL DEFAULT 'UTC',
  include_link boolean NOT NULL DEFAULT true,
  include_preview boolean NOT NULL DEFAULT false,
  attachment_format text CHECK (attachment_format IS NULL OR attachment_format IN ('pdf')),
  filter_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  parameter_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','invalid')),
  next_run timestamptz,
  last_run timestamptz,
  last_status text,
  last_error text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subscription_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.report_subscriptions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subscription_id,email)
);

CREATE TABLE IF NOT EXISTS public.subscription_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.report_subscriptions(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('schedule','after_refresh','test')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','delivering','succeeded','partial','failed')),
  render_status text,
  delivery_status text,
  recipients_total integer NOT NULL DEFAULT 0,
  recipients_sent integer NOT NULL DEFAULT 0,
  error_message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subscription_id,scheduled_for,trigger_type)
);

CREATE TABLE IF NOT EXISTS public.alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  report_id text NOT NULL REFERENCES public.published_reports(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  measure_name text NOT NULL,
  visual_id text,
  operator text NOT NULL CHECK (operator IN ('gt','gte','lt','lte','eq','neq')),
  threshold numeric NOT NULL,
  filter_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  channels text[] NOT NULL DEFAULT ARRAY['in_app','email']::text[],
  evaluation_mode text NOT NULL DEFAULT 'after_refresh' CHECK (evaluation_mode IN ('after_refresh','interval')),
  evaluation_minutes integer NOT NULL DEFAULT 60 CHECK (evaluation_minutes BETWEEN 5 AND 10080),
  cooldown_minutes integer NOT NULL DEFAULT 60 CHECK (cooldown_minutes BETWEEN 0 AND 43200),
  repeat_enabled boolean NOT NULL DEFAULT false,
  recovery_enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','invalid')),
  current_state text NOT NULL DEFAULT 'normal' CHECK (current_state IN ('normal','triggered','sustained','recovered','error')),
  current_value numeric,
  last_evaluated_at timestamptz,
  last_triggered_at timestamptz,
  last_notified_at timestamptz,
  last_error text,
  next_evaluation_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  state_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.alert_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_rule_id uuid NOT NULL REFERENCES public.alert_rules(id) ON DELETE CASCADE,
  value numeric,
  previous_state text,
  new_state text NOT NULL,
  condition_met boolean,
  error_message text,
  data_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_rule_id uuid NOT NULL REFERENCES public.alert_rules(id) ON DELETE CASCADE,
  evaluation_id uuid REFERENCES public.alert_evaluations(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('triggered','repeated','recovered','error')),
  value numeric,
  threshold numeric,
  notification_id uuid REFERENCES public.notifications(id) ON DELETE SET NULL,
  delivery_status text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_owner ON public.report_subscriptions(owner_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON public.report_subscriptions(status,next_run);
CREATE INDEX IF NOT EXISTS idx_subscription_executions_time ON public.subscription_executions(subscription_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_rules_owner ON public.alert_rules(owner_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_rules_due ON public.alert_rules(status,next_evaluation_at);
CREATE INDEX IF NOT EXISTS idx_alert_evaluations_time ON public.alert_evaluations(alert_rule_id,evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_time ON public.alert_events(alert_rule_id,created_at DESC);

ALTER TABLE public.report_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners manage subscriptions" ON public.report_subscriptions;
CREATE POLICY "Owners manage subscriptions" ON public.report_subscriptions FOR ALL TO authenticated
  USING (owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=report_subscriptions.workspace_id AND wm.user_id=auth.uid() AND wm.role='Admin'))
  WITH CHECK (owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=report_subscriptions.workspace_id AND wm.user_id=auth.uid() AND wm.role='Admin'));
DROP POLICY IF EXISTS "Managers see subscription recipients" ON public.subscription_recipients;
CREATE POLICY "Managers see subscription recipients" ON public.subscription_recipients FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.report_subscriptions s WHERE s.id=subscription_id AND (s.owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=s.workspace_id AND wm.user_id=auth.uid() AND wm.role='Admin'))));
DROP POLICY IF EXISTS "Managers see subscription executions" ON public.subscription_executions;
CREATE POLICY "Managers see subscription executions" ON public.subscription_executions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.report_subscriptions s WHERE s.id=subscription_id AND (s.owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=s.workspace_id AND wm.user_id=auth.uid() AND wm.role='Admin'))));
DROP POLICY IF EXISTS "Owners manage alerts" ON public.alert_rules;
CREATE POLICY "Owners manage alerts" ON public.alert_rules FOR ALL TO authenticated
  USING (owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=alert_rules.workspace_id AND wm.user_id=auth.uid() AND wm.role='Admin'))
  WITH CHECK (owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=alert_rules.workspace_id AND wm.user_id=auth.uid() AND wm.role='Admin'));
DROP POLICY IF EXISTS "Managers see alert evaluations" ON public.alert_evaluations;
CREATE POLICY "Managers see alert evaluations" ON public.alert_evaluations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.alert_rules a WHERE a.id=alert_rule_id AND (a.owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=a.workspace_id AND wm.user_id=auth.uid() AND wm.role='Admin'))));
DROP POLICY IF EXISTS "Managers see alert events" ON public.alert_events;
CREATE POLICY "Managers see alert events" ON public.alert_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.alert_rules a WHERE a.id=alert_rule_id AND (a.owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=a.workspace_id AND wm.user_id=auth.uid() AND wm.role='Admin'))));

CREATE OR REPLACE FUNCTION public.claim_vtab_subscriptions(p_worker_id text,p_limit integer DEFAULT 5)
RETURNS SETOF public.report_subscriptions LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN RETURN QUERY WITH due AS (
  SELECT id FROM public.report_subscriptions WHERE status='active' AND next_run IS NOT NULL AND next_run<=now()
    AND (locked_at IS NULL OR locked_at<now()-interval '30 minutes') ORDER BY next_run FOR UPDATE SKIP LOCKED LIMIT GREATEST(1,LEAST(p_limit,20))
) UPDATE public.report_subscriptions s SET locked_at=now(),locked_by=p_worker_id,updated_at=now() FROM due WHERE s.id=due.id RETURNING s.*; END $$;

CREATE OR REPLACE FUNCTION public.claim_vtab_alerts(p_worker_id text,p_limit integer DEFAULT 10)
RETURNS SETOF public.alert_rules LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN RETURN QUERY WITH due AS (
  SELECT id FROM public.alert_rules WHERE status='active' AND next_evaluation_at IS NOT NULL AND next_evaluation_at<=now()
    AND (locked_at IS NULL OR locked_at<now()-interval '20 minutes') ORDER BY next_evaluation_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(1,LEAST(p_limit,50))
) UPDATE public.alert_rules a SET locked_at=now(),locked_by=p_worker_id,updated_at=now() FROM due WHERE a.id=due.id RETURNING a.*; END $$;

REVOKE ALL ON FUNCTION public.claim_vtab_subscriptions(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_vtab_alerts(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_vtab_subscriptions(text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_vtab_alerts(text,integer) TO service_role;

