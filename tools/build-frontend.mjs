import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load root .env so VITE_SUPABASE_* vars are available at build time.
// Vite only auto-loads .env when using the CLI (vite build), not when calling
// build() programmatically — so we do it manually here.
function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const result = {};
  for (const raw of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eqIdx = line.indexOf('=');
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) result[key] = val;
  }
  return result;
}

const rootEnv = parseDotEnv(resolve(process.cwd(), '.env'));
// desktop.env is the single Desktop configuration used by both the compiled
// interface and the packaged local backend. The example file must never be
// compiled because its non-empty placeholders look like a valid Supabase setup.
const desktopEnv = parseDotEnv(resolve(process.cwd(), 'desktop.env'));
const processViteEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')));
const env = { ...rootEnv, ...desktopEnv, ...processViteEnv };
const packageMetadata = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
env.VITE_APP_VERSION ||= String(packageMetadata.version || '');

// Build Vite define object for all VITE_* keys found in the .env
const define = {};
for (const [k, v] of Object.entries(env)) {
  if (k.startsWith('VITE_')) {
    define[`import.meta.env.${k}`] = JSON.stringify(v);
  }
}

await build({
  configFile: false,
  root: process.cwd(),
  plugins: [react()],
  define,
  build: {
    outDir: 'dist-web',
    emptyOutDir: true
  }
});
