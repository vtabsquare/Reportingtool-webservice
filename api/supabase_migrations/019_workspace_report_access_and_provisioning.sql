-- VTAB Services: reliable personal provisioning + workspace/report access scopes
-- Apply after 016_private_and_team_workspaces.sql.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS is_personal boolean NOT NULL DEFAULT false;

UPDATE public.workspaces
SET is_personal = true
WHERE lower(trim(name)) = 'my workspace';

CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_workspace_per_owner
  ON public.workspaces(created_by)
  WHERE is_personal;

-- Internal idempotent implementation usable from both signup and signed-in RPC.
CREATE OR REPLACE FUNCTION public.provision_vtab_personal_workspace(
  p_user_id uuid,
  p_email text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_org_id uuid;
  v_workspace_id uuid;
  v_name text := COALESCE(NULLIF(split_part(COALESCE(p_email, ''), '@', 1), ''), 'My');
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'User id is required.');
  END IF;

  SELECT organization_id INTO v_org_id
  FROM public.organization_members
  WHERE user_id = p_user_id
  ORDER BY created_at
  LIMIT 1;

  IF v_org_id IS NULL THEN
    SELECT id INTO v_org_id
    FROM public.organizations
    WHERE created_by = p_user_id
    ORDER BY created_at
    LIMIT 1;
  END IF;

  IF v_org_id IS NULL THEN
    INSERT INTO public.organizations(name, slug, created_by)
    VALUES (v_name || '''s Organization', 'org-' || replace(p_user_id::text, '-', ''), p_user_id)
    ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
    RETURNING id INTO v_org_id;
  END IF;

  INSERT INTO public.organization_members(organization_id, user_id, role)
  VALUES (v_org_id, p_user_id, 'Owner')
  ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'Owner';

  SELECT id INTO v_workspace_id
  FROM public.workspaces
  WHERE created_by = p_user_id AND is_personal
  LIMIT 1;

  IF v_workspace_id IS NULL THEN
    -- Upgrade a legacy My Workspace instead of creating a duplicate.
    SELECT id INTO v_workspace_id
    FROM public.workspaces
    WHERE created_by = p_user_id AND lower(trim(name)) = 'my workspace'
    LIMIT 1;
  END IF;

  IF v_workspace_id IS NULL THEN
    INSERT INTO public.workspaces(
      name, description, created_by, owner_id, organization_id, is_personal
    ) VALUES (
      'My Workspace', 'Private workspace', p_user_id, p_user_id, v_org_id, true
    )
    RETURNING id INTO v_workspace_id;
  ELSE
    UPDATE public.workspaces
    SET is_personal = true,
        owner_id = COALESCE(owner_id, p_user_id),
        organization_id = COALESCE(organization_id, v_org_id)
    WHERE id = v_workspace_id;
  END IF;

  INSERT INTO public.workspace_members(workspace_id, user_id, role)
  VALUES (v_workspace_id, p_user_id, 'Admin')
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'Admin';

  RETURN jsonb_build_object('organization_id', v_org_id, 'workspace_id', v_workspace_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_vtab_personal_workspace()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Authentication required.');
  END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  RETURN public.provision_vtab_personal_workspace(v_uid, v_email);
END;
$$;

-- Provision immediately for future users. A guarded trigger never blocks account
-- creation; the Services API performs the same idempotent repair at first login.
CREATE OR REPLACE FUNCTION public.on_vtab_auth_user_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  PERFORM public.provision_vtab_personal_workspace(NEW.id, NEW.email);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'VTAB personal workspace provisioning deferred for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vtab_personal_workspace_on_signup ON auth.users;
CREATE TRIGGER trg_vtab_personal_workspace_on_signup
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.on_vtab_auth_user_created();

-- Backfill every existing account. Safe to rerun.
DO $$
DECLARE account record;
BEGIN
  FOR account IN SELECT id, email FROM auth.users LOOP
    PERFORM public.provision_vtab_personal_workspace(account.id, account.email);
  END LOOP;
END;
$$;

-- RLS helper: a direct report grant exposes only the workspace shell; it does
-- not create workspace membership or grant access to sibling reports.
CREATE OR REPLACE FUNCTION public.has_vtab_workspace_shell_access(
  p_workspace_id uuid,
  p_user_id uuid DEFAULT auth.uid()
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspaces w
    WHERE w.id = p_workspace_id AND w.created_by = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = p_workspace_id AND wm.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.published_reports r
    JOIN public.report_access_grants g ON g.report_id = r.id
    WHERE r.workspace_id = p_workspace_id AND g.user_id = p_user_id
  );
$$;

DROP POLICY IF EXISTS "Users see own workspaces" ON public.workspaces;
CREATE POLICY "Users see own workspaces"
ON public.workspaces FOR SELECT TO authenticated
USING (public.has_vtab_workspace_shell_access(id, auth.uid()));

DROP POLICY IF EXISTS "Users see accessible reports" ON public.published_reports;
CREATE POLICY "Users see accessible reports"
ON public.published_reports FOR SELECT TO authenticated
USING (
  owner_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = published_reports.workspace_id
      AND wm.user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.report_access_grants rag
    WHERE rag.report_id = published_reports.id
      AND rag.user_id = auth.uid()
  )
);

GRANT EXECUTE ON FUNCTION public.ensure_vtab_personal_workspace() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_vtab_workspace_shell_access(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.has_vtab_workspace_shell_access(uuid, uuid) IS
  'Workspace shell visibility from ownership, membership, or at least one direct report grant. Report rows remain separately protected.';
