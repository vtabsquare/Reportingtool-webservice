-- ============================================================
-- VTAB Reporting Studio — Secure Sharing RPC
-- Run this once in your Supabase SQL Editor.
-- ============================================================

-- This function allows Co-Owners to share reports by email address
-- without exposing the global auth.users table to the public internet
-- or requiring the Python backend to hold dangerous admin keys.

CREATE OR REPLACE FUNCTION share_report_by_email(
    p_report_id TEXT,
    p_target_email TEXT,
    p_role TEXT,
    p_granter_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER -- Runs with elevated admin privileges (bypasses RLS internally)
AS $$
DECLARE
    v_granter_role TEXT;
    v_target_user_id UUID;
    v_granter_id UUID;
    v_target_email TEXT;
BEGIN
    v_granter_id := COALESCE(auth.uid(), p_granter_id);
    v_target_email := lower(trim(p_target_email));

    IF v_target_email IS NULL OR length(v_target_email) = 0 THEN
        RETURN jsonb_build_object('error', 'Enter a registered user email address.');
    END IF;

    -- 1. Validate role input
    IF p_role NOT IN ('Viewer', 'Co-Owner') THEN
        RETURN jsonb_build_object('error', 'Role must be Viewer or Co-Owner');
    END IF;

    -- 2. Verify granter is allowed to share this report (must be Owner or Co-Owner)
    SELECT role INTO v_granter_role
    FROM public.report_access_grants
    WHERE report_id = p_report_id AND user_id = v_granter_id;

    IF v_granter_role IS NULL OR v_granter_role NOT IN ('Owner', 'Co-Owner') THEN
        RETURN jsonb_build_object('error', 'Only Co-Owners and Owners can share this report.');
    END IF;

    -- 3. Lookup the target user UUID by their email address from auth.users
    -- (This table is normally hidden from everyone except the admin/service_role)
    SELECT id INTO v_target_user_id
    FROM auth.users
    WHERE lower(email) = v_target_email
    LIMIT 1;

    IF v_target_user_id IS NULL THEN
        RETURN jsonb_build_object('error', 'Only registered workspace users can be shared this report. Ask ' || v_target_email || ' to create an account or sign in first.');
    END IF;

    -- 4. Upsert the grant
    INSERT INTO public.report_access_grants (report_id, user_id, role, granted_at)
    VALUES (p_report_id, v_target_user_id, p_role, NOW())
    ON CONFLICT (report_id, user_id) 
    DO UPDATE SET role = EXCLUDED.role;

    RETURN jsonb_build_object('ok', true, 'email', v_target_email, 'role', p_role);
END;
$$;

CREATE OR REPLACE FUNCTION list_report_shares(
    p_report_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid UUID;
    v_role TEXT;
    v_shares JSONB;
BEGIN
    v_uid := auth.uid();

    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('error', 'Please sign in to view sharing details.');
    END IF;

    SELECT role INTO v_role
    FROM public.report_access_grants
    WHERE report_id = p_report_id AND user_id = v_uid;

    IF v_role IS NULL OR v_role NOT IN ('Owner', 'Co-Owner') THEN
        RETURN jsonb_build_object('error', 'Only Owners and Co-Owners can view sharing details.');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('email', lower(u.email), 'role', g.role, 'granted_at', g.granted_at) ORDER BY g.granted_at DESC), '[]'::jsonb)
    INTO v_shares
    FROM public.report_access_grants g
    JOIN auth.users u ON u.id = g.user_id
    WHERE g.report_id = p_report_id
      AND g.user_id <> v_uid;

    RETURN jsonb_build_object('ok', true, 'shares', v_shares);
END;
$$;

CREATE OR REPLACE FUNCTION publish_report_for_user(
    p_report_id TEXT,
    p_name TEXT,
    p_project_json TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid UUID;
    v_existing BOOLEAN;
    v_role TEXT;
BEGIN
    v_uid := auth.uid();

    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('error', 'Please sign in before publishing.');
    END IF;

    IF p_report_id IS NULL OR length(trim(p_report_id)) = 0 THEN
        RETURN jsonb_build_object('error', 'Report id is required.');
    END IF;

    IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
        RETURN jsonb_build_object('error', 'Report name is required.');
    END IF;

    IF p_project_json IS NULL OR length(trim(p_project_json)) = 0 THEN
        RETURN jsonb_build_object('error', 'Report payload is required.');
    END IF;

    SELECT EXISTS(SELECT 1 FROM public.published_reports WHERE id = p_report_id) INTO v_existing;

    IF v_existing THEN
        SELECT role INTO v_role
        FROM public.report_access_grants
        WHERE report_id = p_report_id AND user_id = v_uid;

        IF v_role IS NULL OR v_role NOT IN ('Owner', 'Co-Owner') THEN
            RETURN jsonb_build_object('error', 'Only Owners and Co-Owners can update this published report.');
        END IF;
    END IF;

    INSERT INTO public.published_reports (id, name, project_json, published_at, updated_at)
    VALUES (p_report_id, trim(p_name), p_project_json, NOW(), NOW())
    ON CONFLICT (id)
    DO UPDATE SET
        name = EXCLUDED.name,
        project_json = EXCLUDED.project_json,
        updated_at = NOW();

    INSERT INTO public.report_access_grants (report_id, user_id, role, granted_at)
    VALUES (p_report_id, v_uid, 'Owner', NOW())
    ON CONFLICT (report_id, user_id)
    DO UPDATE SET
        role = CASE
            WHEN public.report_access_grants.role = 'Owner' THEN 'Owner'
            ELSE public.report_access_grants.role
        END;

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_report_id,
        'name', trim(p_name),
        'published_at', NOW()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION share_report_by_email(TEXT, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION list_report_shares(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION publish_report_for_user(TEXT, TEXT, TEXT) TO authenticated;
