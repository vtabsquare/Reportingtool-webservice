-- Semantic-model data access runtime. Apply after 009_semantic_model_assets.sql.
-- Credentials are encrypted by the API before they reach these tables.

CREATE TABLE IF NOT EXISTS public.semantic_model_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semantic_model_id uuid NOT NULL REFERENCES public.semantic_models(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_type text NOT NULL,
  connection_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  credentials_enc text NOT NULL,
  table_mappings jsonb NOT NULL DEFAULT '[]'::jsonb,
  gateway_id uuid,
  status text NOT NULL DEFAULT 'not_configured' CHECK (status IN ('connected','not_configured','connection_error')),
  last_tested_at timestamptz,
  last_error text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semantic_model_id, name)
);

CREATE TABLE IF NOT EXISTS public.vtab_gateways (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'not_configured' CHECK (status IN ('online','offline','unavailable','not_configured','connection_error')),
  last_heartbeat timestamptz,
  version text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

ALTER TABLE public.semantic_model_connections
  DROP CONSTRAINT IF EXISTS semantic_model_connections_gateway_id_fkey;
ALTER TABLE public.semantic_model_connections
  ADD CONSTRAINT semantic_model_connections_gateway_id_fkey
  FOREIGN KEY (gateway_id) REFERENCES public.vtab_gateways(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.semantic_model_parameters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semantic_model_id uuid NOT NULL REFERENCES public.semantic_models(id) ON DELETE CASCADE,
  name text NOT NULL,
  data_type text NOT NULL DEFAULT 'Text',
  current_value jsonb,
  default_value jsonb,
  allowed_values jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semantic_model_id, name)
);

ALTER TABLE public.scheduled_jobs DROP CONSTRAINT IF EXISTS scheduled_jobs_source_type_check;
ALTER TABLE public.scheduled_jobs ADD CONSTRAINT scheduled_jobs_source_type_check CHECK (
  source_type IN ('semantic_model','google_sheets','postgresql','postgres','redshift','sqlserver','synapse','fabric_warehouse','mysql','mariadb')
);
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 3;
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS retry_interval_minutes integer NOT NULL DEFAULT 5;
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS timeout_minutes integer NOT NULL DEFAULT 30;

ALTER TABLE public.semantic_model_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vtab_gateways ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.semantic_model_parameters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members see semantic connections" ON public.semantic_model_connections;
CREATE POLICY "Workspace members see semantic connections" ON public.semantic_model_connections FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = semantic_model_connections.workspace_id AND wm.user_id = auth.uid())
);
DROP POLICY IF EXISTS "Workspace members see gateways" ON public.vtab_gateways;
CREATE POLICY "Workspace members see gateways" ON public.vtab_gateways FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = vtab_gateways.workspace_id AND wm.user_id = auth.uid())
);
DROP POLICY IF EXISTS "Workspace members see parameters" ON public.semantic_model_parameters;
CREATE POLICY "Workspace members see parameters" ON public.semantic_model_parameters FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.semantic_models sm
    JOIN public.workspace_members wm ON wm.workspace_id = sm.workspace_id
    WHERE sm.id = semantic_model_parameters.semantic_model_id AND wm.user_id = auth.uid()
  )
);

GRANT SELECT ON public.semantic_model_connections, public.vtab_gateways, public.semantic_model_parameters TO authenticated;
GRANT ALL ON public.semantic_model_connections, public.vtab_gateways, public.semantic_model_parameters TO service_role;
