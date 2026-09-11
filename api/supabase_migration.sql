-- ============================================================
-- VTAB Reporting Studio - Supabase Cloud Migration
-- Run this once in your Supabase SQL Editor.
-- ============================================================

-- 1. Published reports table
CREATE TABLE IF NOT EXISTS published_reports (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    project_json  TEXT NOT NULL,
    published_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Access grants table (Viewer / Co-Owner / Owner per user per report)
CREATE TABLE IF NOT EXISTS report_access_grants (
    report_id  TEXT NOT NULL REFERENCES published_reports(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL,
    role       TEXT NOT NULL DEFAULT 'Viewer'
                   CHECK (role IN ('Viewer', 'Co-Owner', 'Owner')),
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (report_id, user_id)
);

-- 3. Row Level Security
ALTER TABLE report_access_grants ENABLE ROW LEVEL SECURITY;

-- Users can read their own grants
CREATE POLICY "Users see own grants"
    ON report_access_grants FOR SELECT
    USING (auth.uid() = user_id);

-- Service role (Python backend) can insert/upsert grants (auto-grant Owner on publish)
CREATE POLICY "Service role manages grants"
    ON report_access_grants FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

ALTER TABLE published_reports ENABLE ROW LEVEL SECURITY;

-- Users can only read reports they have been granted access to
CREATE POLICY "Users see accessible reports"
    ON published_reports FOR SELECT
    USING (
        id IN (
            SELECT report_id FROM report_access_grants
            WHERE user_id = auth.uid()
        )
    );

-- Service role can insert/update published reports (desktop publish flow)
CREATE POLICY "Service role manages reports"
    ON published_reports FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- 4. Storage bucket for heavy analytical data
-- Run this in Supabase Dashboard > Storage > New Bucket
-- Name: vtab-reports, Public: OFF

-- ============================================================
-- SUPABASE DASHBOARD SETTINGS (do this manually):
--
-- Authentication > Providers > Email:
--   Turn OFF "Confirm email" for internal/dev use so users can
--   log in immediately after registering without email confirmation.
--   Leave ON for production and configure your email template.
-- ============================================================

-- ============================================================
-- PART 2: Workspaces (Team report folders)
-- Run this AFTER the above tables exist.
-- ============================================================

-- 5. Workspaces (named team folders of shared reports)
CREATE TABLE IF NOT EXISTS workspaces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    created_by  UUID NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Workspace members
CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL,
    role         TEXT NOT NULL DEFAULT 'Member'
                     CHECK (role IN ('Admin', 'Member')),
    added_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

-- 7. Reports shared into workspaces
CREATE TABLE IF NOT EXISTS workspace_reports (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    report_id    TEXT NOT NULL REFERENCES published_reports(id) ON DELETE CASCADE,
    shared_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (workspace_id, report_id)
);

-- RLS for workspaces
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own workspaces"
    ON workspaces FOR SELECT
    USING (
        id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
        OR created_by = auth.uid()
    );

CREATE POLICY "Service role manages workspaces"
    ON workspaces FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- RLS for workspace_members
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see members of their workspaces"
    ON workspace_members FOR SELECT
    USING (
        workspace_id IN (
            SELECT workspace_id FROM workspace_members wm WHERE wm.user_id = auth.uid()
        )
    );

CREATE POLICY "Service role manages workspace members"
    ON workspace_members FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- RLS for workspace_reports
ALTER TABLE workspace_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see reports in their workspaces"
    ON workspace_reports FOR SELECT
    USING (
        workspace_id IN (
            SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Service role manages workspace reports"
    ON workspace_reports FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- 8. RPC: Share a report to all members of a workspace
CREATE OR REPLACE FUNCTION share_report_to_workspace(
    p_report_id TEXT,
    p_workspace_id UUID,
    p_granter_id UUID,
    p_role TEXT DEFAULT 'Viewer'
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_member RECORD;
    v_count INT := 0;
BEGIN
    -- Verify granter is Admin of workspace
    IF NOT EXISTS (
        SELECT 1 FROM workspace_members
        WHERE workspace_id = p_workspace_id AND user_id = p_granter_id AND role = 'Admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM workspaces WHERE id = p_workspace_id AND created_by = p_granter_id
    ) THEN
        RETURN json_build_object('error', 'Only workspace Admins can share reports into a workspace.');
    END IF;

    -- Add report to workspace_reports junction
    INSERT INTO workspace_reports (workspace_id, report_id)
    VALUES (p_workspace_id, p_report_id)
    ON CONFLICT DO NOTHING;

    -- Grant access to all workspace members
    FOR v_member IN SELECT user_id FROM workspace_members WHERE workspace_id = p_workspace_id
    LOOP
        INSERT INTO report_access_grants (report_id, user_id, role)
        VALUES (p_report_id, v_member.user_id, p_role)
        ON CONFLICT (report_id, user_id) DO NOTHING;
        v_count := v_count + 1;
    END LOOP;

    RETURN json_build_object('ok', true, 'members_granted', v_count);
END;
$$;
