-- VTAB workspace sharing boundary
-- My Workspace is private; collaboration is available only in team workspaces.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS is_personal boolean NOT NULL DEFAULT false;

UPDATE public.workspaces
SET is_personal = true
WHERE lower(trim(name)) = 'my workspace';

CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_workspace_per_owner
  ON public.workspaces(created_by)
  WHERE is_personal;

CREATE OR REPLACE FUNCTION public.enforce_personal_workspace_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid; v_personal boolean;
BEGIN
  SELECT created_by, is_personal INTO v_owner, v_personal
  FROM public.workspaces WHERE id = NEW.workspace_id;
  IF v_personal AND NEW.user_id <> v_owner THEN
    RAISE EXCEPTION 'My Workspace is private and cannot have additional members.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_private_workspace_members ON public.workspace_members;
CREATE TRIGGER trg_private_workspace_members
BEFORE INSERT OR UPDATE ON public.workspace_members
FOR EACH ROW EXECUTE FUNCTION public.enforce_personal_workspace_member();

CREATE OR REPLACE FUNCTION public.enforce_private_report_grant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid; v_personal boolean;
BEGIN
  SELECT r.owner_id, COALESCE(w.is_personal, false)
    INTO v_owner, v_personal
  FROM public.published_reports r
  LEFT JOIN public.workspaces w ON w.id = r.workspace_id
  WHERE r.id = NEW.report_id;
  IF v_personal AND NEW.user_id <> v_owner THEN
    RAISE EXCEPTION 'Reports in My Workspace are private and cannot be shared.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_private_report_grants ON public.report_access_grants;
CREATE TRIGGER trg_private_report_grants
BEFORE INSERT OR UPDATE ON public.report_access_grants
FOR EACH ROW EXECUTE FUNCTION public.enforce_private_report_grant();

-- Remove any legacy non-owner memberships/grants from personal workspaces.
DELETE FROM public.report_access_grants g
USING public.published_reports r, public.workspaces w
WHERE g.report_id = r.id AND r.workspace_id = w.id AND w.is_personal
  AND g.user_id <> r.owner_id;

DELETE FROM public.workspace_members wm
USING public.workspaces w
WHERE wm.workspace_id = w.id AND w.is_personal AND wm.user_id <> w.created_by;

CREATE OR REPLACE FUNCTION public.ensure_vtab_personal_workspace()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_uid uuid := auth.uid(); v_email text; v_org_id uuid; v_workspace_id uuid;
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
  SELECT id INTO v_workspace_id FROM workspaces
  WHERE created_by = v_uid AND is_personal LIMIT 1;
  IF v_workspace_id IS NULL THEN
    INSERT INTO workspaces(name, description, created_by, owner_id, organization_id, is_personal)
    VALUES ('My Workspace', 'Private workspace', v_uid, v_uid, v_org_id, true)
    RETURNING id INTO v_workspace_id;
  END IF;
  INSERT INTO workspace_members(workspace_id, user_id, role)
  VALUES (v_workspace_id, v_uid, 'Admin') ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'Admin';
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
    'canPublish', wm.role IN ('Admin', 'Member', 'Contributor'),
    'isPersonal', w.is_personal
  ) ORDER BY CASE WHEN w.is_personal THEN 0 ELSE 1 END, lower(w.name)), '[]'::jsonb)
  INTO v_result FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id
  WHERE wm.user_id = v_uid;
  RETURN jsonb_build_object('workspaces', v_result);
END $$;

CREATE OR REPLACE FUNCTION public.share_report_by_email(
  p_report_id text, p_target_email text, p_role text, p_granter_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_granter_id uuid := COALESCE(auth.uid(), p_granter_id);
  v_target_email text := lower(trim(p_target_email));
  v_target_user_id uuid; v_granter_role text; v_workspace_role text;
  v_personal boolean; v_owner uuid;
BEGIN
  IF v_granter_id IS NULL THEN RETURN jsonb_build_object('error', 'Authentication required.'); END IF;
  IF v_target_email IS NULL OR length(v_target_email)=0 THEN RETURN jsonb_build_object('error', 'Enter a registered user email address.'); END IF;
  IF p_role NOT IN ('Viewer','Co-Owner') THEN RETURN jsonb_build_object('error', 'Role must be Viewer or Co-Owner.'); END IF;

  SELECT COALESCE(w.is_personal,false), r.owner_id, wm.role
    INTO v_personal, v_owner, v_workspace_role
  FROM published_reports r
  LEFT JOIN workspaces w ON w.id=r.workspace_id
  LEFT JOIN workspace_members wm ON wm.workspace_id=r.workspace_id AND wm.user_id=v_granter_id
  WHERE r.id=p_report_id;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('error', 'Report not found.'); END IF;
  IF v_personal THEN RETURN jsonb_build_object('error', 'Reports in My Workspace are private. Publish the report to a team workspace before sharing.'); END IF;

  SELECT role INTO v_granter_role FROM report_access_grants
  WHERE report_id=p_report_id AND user_id=v_granter_id;
  IF v_granter_id <> v_owner
     AND COALESCE(v_workspace_role,'') NOT IN ('Admin','Member')
     AND COALESCE(v_granter_role,'') NOT IN ('Owner','Co-Owner') THEN
    RETURN jsonb_build_object('error', 'You do not have permission to share this report.');
  END IF;

  SELECT id INTO v_target_user_id FROM auth.users WHERE lower(email)=v_target_email LIMIT 1;
  IF v_target_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'No registered user was found for ' || v_target_email || '. Ask them to sign in first.');
  END IF;
  INSERT INTO report_access_grants(report_id,user_id,role,granted_at)
  VALUES (p_report_id,v_target_user_id,p_role,now())
  ON CONFLICT (report_id,user_id) DO UPDATE SET role=EXCLUDED.role, granted_at=now();
  RETURN jsonb_build_object('ok',true,'email',v_target_email,'role',p_role);
END $$;

GRANT EXECUTE ON FUNCTION public.ensure_vtab_personal_workspace() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_vtab_publish_context() TO authenticated;
GRANT EXECUTE ON FUNCTION public.share_report_by_email(text,text,text,uuid) TO authenticated;
