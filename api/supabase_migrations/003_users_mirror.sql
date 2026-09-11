-- ============================================================
-- Migration 003: vtab_users mirror table
-- Run this in: Supabase Dashboard -> SQL Editor
-- ============================================================

-- 1. Public mirror table for registered users
CREATE TABLE IF NOT EXISTS public.vtab_users (
  id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        text NOT NULL,
  display_name text,
  avatar_url   text,
  created_at   timestamptz DEFAULT now()
);

-- Index for fast email prefix search
CREATE INDEX IF NOT EXISTS idx_vtab_users_email ON public.vtab_users (email text_pattern_ops);

-- 2. Row-Level Security
ALTER TABLE public.vtab_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can search users" ON public.vtab_users;
CREATE POLICY "Authenticated users can search users"
  ON public.vtab_users FOR SELECT
  TO authenticated
  USING (true);

-- 3. Trigger function: sync new auth.users -> vtab_users
CREATE OR REPLACE FUNCTION public.sync_vtab_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.vtab_users (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, public.vtab_users.display_name),
        avatar_url = COALESCE(EXCLUDED.avatar_url, public.vtab_users.avatar_url);
  RETURN NEW;
END;
$$;

-- 4. Attach trigger to auth.users
DROP TRIGGER IF EXISTS trg_sync_vtab_user ON auth.users;
CREATE TRIGGER trg_sync_vtab_user
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_vtab_user();

-- 5. Backfill existing users
INSERT INTO public.vtab_users (id, email, display_name, avatar_url)
SELECT
  id,
  email,
  COALESCE(raw_user_meta_data->>'display_name', raw_user_meta_data->>'full_name', split_part(email, '@', 1)),
  raw_user_meta_data->>'avatar_url'
FROM auth.users
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      display_name = COALESCE(EXCLUDED.display_name, public.vtab_users.display_name);
