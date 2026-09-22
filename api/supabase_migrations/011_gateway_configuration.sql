-- VTAB Services gateway configuration and semantic-model mapping.
-- Apply after 010_semantic_model_runtime.sql.

ALTER TABLE public.vtab_gateways
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'service_network';
ALTER TABLE public.vtab_gateways
  ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.vtab_gateways
  ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE public.vtab_gateways
  ADD COLUMN IF NOT EXISTS allow_cloud_sources boolean NOT NULL DEFAULT false;

ALTER TABLE public.vtab_gateways
  DROP CONSTRAINT IF EXISTS vtab_gateways_execution_mode_check;
ALTER TABLE public.vtab_gateways
  ADD CONSTRAINT vtab_gateways_execution_mode_check
  CHECK (execution_mode IN ('service_network','on_premises_agent'));

-- Existing gateway records were only placeholders. Keep them offline until an
-- administrator explicitly saves the cluster in the new settings experience.
UPDATE public.vtab_gateways
SET status = 'offline'
WHERE execution_mode = 'on_premises_agent' AND status = 'not_configured';

-- A semantic-model connection is the reusable connection/mapping unit. These
-- fields capture the Power BI-style configuration without exposing credentials.
ALTER TABLE public.semantic_model_connections
  ADD COLUMN IF NOT EXISTS authentication_method text NOT NULL DEFAULT 'database';
ALTER TABLE public.semantic_model_connections
  ADD COLUMN IF NOT EXISTS privacy_level text NOT NULL DEFAULT 'organizational';
ALTER TABLE public.semantic_model_connections
  ADD COLUMN IF NOT EXISTS encrypted_transport boolean NOT NULL DEFAULT true;

ALTER TABLE public.semantic_model_connections
  DROP CONSTRAINT IF EXISTS semantic_model_connections_authentication_method_check;
ALTER TABLE public.semantic_model_connections
  ADD CONSTRAINT semantic_model_connections_authentication_method_check
  CHECK (authentication_method IN ('database','basic','windows','anonymous','api_key','oauth2'));

ALTER TABLE public.semantic_model_connections
  DROP CONSTRAINT IF EXISTS semantic_model_connections_privacy_level_check;
ALTER TABLE public.semantic_model_connections
  ADD CONSTRAINT semantic_model_connections_privacy_level_check
  CHECK (privacy_level IN ('private','organizational','public'));

CREATE INDEX IF NOT EXISTS idx_semantic_model_connections_gateway
  ON public.semantic_model_connections(gateway_id);

-- Reuse the shared updated_at trigger created by the scheduler migration.
DROP TRIGGER IF EXISTS trg_vtab_gateways_updated_at ON public.vtab_gateways;
CREATE TRIGGER trg_vtab_gateways_updated_at
  BEFORE UPDATE ON public.vtab_gateways
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_semantic_model_connections_updated_at ON public.semantic_model_connections;
CREATE TRIGGER trg_semantic_model_connections_updated_at
  BEFORE UPDATE ON public.semantic_model_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
