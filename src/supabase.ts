import { createClient } from '@supabase/supabase-js';

const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string || '').trim();
const rawAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string || '').trim();
const hasPlaceholder = (value: string) => /YOUR_|CHANGE_ME/i.test(value);
const SUPABASE_URL = rawUrl.startsWith('https://') && !hasPlaceholder(rawUrl) ? rawUrl.replace(/\/+$/, '') : '';
const SUPABASE_ANON_KEY = rawAnonKey.length >= 40 && !hasPlaceholder(rawAnonKey) ? rawAnonKey : '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[VTAB] Supabase env vars not set. Cloud features will be disabled.');
}

export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export const isSupabaseConfigured = !!supabase;
