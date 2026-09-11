-- VTAB Reporting Service foundation
-- Apply after supabase_migration.sql and supabase_rpc.sql.
-- Adds organizations, four workspace roles, immutable report versions,
-- semantic-model metadata, tenant-aware publishing, notifications and audit.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.organization_members (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('Owner', 'Admin', 'Member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id);
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE public.workspaces SET owner_id = created_by WHERE owner_id IS NULL;

ALTER TABLE public.workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE public.workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('Admin', 'Member', 'Contributor', 'Viewer'));

ALTER TABLE public.published_reports ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.published_reports ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.published_reports ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id);
ALTER TABLE public.published_reports ADD COLUMN IF NOT EXISTS current_version_id uuid;
ALTER TABLE public.published_reports ADD COLUMN IF NOT EXISTS desktop_version text;
ALTER TABLE public.published_reports ADD COLUMN IF NOT EXISTS report_schema_version text NOT NULL DEFAULT '1.0';
ALTER TABLE public.published_reports ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES auth.users(id);

CREATE TABLE IF NOT EXISTS public.semantic_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  report_id text NOT NULL UNIQUE REFERENCES public.published_reports(id) ON DELETE CASCADE,
  name text NOT NULL,
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version text NOT NULL DEFAULT '1.0',
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  report_id text NOT NULL REFERENCES public.published_reports(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  report_definition jsonb NOT NULL,
  semantic_model jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  desktop_version text,
  report_schema_version text NOT NULL DEFAULT '1.0',
  change_description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Published' CHECK (status IN ('Published', 'Restored', 'Archived')),
  published_by uuid NOT NULL REFERENCES auth.users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, version_number)
);

DO $$ BEGIN
  ALTER TABLE public.published_reports
    ADD CONSTRAINT published_reports_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES public.report_versions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  result text NOT NULL DEFAULT 'Success',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  object_type text,
  object_id text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_org ON public.workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON public.workspace_members(user_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_reports_workspace ON public.published_reports(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_versions_report ON public.report_versions(report_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON public.audit_logs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_time ON public.notifications(user_id, created_at DESC);

-- Private analytical snapshots. Object names are: user_id/report_id/file.parquet
INSERT INTO storage.buckets(id, name, public, file_size_limit)
VALUES ('vtab-reports', 'vtab-reports', false, 524288000)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "Authors upload private report snapshots" ON storage.objects;
CREATE POLICY "Authors upload private report snapshots" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'vtab-reports' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "Authors update private report snapshots" ON storage.objects;
CREATE POLICY "Authors update private report snapshots" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'vtab-reports' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'vtab-reports' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "Workspace members read private report snapshots" ON storage.objects;
CREATE POLICY "Workspace members read private report snapshots" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'vtab-reports' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM public.published_reports pr
      JOIN public.workspace_members wm ON wm.workspace_id = pr.workspace_id
      WHERE pr.id = (storage.foldername(name))[2] AND wm.user_id = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS "Authors delete private report snapshots" ON storage.objects;
CREATE POLICY "Authors delete private report snapshots" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'vtab-reports' AND (storage.foldername(name))[1] = auth.uid()::text);

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.semantic_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members see organizations" ON public.organizations;
CREATE POLICY "Members see organizations" ON public.organizations FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = id AND om.user_id = auth.uid()));

DROP POLICY IF EXISTS "Members see organization memberships" ON public.organization_members;
CREATE POLICY "Members see organization memberships" ON public.organization_members FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Workspace members see semantic models" ON public.semantic_models;
CREATE POLICY "Workspace members see semantic models" ON public.semantic_models FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = semantic_models.workspace_id AND wm.user_id = auth.uid()));

DROP POLICY IF EXISTS "Workspace members see report versions" ON public.report_versions;
CREATE POLICY "Workspace members see report versions" ON public.report_versions FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = report_versions.workspace_id AND wm.user_id = auth.uid()));

DROP POLICY IF EXISTS "Admins see audit" ON public.audit_logs;
CREATE POLICY "Admins see audit" ON public.audit_logs FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = audit_logs.workspace_id AND wm.user_id = auth.uid() AND wm.role = 'Admin'));

DROP POLICY IF EXISTS "Users see notifications" ON public.notifications;
CREATE POLICY "Users see notifications" ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users update notifications" ON public.notifications;
CREATE POLICY "Users update notifications" ON public.notifications FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users see accessible reports" ON public.published_reports;
CREATE POLICY "Users see accessible reports" ON public.published_reports FOR SELECT TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.report_access_grants rag WHERE rag.report_id = id AND rag.user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = published_reports.workspace_id AND wm.user_id = auth.uid())
);

CREATE OR REPLACE FUNCTION public.ensure_vtab_personal_workspace()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_org_id uuid;
  v_workspace_id uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'Authentication required.'); END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  SELECT organization_id INTO v_org_id FROM organization_members WHERE user_id = v_uid ORDER BY created_at LIMIT 1;
  IF v_org_id IS NULL THEN
    INSERT INTO organizations(name, slug, created_by)
    VALUES (COALESCE(split_part(v_email, '@', 1), 'My') || '''s Organization', 'org-' || replace(v_uid::text, '-', ''), v_uid)
    RETURNING id INTO v_org_id;
    INSERT INTO organization_members(organization_id, user_id, role) VALUES (v_org_id, v_uid, 'Owner');
  END IF;
  SELECT w.id INTO v_workspace_id FROM workspaces w
  JOIN workspace_members wm ON wm.workspace_id = w.id
  WHERE w.organization_id = v_org_id AND wm.user_id = v_uid AND w.name = 'My Workspace' LIMIT 1;
  IF v_workspace_id IS NULL THEN
    INSERT INTO workspaces(name, description, created_by, owner_id, organization_id)
    VALUES ('My Workspace', 'Personal workspace', v_uid, v_uid, v_org_id) RETURNING id INTO v_workspace_id;
    INSERT INTO workspace_members(workspace_id, user_id, role) VALUES (v_workspace_id, v_uid, 'Admin');
  END IF;
  RETURN jsonb_build_object('organization_id', v_org_id, 'workspace_id', v_workspace_id);
END $$;

CREATE OR REPLACE FUNCTION public.get_vtab_publish_context()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_uid uuid := auth.uid(); v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'Authentication required.'); END IF;
  PERFORM ensure_vtab_personal_workspace();
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', w.id, 'name', w.name, 'description', w.description,
    'organizationId', w.organization_id, 'role', wm.role,
    'canPublish', wm.role IN ('Admin', 'Member', 'Contributor')
  ) ORDER BY CASE WHEN w.name = 'My Workspace' THEN 0 ELSE 1 END, lower(w.name)), '[]'::jsonb)
  INTO v_result FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id
  WHERE wm.user_id = v_uid;
  RETURN jsonb_build_object('workspaces', v_result);
END $$;

CREATE OR REPLACE FUNCTION public.publish_vtab_report(
  p_workspace_id uuid, p_report_id text, p_report_name text, p_project_json jsonb,
  p_semantic_model jsonb, p_metadata jsonb, p_desktop_version text,
  p_schema_version text, p_change_description text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_uid uuid := auth.uid(); v_role text; v_org_id uuid; v_report_id text;
  v_version_number integer; v_version_id uuid; v_existing boolean; v_existing_workspace uuid;
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
  SELECT workspace_id INTO v_existing_workspace FROM published_reports WHERE id = v_report_id;
  IF v_existing_workspace IS NOT NULL AND v_existing_workspace <> p_workspace_id THEN
    RETURN jsonb_build_object('error', 'This report belongs to a different workspace. Duplicate it before publishing here.');
  END IF;
  IF v_existing AND v_existing_workspace IS NULL AND NOT EXISTS (
    SELECT 1 FROM report_access_grants WHERE report_id = v_report_id AND user_id = v_uid AND role = 'Owner'
  ) THEN
    RETURN jsonb_build_object('error', 'Only the existing report owner can move this legacy report into a workspace.');
  END IF;

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

  SELECT COALESCE(max(version_number), 0) + 1 INTO v_version_number FROM report_versions WHERE report_id = v_report_id;
  INSERT INTO report_versions(organization_id, workspace_id, report_id, version_number, report_definition,
    semantic_model, metadata, desktop_version, report_schema_version, change_description, published_by)
  VALUES (v_org_id, p_workspace_id, v_report_id, v_version_number, p_project_json,
    COALESCE(p_semantic_model, '{}'::jsonb), COALESCE(p_metadata, '{}'::jsonb), p_desktop_version,
    p_schema_version, COALESCE(p_change_description, ''), v_uid) RETURNING id INTO v_version_id;

  UPDATE published_reports SET current_version_id = v_version_id WHERE id = v_report_id;
  INSERT INTO semantic_models(organization_id, workspace_id, report_id, name, definition, schema_version, created_by)
  VALUES (v_org_id, p_workspace_id, v_report_id, trim(p_report_name) || ' Semantic Model',
    COALESCE(p_semantic_model, '{}'::jsonb), p_schema_version, v_uid)
  ON CONFLICT (report_id) DO UPDATE SET name = EXCLUDED.name, definition = EXCLUDED.definition,
    schema_version = EXCLUDED.schema_version, updated_at = now();
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
      jsonb_build_object('version', v_version_number, 'desktopVersion', p_desktop_version, 'schemaVersion', p_schema_version));
  INSERT INTO notifications(organization_id, user_id, event_type, title, message, object_type, object_id)
    VALUES (v_org_id, v_uid, 'ReportPublished', 'Report published', trim(p_report_name) || ' was published successfully.', 'report', v_report_id);
  RETURN jsonb_build_object('report_id', v_report_id, 'workspace_id', p_workspace_id,
    'version_id', v_version_id, 'version', '1.' || (v_version_number - 1)::text, 'published_at', now());
END $$;

CREATE OR REPLACE FUNCTION public.list_vtab_report_versions(p_report_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_uid uuid := auth.uid(); v_versions jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM published_reports r JOIN workspace_members wm ON wm.workspace_id = r.workspace_id
    WHERE r.id = p_report_id AND wm.user_id = v_uid) THEN RETURN jsonb_build_object('error', 'Report access denied.'); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rv.id, 'version', '1.' || (rv.version_number - 1)::text,
    'publishedAt', rv.published_at, 'publishedBy', u.email, 'changeDescription', rv.change_description,
    'status', rv.status) ORDER BY rv.version_number DESC), '[]'::jsonb)
  INTO v_versions FROM report_versions rv LEFT JOIN auth.users u ON u.id = rv.published_by WHERE rv.report_id = p_report_id;
  RETURN jsonb_build_object('versions', v_versions);
END $$;

CREATE OR REPLACE FUNCTION public.restore_vtab_report_version(p_report_id text, p_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_definition jsonb; v_version integer;
BEGIN
  SELECT wm.role INTO v_role FROM published_reports r JOIN workspace_members wm ON wm.workspace_id = r.workspace_id
    WHERE r.id = p_report_id AND wm.user_id = v_uid;
  IF v_role NOT IN ('Admin', 'Member', 'Contributor') THEN RETURN jsonb_build_object('error', 'Restore permission denied.'); END IF;
  SELECT report_definition, version_number INTO v_definition, v_version FROM report_versions
    WHERE id = p_version_id AND report_id = p_report_id;
  IF v_definition IS NULL THEN RETURN jsonb_build_object('error', 'Report version not found.'); END IF;
  UPDATE published_reports SET project_json = v_definition::text, current_version_id = p_version_id, updated_at = now() WHERE id = p_report_id;
  UPDATE report_versions SET status = 'Restored' WHERE id = p_version_id;
  RETURN jsonb_build_object('ok', true, 'report_id', p_report_id, 'version_id', p_version_id,
    'version', '1.' || (v_version - 1)::text, 'restored_at', now());
END $$;

REVOKE ALL ON FUNCTION public.ensure_vtab_personal_workspace() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_vtab_publish_context() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.publish_vtab_report(uuid, text, text, jsonb, jsonb, jsonb, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_vtab_report_versions(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_vtab_report_version(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_vtab_personal_workspace() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_vtab_publish_context() TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_vtab_report(uuid, text, text, jsonb, jsonb, jsonb, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_vtab_report_versions(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_vtab_report_version(text, uuid) TO authenticated;
