-- VTAB semantic-model Row-Level Security memberships.
-- Role definitions remain versioned inside semantic_models.definition.security.roles;
-- memberships remain stable when the Desktop model is republished.

CREATE TABLE IF NOT EXISTS public.security_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS public.security_group_members (
  group_id uuid NOT NULL REFERENCES public.security_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.semantic_model_rls_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semantic_model_id uuid NOT NULL REFERENCES public.semantic_models(id) ON DELETE CASCADE,
  role_id text NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user','group')),
  principal_id uuid NOT NULL,
  principal_email text,
  assigned_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(semantic_model_id, role_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_rls_members_user ON public.semantic_model_rls_members(semantic_model_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_security_group_user ON public.security_group_members(user_id, group_id);

ALTER TABLE public.security_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.semantic_model_rls_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members see security groups" ON public.security_groups;
CREATE POLICY "Workspace members see security groups" ON public.security_groups FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=security_groups.workspace_id AND wm.user_id=auth.uid())
);
DROP POLICY IF EXISTS "Workspace managers manage security groups" ON public.security_groups;
CREATE POLICY "Workspace managers manage security groups" ON public.security_groups FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=security_groups.workspace_id AND wm.user_id=auth.uid() AND wm.role IN ('Admin','Member','Contributor'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id=security_groups.workspace_id AND wm.user_id=auth.uid() AND wm.role IN ('Admin','Member','Contributor'))
);

DROP POLICY IF EXISTS "Users see their security group membership" ON public.security_group_members;
CREATE POLICY "Users see their security group membership" ON public.security_group_members FOR SELECT TO authenticated USING (
  user_id=auth.uid() OR EXISTS (SELECT 1 FROM public.security_groups sg JOIN public.workspace_members wm ON wm.workspace_id=sg.workspace_id WHERE sg.id=security_group_members.group_id AND wm.user_id=auth.uid() AND wm.role IN ('Admin','Member','Contributor'))
);

DROP POLICY IF EXISTS "Workspace members see semantic RLS memberships" ON public.semantic_model_rls_members;
CREATE POLICY "Workspace members see semantic RLS memberships" ON public.semantic_model_rls_members FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.semantic_models sm JOIN public.workspace_members wm ON wm.workspace_id=sm.workspace_id WHERE sm.id=semantic_model_rls_members.semantic_model_id AND wm.user_id=auth.uid())
);

-- Backend service-role calls perform managed writes after application permission checks.
GRANT SELECT ON public.security_groups, public.security_group_members, public.semantic_model_rls_members TO authenticated;
GRANT ALL ON public.security_groups, public.security_group_members, public.semantic_model_rls_members TO service_role;
