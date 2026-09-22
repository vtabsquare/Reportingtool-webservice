-- VTAB Services 5.2.2: first-class semantic model assets.
-- Apply after 008_refresh_runtime.sql.
--
-- Publishing remains one atomic operation. The function below creates/updates
-- the report and its connected semantic model in the background. Existing
-- reports are backfilled and continue to use their current identifiers.

ALTER TABLE public.semantic_models ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE public.semantic_models ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.semantic_models ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Active';
ALTER TABLE public.semantic_models ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.semantic_models ADD COLUMN IF NOT EXISTS current_version_id uuid;

ALTER TABLE public.published_reports ADD COLUMN IF NOT EXISTS semantic_model_id uuid
  REFERENCES public.semantic_models(id) ON DELETE SET NULL;

-- Keep report deletion compatible with the legacy semantic_models.report_id
-- cascade. Avoid a circular CASCADE/RESTRICT dependency.
ALTER TABLE public.published_reports DROP CONSTRAINT IF EXISTS published_reports_semantic_model_id_fkey;
ALTER TABLE public.published_reports ADD CONSTRAINT published_reports_semantic_model_id_fkey
  FOREIGN KEY (semantic_model_id) REFERENCES public.semantic_models(id) ON DELETE SET NULL;

UPDATE public.semantic_models sm
SET owner_id = COALESCE(sm.owner_id, sm.created_by)
WHERE sm.owner_id IS NULL;

UPDATE public.published_reports pr
SET semantic_model_id = sm.id
FROM public.semantic_models sm
WHERE sm.report_id = pr.id AND pr.semantic_model_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_semantic_models_workspace
  ON public.semantic_models(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_semantic_model
  ON public.published_reports(semantic_model_id);

CREATE TABLE IF NOT EXISTS public.semantic_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semantic_model_id uuid NOT NULL REFERENCES public.semantic_models(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_description text NOT NULL DEFAULT '',
  published_by uuid NOT NULL REFERENCES auth.users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semantic_model_id, version_number)
);

DO $$ BEGIN
  ALTER TABLE public.semantic_models
    ADD CONSTRAINT semantic_models_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES public.semantic_model_versions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.restore_vtab_report_version(p_report_id text, p_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_uid uuid := auth.uid(); v_role text; v_definition jsonb; v_model_definition jsonb;
  v_version integer; v_model_id uuid; v_workspace_id uuid; v_org_id uuid;
  v_model_version integer; v_model_version_id uuid;
BEGIN
  SELECT wm.role, r.semantic_model_id, r.workspace_id, r.organization_id
    INTO v_role, v_model_id, v_workspace_id, v_org_id
  FROM published_reports r
  JOIN workspace_members wm ON wm.workspace_id = r.workspace_id
  WHERE r.id = p_report_id AND wm.user_id = v_uid;
  IF v_role NOT IN ('Admin', 'Member', 'Contributor') THEN RETURN jsonb_build_object('error', 'Restore permission denied.'); END IF;
  SELECT report_definition, semantic_model, version_number
    INTO v_definition, v_model_definition, v_version
  FROM report_versions WHERE id = p_version_id AND report_id = p_report_id;
  IF v_definition IS NULL THEN RETURN jsonb_build_object('error', 'Report version not found.'); END IF;

  UPDATE published_reports SET project_json = v_definition::text,
    current_version_id = p_version_id, updated_at = now() WHERE id = p_report_id;
  UPDATE report_versions SET status = 'Restored' WHERE id = p_version_id;

  IF v_model_id IS NOT NULL AND v_model_definition IS NOT NULL THEN
    UPDATE semantic_models SET definition = v_model_definition, updated_at = now() WHERE id = v_model_id;
    SELECT COALESCE(max(version_number), 0) + 1 INTO v_model_version
      FROM semantic_model_versions WHERE semantic_model_id = v_model_id;
    INSERT INTO semantic_model_versions(semantic_model_id, organization_id, workspace_id,
      version_number, definition, metadata, change_description, published_by)
    VALUES (v_model_id, v_org_id, v_workspace_id, v_model_version, v_model_definition,
      jsonb_build_object('restoredFromReportVersionId', p_version_id),
      'Restored with report version 1.' || (v_version - 1)::text, v_uid)
    RETURNING id INTO v_model_version_id;
    UPDATE semantic_models SET current_version_id = v_model_version_id WHERE id = v_model_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'report_id', p_report_id, 'version_id', p_version_id,
    'version', '1.' || (v_version - 1)::text, 'semantic_model_id', v_model_id,
    'semantic_model_version_id', v_model_version_id, 'restored_at', now());
END $$;

CREATE INDEX IF NOT EXISTS idx_semantic_model_versions_model
  ON public.semantic_model_versions(semantic_model_id, version_number DESC);

ALTER TABLE public.semantic_model_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members see semantic model versions" ON public.semantic_model_versions;
CREATE POLICY "Workspace members see semantic model versions"
ON public.semantic_model_versions FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = semantic_model_versions.workspace_id
      AND wm.user_id = auth.uid()
  )
);

-- Refresh remains compatible with report-based jobs while making ownership
-- explicit. The report id is retained as the snapshot target for 5.2.x.
ALTER TABLE public.scheduled_jobs ADD COLUMN IF NOT EXISTS semantic_model_id uuid
  REFERENCES public.semantic_models(id) ON DELETE CASCADE;
ALTER TABLE public.refresh_runs ADD COLUMN IF NOT EXISTS semantic_model_id uuid
  REFERENCES public.semantic_models(id) ON DELETE CASCADE;

UPDATE public.scheduled_jobs sj
SET semantic_model_id = pr.semantic_model_id
FROM public.published_reports pr
WHERE pr.id = sj.report_id AND sj.semantic_model_id IS NULL;

UPDATE public.refresh_runs rr
SET semantic_model_id = pr.semantic_model_id
FROM public.published_reports pr
WHERE pr.id = rr.report_id AND rr.semantic_model_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_semantic_model
  ON public.scheduled_jobs(semantic_model_id);
CREATE INDEX IF NOT EXISTS idx_refresh_runs_semantic_model_time
  ON public.refresh_runs(semantic_model_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.update_vtab_semantic_model_metadata(
  p_semantic_model_id uuid, p_name text, p_description text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_model public.semantic_models;
BEGIN
  SELECT sm INTO v_model FROM semantic_models sm WHERE sm.id = p_semantic_model_id;
  IF v_model.id IS NULL THEN RETURN jsonb_build_object('error', 'Semantic model was not found or access was denied.'); END IF;
  SELECT wm.role INTO v_role FROM workspace_members wm
  WHERE wm.workspace_id = v_model.workspace_id AND wm.user_id = v_uid;
  IF v_role IS NULL THEN RETURN jsonb_build_object('error', 'Semantic model was not found or access was denied.'); END IF;
  IF v_role NOT IN ('Admin', 'Member', 'Contributor') THEN
    RETURN jsonb_build_object('error', 'Your workspace role does not include semantic model management permission.');
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN RETURN jsonb_build_object('error', 'Semantic model name is required.'); END IF;
  UPDATE semantic_models SET name = trim(p_name), description = COALESCE(trim(p_description), ''), updated_at = now()
  WHERE id = p_semantic_model_id;
  RETURN jsonb_build_object('ok', true, 'semantic_model_id', p_semantic_model_id);
END $$;

REVOKE ALL ON FUNCTION public.update_vtab_semantic_model_metadata(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_vtab_semantic_model_metadata(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.publish_vtab_report(
  p_workspace_id uuid, p_report_id text, p_report_name text, p_project_json jsonb,
  p_semantic_model jsonb, p_metadata jsonb, p_desktop_version text,
  p_schema_version text, p_change_description text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_uid uuid := auth.uid(); v_role text; v_org_id uuid; v_report_id text;
  v_version_number integer; v_version_id uuid; v_existing boolean; v_existing_workspace uuid;
  v_semantic_model_id uuid; v_model_version_number integer; v_model_version_id uuid;
  v_model_name text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'Authentication required.'); END IF;
  SELECT wm.role, w.organization_id INTO v_role, v_org_id FROM workspace_members wm
  JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.workspace_id = p_workspace_id AND wm.user_id = v_uid;
  IF v_role IS NULL THEN RETURN jsonb_build_object('error', 'You are not a member of this workspace.'); END IF;
  IF v_role NOT IN ('Admin', 'Member', 'Contributor') THEN RETURN jsonb_build_object('error', 'Your workspace role does not include publish permission.'); END IF;
  IF p_schema_version <> '1.0' THEN RETURN jsonb_build_object('error', 'Unsupported report schema version: ' || p_schema_version); END IF;
  IF p_report_name IS NULL OR length(trim(p_report_name)) = 0 THEN RETURN jsonb_build_object('error', 'Report name is required.'); END IF;
  IF p_project_json IS NULL OR jsonb_typeof(p_project_json) <> 'object' THEN RETURN jsonb_build_object('error', 'Invalid report definition.'); END IF;

  v_report_id := COALESCE(NULLIF(trim(p_report_id), ''), gen_random_uuid()::text);
  SELECT EXISTS(SELECT 1 FROM published_reports WHERE id = v_report_id) INTO v_existing;
  SELECT workspace_id, semantic_model_id INTO v_existing_workspace, v_semantic_model_id
    FROM published_reports WHERE id = v_report_id;
  IF v_existing_workspace IS NOT NULL AND v_existing_workspace <> p_workspace_id THEN
    RETURN jsonb_build_object('error', 'This report belongs to a different workspace. Duplicate it before publishing here.');
  END IF;
  IF v_existing AND v_existing_workspace IS NULL AND NOT EXISTS (
    SELECT 1 FROM report_access_grants WHERE report_id = v_report_id AND user_id = v_uid AND role = 'Owner'
  ) THEN
    RETURN jsonb_build_object('error', 'Only the existing report owner can move this legacy report into a workspace.');
  END IF;

  -- Recover the connected model for installations upgraded from 5.2.1.
  IF v_semantic_model_id IS NULL THEN
    SELECT id INTO v_semantic_model_id FROM semantic_models WHERE report_id = v_report_id LIMIT 1;
  END IF;
  v_model_name := trim(p_report_name) || ' Semantic Model';

  INSERT INTO published_reports(id, name, project_json, organization_id, workspace_id, owner_id,
    desktop_version, report_schema_version, published_by, published_at, updated_at)
  VALUES (v_report_id, trim(p_report_name), p_project_json::text, v_org_id, p_workspace_id, v_uid,
    p_desktop_version, p_schema_version, v_uid, now(), now())
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, project_json = EXCLUDED.project_json,
    organization_id = COALESCE(published_reports.organization_id, EXCLUDED.organization_id),
    workspace_id = COALESCE(published_reports.workspace_id, EXCLUDED.workspace_id),
    owner_id = COALESCE(published_reports.owner_id, EXCLUDED.owner_id),
    desktop_version = EXCLUDED.desktop_version, report_schema_version = EXCLUDED.report_schema_version,
    published_by = EXCLUDED.published_by, updated_at = now();

  IF v_semantic_model_id IS NULL THEN
    INSERT INTO semantic_models(organization_id, workspace_id, report_id, name, definition,
      schema_version, created_by, owner_id, metadata)
    VALUES (v_org_id, p_workspace_id, v_report_id, v_model_name,
      COALESCE(p_semantic_model, '{}'::jsonb), p_schema_version, v_uid, v_uid,
      COALESCE(p_metadata, '{}'::jsonb))
    RETURNING id INTO v_semantic_model_id;
  ELSE
    UPDATE semantic_models SET name = v_model_name,
      definition = COALESCE(p_semantic_model, '{}'::jsonb),
      schema_version = p_schema_version, workspace_id = p_workspace_id,
      organization_id = v_org_id, owner_id = COALESCE(owner_id, v_uid),
      metadata = COALESCE(p_metadata, '{}'::jsonb), status = 'Active', updated_at = now()
    WHERE id = v_semantic_model_id;
  END IF;

  UPDATE published_reports SET semantic_model_id = v_semantic_model_id WHERE id = v_report_id;

  SELECT COALESCE(max(version_number), 0) + 1 INTO v_model_version_number
    FROM semantic_model_versions WHERE semantic_model_id = v_semantic_model_id;
  INSERT INTO semantic_model_versions(semantic_model_id, organization_id, workspace_id,
    version_number, definition, metadata, change_description, published_by)
  VALUES (v_semantic_model_id, v_org_id, p_workspace_id, v_model_version_number,
    COALESCE(p_semantic_model, '{}'::jsonb), COALESCE(p_metadata, '{}'::jsonb),
    COALESCE(p_change_description, ''), v_uid)
  RETURNING id INTO v_model_version_id;
  UPDATE semantic_models SET current_version_id = v_model_version_id WHERE id = v_semantic_model_id;

  SELECT COALESCE(max(version_number), 0) + 1 INTO v_version_number FROM report_versions WHERE report_id = v_report_id;
  INSERT INTO report_versions(organization_id, workspace_id, report_id, version_number, report_definition,
    semantic_model, metadata, desktop_version, report_schema_version, change_description, published_by)
  VALUES (v_org_id, p_workspace_id, v_report_id, v_version_number, p_project_json,
    COALESCE(p_semantic_model, '{}'::jsonb), COALESCE(p_metadata, '{}'::jsonb), p_desktop_version,
    p_schema_version, COALESCE(p_change_description, ''), v_uid) RETURNING id INTO v_version_id;
  UPDATE published_reports SET current_version_id = v_version_id WHERE id = v_report_id;

  INSERT INTO workspace_reports(workspace_id, report_id) VALUES (p_workspace_id, v_report_id) ON CONFLICT DO NOTHING;
  INSERT INTO report_access_grants(report_id, user_id, role) VALUES (v_report_id, v_uid, 'Owner')
    ON CONFLICT (report_id, user_id) DO UPDATE SET role = 'Owner';
  INSERT INTO report_access_grants(report_id, user_id, role)
    SELECT v_report_id, wm.user_id, CASE WHEN wm.user_id = v_uid THEN 'Owner' WHEN wm.role = 'Viewer' THEN 'Viewer' ELSE 'Co-Owner' END
    FROM workspace_members wm WHERE wm.workspace_id = p_workspace_id
    ON CONFLICT (report_id, user_id) DO UPDATE SET role = CASE
      WHEN report_access_grants.role = 'Owner' THEN 'Owner' ELSE EXCLUDED.role END;
  INSERT INTO audit_logs(organization_id, workspace_id, actor_id, action, object_type, object_id, details)
    VALUES (v_org_id, p_workspace_id, v_uid, 'report.publish', 'report', v_report_id,
      jsonb_build_object('version', v_version_number, 'semanticModelId', v_semantic_model_id,
        'semanticModelVersion', v_model_version_number, 'desktopVersion', p_desktop_version,
        'schemaVersion', p_schema_version));
  INSERT INTO notifications(organization_id, user_id, event_type, title, message, object_type, object_id)
    VALUES (v_org_id, v_uid, 'ReportPublished', 'Report and semantic model published',
      trim(p_report_name) || ' and its semantic model were published successfully.', 'report', v_report_id);
  RETURN jsonb_build_object('report_id', v_report_id, 'workspace_id', p_workspace_id,
    'version_id', v_version_id, 'version', '1.' || (v_version_number - 1)::text,
    'semantic_model_id', v_semantic_model_id, 'semantic_model_name', v_model_name,
    'semantic_model_version_id', v_model_version_id,
    'semantic_model_version', '1.' || (v_model_version_number - 1)::text,
    'published_at', now());
END $$;

REVOKE ALL ON FUNCTION public.publish_vtab_report(uuid, text, text, jsonb, jsonb, jsonb, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_vtab_report(uuid, text, text, jsonb, jsonb, jsonb, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.restore_vtab_report_version(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_vtab_report_version(text, uuid) TO authenticated;
