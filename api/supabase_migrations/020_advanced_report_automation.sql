-- VTAB Services advanced report automation platform.
-- Non-destructive upgrade; apply after 018_subscriptions_and_alerts.sql.

CREATE TABLE IF NOT EXISTS public.automation_workspace_policies (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscriptions_enabled boolean NOT NULL DEFAULT true,
  scheduled_delivery_enabled boolean NOT NULL DEFAULT true,
  alerts_enabled boolean NOT NULL DEFAULT true,
  workflows_enabled boolean NOT NULL DEFAULT true,
  templates_enabled boolean NOT NULL DEFAULT true,
  external_recipients_enabled boolean NOT NULL DEFAULT false,
  member_manage_own boolean NOT NULL DEFAULT true,
  member_run_now boolean NOT NULL DEFAULT false,
  allowed_formats text[] NOT NULL DEFAULT ARRAY['link','pdf','snapshot']::text[],
  max_recipients integer NOT NULL DEFAULT 25 CHECK (max_recipients BETWEEN 1 AND 500),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.report_subscriptions DROP CONSTRAINT IF EXISTS report_subscriptions_frequency_check;
ALTER TABLE public.report_subscriptions DROP CONSTRAINT IF EXISTS report_subscriptions_attachment_format_check;
ALTER TABLE public.report_subscriptions ADD COLUMN IF NOT EXISTS schedule_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.report_subscriptions ADD COLUMN IF NOT EXISTS delivery_options jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.report_subscriptions ADD COLUMN IF NOT EXISTS email_template_id uuid;
ALTER TABLE public.report_subscriptions ADD COLUMN IF NOT EXISTS end_at timestamptz;
ALTER TABLE public.report_subscriptions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.report_subscriptions ADD CONSTRAINT report_subscriptions_frequency_check CHECK (frequency IN ('once','hourly','daily','weekly','monthly','yearly','custom','after_refresh'));
ALTER TABLE public.report_subscriptions ADD CONSTRAINT report_subscriptions_attachment_format_check CHECK (attachment_format IS NULL OR attachment_format IN ('pdf','snapshot','xlsx','csv','paginated_pdf'));
ALTER TABLE public.subscription_executions DROP CONSTRAINT IF EXISTS subscription_executions_trigger_type_check;
ALTER TABLE public.subscription_executions ADD CONSTRAINT subscription_executions_trigger_type_check CHECK (trigger_type IN ('schedule','after_refresh','test','workflow','manual'));

ALTER TABLE public.subscription_recipients ADD COLUMN IF NOT EXISTS recipient_type text NOT NULL DEFAULT 'user';
ALTER TABLE public.subscription_recipients ADD COLUMN IF NOT EXISTS delivery_role text NOT NULL DEFAULT 'to';
ALTER TABLE public.subscription_recipients ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE public.subscription_recipients ADD COLUMN IF NOT EXISTS filter_context jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.subscription_recipients ADD COLUMN IF NOT EXISTS parameter_context jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.subscription_recipients ADD COLUMN IF NOT EXISTS authorization_status text NOT NULL DEFAULT 'verified';
ALTER TABLE public.subscription_recipients DROP CONSTRAINT IF EXISTS subscription_recipients_delivery_role_check;
ALTER TABLE public.subscription_recipients ADD CONSTRAINT subscription_recipients_delivery_role_check CHECK (delivery_role IN ('to','cc','bcc'));

ALTER TABLE public.alert_rules DROP CONSTRAINT IF EXISTS alert_rules_operator_check;
ALTER TABLE public.alert_rules ADD COLUMN IF NOT EXISTS threshold_secondary numeric;
ALTER TABLE public.alert_rules ADD COLUMN IF NOT EXISTS comparison_measure text;
ALTER TABLE public.alert_rules ADD COLUMN IF NOT EXISTS condition_group jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.alert_rules ADD COLUMN IF NOT EXISTS trigger_policy text NOT NULL DEFAULT 'state_change';
ALTER TABLE public.alert_rules ADD COLUMN IF NOT EXISTS notify_recovery boolean NOT NULL DEFAULT true;
ALTER TABLE public.alert_rules ADD COLUMN IF NOT EXISTS previous_value numeric;
ALTER TABLE public.alert_rules ADD CONSTRAINT alert_rules_operator_check CHECK (operator IN ('gt','gte','lt','lte','eq','neq','between','outside','increase_pct','decrease_pct','changed'));

CREATE TABLE IF NOT EXISTS public.automation_email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  subject text NOT NULL,
  html_body text NOT NULL DEFAULT '',
  text_body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_id text REFERENCES public.published_reports(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  trigger jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','invalid')),
  timezone text NOT NULL DEFAULT 'UTC',
  cron_expr text,
  next_run timestamptz,
  last_run timestamptz,
  last_status text,
  last_error text,
  version integer NOT NULL DEFAULT 1,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_workflow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.automation_workflows(id) ON DELETE CASCADE,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,version)
);

CREATE TABLE IF NOT EXISTS public.automation_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES public.automation_workflows(id) ON DELETE SET NULL,
  report_id text REFERENCES public.published_reports(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trigger_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled','dead_letter')),
  idempotency_key text NOT NULL UNIQUE,
  definition_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_step integer NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  retry_after timestamptz,
  error_message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES public.automation_executions(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  step_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE(execution_id,step_index)
);

CREATE TABLE IF NOT EXISTS public.automation_delivery_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES public.automation_executions(id) ON DELETE CASCADE,
  subscription_execution_id uuid REFERENCES public.subscription_executions(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  delivery_role text NOT NULL DEFAULT 'to',
  format text,
  status text NOT NULL DEFAULT 'queued',
  provider_message_id text,
  error_message text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_workflows_due ON public.automation_workflows(status,next_run);
CREATE INDEX IF NOT EXISTS idx_automation_executions_workspace ON public.automation_executions(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_audit_workspace ON public.automation_audit_log(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_deliveries_execution ON public.automation_delivery_records(execution_id,created_at DESC);

ALTER TABLE public.automation_workspace_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_execution_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_delivery_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members read automation policy" ON public.automation_workspace_policies;
CREATE POLICY "Workspace members read automation policy" ON public.automation_workspace_policies FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id=workspace_id AND COALESCE(w.owner_id,w.created_by)=auth.uid()) OR
  EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=workspace_id AND wm.user_id=auth.uid())
);
DROP POLICY IF EXISTS "Workspace owners manage automation policy" ON public.automation_workspace_policies;
CREATE POLICY "Workspace owners manage automation policy" ON public.automation_workspace_policies FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id=workspace_id AND COALESCE(w.owner_id,w.created_by)=auth.uid())
) WITH CHECK (EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id=workspace_id AND COALESCE(w.owner_id,w.created_by)=auth.uid()));

DROP POLICY IF EXISTS "Workspace members read automation workflows" ON public.automation_workflows;
CREATE POLICY "Workspace members read automation workflows" ON public.automation_workflows FOR SELECT TO authenticated USING (
  owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=workspace_id AND wm.user_id=auth.uid())
);
DROP POLICY IF EXISTS "Automation managers write workflows" ON public.automation_workflows;
CREATE POLICY "Automation managers write workflows" ON public.automation_workflows FOR ALL TO authenticated USING (
  owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=workspace_id AND wm.user_id=auth.uid() AND lower(wm.role) IN ('admin','co-owner'))
) WITH CHECK (owner_id=auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=workspace_id AND wm.user_id=auth.uid() AND lower(wm.role) IN ('admin','co-owner')));

DROP POLICY IF EXISTS "Workspace members read automation executions" ON public.automation_executions;
CREATE POLICY "Workspace members read automation executions" ON public.automation_executions FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=workspace_id AND wm.user_id=auth.uid()) OR
  EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id=workspace_id AND COALESCE(w.owner_id,w.created_by)=auth.uid())
);

CREATE OR REPLACE FUNCTION public.claim_vtab_automation_executions(p_worker_id text,p_limit integer DEFAULT 5)
RETURNS SETOF public.automation_executions LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN RETURN QUERY WITH due AS (
  SELECT id FROM public.automation_executions WHERE status='queued' AND (retry_after IS NULL OR retry_after<=now())
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(1,LEAST(p_limit,20))
) UPDATE public.automation_executions e SET status='running',started_at=COALESCE(started_at,now()),attempt_count=attempt_count+1
FROM due WHERE e.id=due.id RETURNING e.*; END $$;
REVOKE ALL ON FUNCTION public.claim_vtab_automation_executions(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_vtab_automation_executions(text,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_vtab_automation_workflows(p_worker_id text,p_limit integer DEFAULT 5)
RETURNS SETOF public.automation_workflows LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN RETURN QUERY WITH due AS (
  SELECT id FROM public.automation_workflows WHERE status='active' AND next_run IS NOT NULL AND next_run<=now()
  AND (locked_at IS NULL OR locked_at<now()-interval '30 minutes')
  ORDER BY next_run FOR UPDATE SKIP LOCKED LIMIT GREATEST(1,LEAST(p_limit,20))
) UPDATE public.automation_workflows w SET locked_at=now(),locked_by=p_worker_id,updated_at=now()
FROM due WHERE w.id=due.id RETURNING w.*; END $$;
REVOKE ALL ON FUNCTION public.claim_vtab_automation_workflows(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_vtab_automation_workflows(text,integer) TO service_role;
