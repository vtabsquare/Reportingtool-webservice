# VTAB Reporting Service — Supabase, Web Tool, and EXE guide

Follow the sections in order. Values shown as `YOUR_...` are placeholders.

## 1. Create the Supabase project

1. Sign in at `https://supabase.com` and select **New project**.
2. Choose the organization, project name, database password, and nearest region.
3. Wait until the project status is healthy.
4. Open **Project Settings → API** and record:
   - Project URL — safe for Desktop/Web.
   - `anon`/publishable key — safe for Desktop/Web when RLS is enabled.
   - `service_role`/secret key — server only. Never paste it into `desktop.env.example`, `web.env.example`, Vercel, the browser, source control, or the EXE.

## 2. Configure authentication

1. Open **Authentication → Providers → Email** and enable Email/Password.
2. For initial private testing, email confirmation may be disabled. Enable it before a public production launch.
3. Open **Authentication → URL Configuration**.
4. Set **Site URL** to the future Web Tool address, for example `https://reports.example.com`.
5. Add redirect URLs for the same production address and your local test URL, for example `http://localhost:5173/**`.
6. Configure SMTP before testing password-reset emails. Keep SMTP credentials in Supabase/backend settings only.

## 3. Create the database and security policies

Open **SQL Editor → New query**. Run these files one at a time and in this exact order:

1. `api/supabase_migration.sql`
2. `api/supabase_rpc.sql`
3. `api/supabase_migrations/003_users_mirror.sql`
4. `api/supabase_migrations/004_scheduler.sql`
5. `api/supabase_migrations/005_reporting_service_foundation.sql`

After each script, confirm **Success** before continuing. The last migration creates:

- organizations and organization memberships;
- My Workspace provisioning;
- Admin, Member, Contributor, and Viewer roles;
- immutable report versions and semantic-model records;
- audit and notification foundations;
- the private `vtab-reports` storage bucket;
- authenticated upload/read policies;
- transactional publishing and restore functions.

Verify in **Storage** that `vtab-reports` exists and **Public bucket** is OFF. Do not create or use the old public `vtab_data` bucket for new reports.

## 4. Create the cloud Backend API

Railway, Render, Azure, AWS, or another Python host can run the service. Railway example:

1. Push the clean source to a private Git repository.
2. In Railway choose **New Project → Deploy from GitHub repo**.
3. Set the service root directory to `api`.
4. The included `railway.json` starts `python cloud_backend.py`.
5. Add these server variables using `api/service.env.example` as the checklist:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `VTAB_WEB_URL` — the Web Tool URL
   - `VTAB_ALLOWED_ORIGINS` — the Web Tool origin only, without a trailing slash
6. Deploy and copy the generated HTTPS backend domain.
7. Open `https://YOUR_BACKEND_DOMAIN/api/v1/health`; it must return a healthy JSON response.
8. Never download or distribute the backend environment file.

For Render, create the service from the `api` directory and use the included `render.yaml`. Add the same environment values in the Render dashboard.

## 5. Deploy the Services Web Tool

Vercel example:

1. Create another project from the same repository.
2. Keep the repository root as the project root.
3. Build command: `npm run build:web`.
4. Output directory: `dist-web`.
5. Add the public values listed in `web.env.example`:
   - `VITE_APP_MODE=WORKSPACE_ONLY`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_API_URL=https://YOUR_BACKEND_DOMAIN/api/v1`
   - `VITE_WEB_URL=https://YOUR_WEB_TOOL_DOMAIN`
6. Deploy and copy the final Web Tool URL.
7. Return to the Backend variables and update `VTAB_WEB_URL` and `VTAB_ALLOWED_ORIGINS` with this final URL, then redeploy the backend.
8. Return to Supabase Authentication URL Configuration and update the Site/redirect URLs if Vercel assigned a different domain.
9. Open the Web Tool, register the first user, and sign in. The service creates **My Workspace** automatically when the publish context is first requested.

## 6. Configure and generate the Desktop EXE

1. Open `desktop.env.example` in the Desktop source.
2. Replace all placeholders with:
   - the Supabase Project URL;
   - the Supabase anon/publishable key;
   - the deployed Web Tool URL in both URL fields.
3. Confirm this file does **not** contain `SUPABASE_SERVICE_ROLE_KEY`, database passwords, SMTP keys, or source-system passwords.
4. Run `BUILD_INSTALLER.bat` as the normal user. Allow elevation only when the installer itself requests it.
5. The script builds the Python backend, frontend, and Windows installer.
6. Find the installer under `release` with a name similar to `VTAB Reporting Studio Setup 5.0.8.exe`.
7. Install it on the test PC and start VTAB Reporting Studio.

The installer now includes only `desktop.env.example` renamed to `desktop.env`. It no longer bundles the general `.env` file or the server-only Supabase service-role key.

## 7. End-to-end test

1. Sign in to Desktop with the same Supabase account used for the Web Tool.
2. Open an existing report and verify local editing/save still works.
3. Select **Publish → Publish to Workspace**.
4. Confirm the dialog lists **My Workspace** and any shared workspace where the account is Admin, Member, or Contributor.
5. Choose a workspace, confirm the report name, add a version note, and publish.
6. Confirm the success screen shows workspace, report, and version `1.0`.
7. Open the report in the Services Web Tool.
8. Test every page, chart, table, card, slicer, filter, cross-filter, sort, navigation, full-screen mode, PDF, and PowerPoint export.
9. In Supabase **Storage → vtab-reports**, confirm objects use this layout:
   `USER_ID/REPORT_ID/file.parquet`.
10. Confirm the bucket remains private. Opening a raw object URL in a signed-out private browser must fail.
11. Modify the Desktop report and publish again. Confirm version `1.1` and that version `1.0` remains in `report_versions`.

## 8. Role and security test

Create four test accounts and add one per role:

- **Admin:** publish and manage members/settings.
- **Member:** create/edit/publish with limited management.
- **Contributor:** create/edit/publish, no member administration.
- **Viewer:** view only; publishing must be refused server-side.

Also verify:

1. A user outside the workspace cannot query the report or obtain a signed data URL.
2. Changing a workspace/report ID manually does not bypass access checks.
3. Published JSON contains `credentialRef` where used, but no password, access token, refresh token, API key, or inline credentials.
4. Signing out invalidates further viewer queries until the user signs in again.

## 9. Ongoing Supabase management

- Add/remove users through the Web Tool; use the Supabase Auth user list only for recovery/administration.
- Never manually make `vtab-reports` public.
- Rotate the service-role key immediately if it is ever exposed and update only the cloud Backend variable.
- Enable Supabase database backups before production use.
- Review `audit_logs`, failed authentication, storage growth, and backend health regularly.
- Test SQL migrations in a staging Supabase project before production.
- Treat refresh workers, schedules, retries, notification delivery, organization administration, and full RLS user-to-role mapping as the next service phases described in `REPORTING_SERVICE_IMPLEMENTATION.md`.
