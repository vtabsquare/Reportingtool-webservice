# Supabase beginner walkthrough for VTAB Reporting Service

This guide starts after you have created a Supabase account and project. Complete one checkpoint at a time.

## Before starting: understand the four different credentials

Supabase shows several credentials. They are not interchangeable.

| Value | Used for | Where it goes |
|---|---|---|
| Project URL | Identifies the Supabase project | Desktop, Web Tool, Backend |
| Publishable key or legacy `anon` key | Safe public application key; RLS still controls access | Desktop, Web Tool, Backend |
| Secret key or legacy `service_role` key | Server administrator access; bypasses RLS | Cloud Backend only |
| Database password / `postgres` username | Direct database tools and connection strings | Not required for the first VTAB setup |

Never place the secret/service-role key in Desktop, Vercel frontend variables, screenshots, chat messages, GitHub, or the EXE.

## Checkpoint 1 — Copy the Project URL and keys

1. Open `https://supabase.com/dashboard`.
2. Select your project.
3. Click the **Connect** button near the top, or open **Project Settings → API Keys**.
4. Copy the **Project URL**. It looks like:
   `https://abcdefghijk.supabase.co`
5. Copy the **Publishable key**, which normally begins with `sb_publishable_`.
   - If your project only shows legacy keys, copy the legacy **anon public** key.
   - Either one can be entered in VTAB's `VITE_SUPABASE_ANON_KEY` field.
6. Under the server-only/secret section, copy the **Secret key** or legacy **service_role** key and store it in a password manager.
7. Do not copy the database password into any VTAB file.

Create a private note like this:

```text
SUPABASE PROJECT URL =
SUPABASE PUBLISHABLE/ANON KEY =
SUPABASE SERVER SECRET/SERVICE_ROLE KEY =
```

Do not send the filled note to anyone.

Checkpoint result: you have three values, and the server secret is stored privately.

## Checkpoint 2 — Run the database scripts

The SQL files are already inside the provided source. You do not type the SQL yourself.

For every file below:

1. In Supabase, open **SQL Editor** from the left menu.
2. Click **New query**.
3. Open the named SQL file from the VTAB source on your computer.
4. Press `Ctrl+A`, then `Ctrl+C` in the SQL file.
5. Paste it into the Supabase query editor.
6. Confirm you pasted only SQL from that one file.
7. Click **Run** in the Supabase editor.
8. Wait for a green success result before moving to the next file.
9. Rename/save the query in Supabase using the number shown below. This makes it easy to remember what was completed.

Run these in this exact order:

### 2.1 Base reporting tables

File: `api/supabase_migration.sql`

Save the Supabase query as: `001 VTAB base cloud schema`

This creates the original published-report, access-grant, workspace, membership, and workspace-report tables.

### 2.2 Secure report functions

File: `api/supabase_rpc.sql`

Save as: `002 VTAB secure report functions`

This creates the original secure publish and sharing functions.

### 2.3 User mirror

File: `api/supabase_migrations/003_users_mirror.sql`

Save as: `003 VTAB users mirror`

This creates `vtab_users` and a trigger that mirrors Supabase Authentication users for safe email lookup.

### 2.4 Scheduler foundation

File: `api/supabase_migrations/004_scheduler.sql`

Save as: `004 VTAB scheduler`

This creates the scheduled-jobs foundation. It does not start a worker yet.

### 2.5 Reporting Service foundation

File: `api/supabase_migrations/005_reporting_service_foundation.sql`

Save as: `005 VTAB Reporting Service`

This creates organizations, four workspace roles, My Workspace provisioning, immutable versions, semantic models, audit logs, notifications, secure publishing functions, and the private `vtab-reports` bucket and policies.

Important:

- If a script succeeds, do not run it repeatedly.
- If a script fails, stop. Copy only the red error message—not any key—and identify the script number.
- Do not run the scripts in reverse order.
- “Success. No rows returned” is a successful result for schema scripts.

Checkpoint result: all five saved SQL queries show successful execution.

## Checkpoint 3 — Verify the new tables

1. Open **Table Editor** from the left menu.
2. Confirm these important tables appear under the `public` schema:

```text
organizations
organization_members
workspaces
workspace_members
workspace_reports
published_reports
report_access_grants
report_versions
semantic_models
vtab_users
scheduled_jobs
audit_logs
notifications
```

Some tables will be empty. That is normal.

If `report_versions`, `semantic_models`, or `organizations` is missing, migration 005 did not finish successfully.

Checkpoint result: the tables exist; you do not need to manually add rows.

## Checkpoint 4 — Verify private Storage

1. Open **Storage** from the left menu.
2. Confirm the bucket `vtab-reports` exists.
3. Open its settings/details.
4. Confirm it is **Private**, not public.
5. Do not upload a test file manually. Desktop will create the correct user/report folders during publishing.
6. If an older `vtab_data` bucket exists and is public, do not use it for new reports. Do not delete it until older reports have been checked.

The private bucket will eventually look like:

```text
vtab-reports
  USER_UUID
    REPORT_ID
      Sales_ab12cd34.parquet
```

Checkpoint result: `vtab-reports` exists and Public bucket is OFF.

## Checkpoint 5 — Configure email/password authentication

1. Open **Authentication**.
2. Open **Providers** or **Sign In / Providers**.
3. Select **Email**.
4. Confirm Email/Password sign-in is enabled.
5. For the first private test, you may temporarily turn off **Confirm email** so test users can sign in immediately.
6. Before production, turn confirmation back on and configure SMTP/email templates.

Now configure temporary URLs:

1. Open **Authentication → URL Configuration**.
2. Until the Web Tool is deployed, set **Site URL** to `http://localhost:4173`.
3. Add this Redirect URL: `http://localhost:4173/**`.
4. Save.

After deployment, you will replace Site URL with the real Web Tool HTTPS URL and add that URL to Redirect URLs.

Checkpoint result: Email provider is enabled and localhost is allowed temporarily.

## Checkpoint 6 — Create the first application user

If you already added an Authentication user, check it here instead of adding it again.

1. Open **Authentication → Users**.
2. Click **Add user**.
3. Choose **Create new user**.
4. Enter an email address you control and a strong test password.
5. If the screen offers **Auto Confirm User**, enable it for this private test.
6. Create the user.
7. Confirm the user appears in the Authentication user list.
8. Open **Table Editor → vtab_users** and confirm the same email was mirrored there.

Do not manually create rows in `organization_members`, `workspace_members`, or `report_access_grants`. The application and database functions create them safely.

Checkpoint result: the user exists in Authentication and `vtab_users`.

## Checkpoint 7 — Configure and deploy the cloud Backend

The Backend is required because the Web Tool must query the semantic model and private Parquet snapshots without depending on the Desktop PC.

Railway steps:

1. Upload the clean source to a private GitHub repository.
2. Open Railway and create **New Project → Deploy from GitHub repo**.
3. Select the repository.
4. Open the new Railway service settings.
5. Set **Root Directory** to `api`.
6. Confirm the start command is `python cloud_backend.py`.
7. Open Railway **Variables** and add:

```text
VITE_SUPABASE_URL = your Supabase Project URL
VITE_SUPABASE_ANON_KEY = your publishable/anon key
SUPABASE_SERVICE_ROLE_KEY = your server secret/service_role key
VTAB_WEB_URL = http://localhost:4173
VTAB_ALLOWED_ORIGINS = http://localhost:4173
```

8. The service-role/secret key belongs only in Railway Variables.
9. Deploy the service.
10. Generate/copy its public HTTPS domain.
11. Test this URL in a browser:
    `https://YOUR-BACKEND-DOMAIN/api/v1/health`
12. A JSON health response means the Backend is running. A normal website page is not expected there.

Checkpoint result: the Backend health URL returns JSON.

## Checkpoint 8 — Deploy the Services Web Tool

Vercel steps:

1. In Vercel click **Add New → Project**.
2. Import the same private GitHub repository.
3. Keep **Root Directory** as the repository root.
4. Set **Build Command** to `npm run build:web`.
5. Set **Output Directory** to `dist-web`.
6. Add these Vercel environment variables:

```text
VITE_APP_MODE = WORKSPACE_ONLY
VITE_SUPABASE_URL = your Supabase Project URL
VITE_SUPABASE_ANON_KEY = your publishable/anon key
VITE_API_URL = https://YOUR-BACKEND-DOMAIN/api/v1
VITE_WEB_URL = https://YOUR-VERCEL-DOMAIN
```

7. Do not add the Supabase server secret/service-role key to Vercel.
8. Deploy and copy the final Vercel HTTPS URL.
9. Go back to Railway and replace:

```text
VTAB_WEB_URL = your final Vercel URL
VTAB_ALLOWED_ORIGINS = your final Vercel origin, without a trailing slash
```

10. Redeploy Railway.
11. Go back to Supabase **Authentication → URL Configuration**.
12. Replace Site URL with the final Vercel URL.
13. Add `https://YOUR-VERCEL-DOMAIN/**` to Redirect URLs.
14. Save.
15. Open the Vercel URL and sign in with the test Authentication user.

Checkpoint result: the VTAB Workspace login page opens and accepts the test user.

## Checkpoint 9 — Configure and build Desktop

1. Extract `VTAB-Desktop-EXE-Ready-5.0.8.zip`.
2. Open `desktop.env.example`.
3. Replace the four placeholder values:

```text
VITE_SUPABASE_URL=your Supabase Project URL
VITE_SUPABASE_ANON_KEY=your publishable/anon key
VITE_WEB_URL=your final Vercel URL
VTAB_WEB_URL=your final Vercel URL
```

4. Confirm the file does not contain the server secret/service-role key.
5. Save it using the same filename: `desktop.env.example`.
6. Run `BUILD_INSTALLER.bat`.
7. Wait for the backend, frontend, and installer steps to complete.
8. Find the installer in the `release` folder.
9. Install and open VTAB Reporting Studio.

Checkpoint result: Desktop opens and can display the Supabase sign-in screen.

## Checkpoint 10 — First end-to-end publish

1. Sign in to Desktop using the same test account.
2. Open an existing working report.
3. Select **Publish**.
4. Click **Publish to Workspace**.
5. The database should automatically create and show **My Workspace**.
6. Select My Workspace, confirm the report name, enter a version note, and publish.
7. Confirm the result shows version `1.0`.
8. Click **Open in Reporting Service**.
9. Confirm the report opens in the Web Tool and test pages, visuals, slicers, filters, and cross-filtering.
10. In Supabase check:
    - `published_reports` contains the report;
    - `report_versions` contains version 1;
    - `semantic_models` contains the model;
    - `audit_logs` contains `report.publish`;
    - Storage contains private Parquet files under the user/report path.

## Common beginner problems

### “relation does not exist”

A prior SQL file was skipped or failed. Check the script order and the first red error.

### “function ... does not exist” or “schema cache”

The RPC or migration 005 script did not run successfully. Run only the missing script, then wait about one minute and retry.

### “Invalid API key”

The key and Project URL may come from different Supabase projects, or whitespace was copied. Copy both again from the same project.

### “Viewer access only”

The account is a Viewer in that workspace. Admin, Member, or Contributor is required to publish.

### “Cannot reach VTAB API”

Check the Railway health URL and Vercel `VITE_API_URL`. It must end in `/api/v1`.

### CORS error in the browser

Set Railway `VTAB_ALLOWED_ORIGINS` to the exact Vercel origin, such as `https://reports-example.vercel.app`, without a trailing slash, then redeploy.

### Report opens but visuals cannot query data

Confirm `vtab-reports` is private, files exist under `USER_UUID/REPORT_ID`, the user belongs to the report workspace, and both the Backend and Web Tool are using the same Supabase project.

### Password reset email does not arrive

For early testing, use an administrator-created/auto-confirmed test user. Configure Supabase custom SMTP before relying on password-reset or confirmation emails in production.
