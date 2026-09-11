# VTAB Services Web Tool — one-command local test

## Configure once

Open `web.env` and replace only these three placeholders:

```env
VITE_SUPABASE_URL=https://REPLACE_WITH_YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=REPLACE_WITH_YOUR_PUBLIC_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=REPLACE_WITH_YOUR_SERVER_SERVICE_ROLE_KEY
```

Use the same Supabase project configured in the Desktop application. Keep `web.env` private. Never upload it to GitHub.

For the first local test, leave these addresses unchanged:

```env
VITE_API_URL=http://127.0.0.1:8820/api/v1
VITE_WEB_URL=http://127.0.0.1:4173
VTAB_WEB_URL=http://127.0.0.1:4173
VTAB_ALLOWED_ORIGINS=http://127.0.0.1:4173
```

## Run the Web Tool

From the extracted Web Tool folder, run:

```powershell
python run_web_tool.py
```

The first run installs missing packages, builds the website, starts the API, starts the website, verifies API health, and opens the browser. Later runs reuse installed packages.

Keep the Python window open during testing. The local addresses are:

- Web Tool: `http://127.0.0.1:4173`
- API health: `http://127.0.0.1:8820/api/v1/health`

Use `Ctrl+C` in the Python window to stop both services.

## Connect the Desktop application

In the Desktop source `desktop.env`, keep the same Supabase URL and public anon key, then set:

```env
VITE_WEB_URL=http://127.0.0.1:4173
VTAB_WEB_URL=http://127.0.0.1:4173
```

Run `python build_installer.py`, install version 5.0.11, and sign in.

## Publish and open the report

1. Keep `python run_web_tool.py` running.
2. Open the sample dashboard in VTAB Desktop.
3. Select the top-right **Publish** button.
4. Select your workspace, confirm the report name, and select **Publish**.
5. Wait for **Published successfully**.
6. Select **Open in Reporting Service**.
7. If the browser asks for authentication, use the same confirmed Supabase email and password.
8. Open the published report and verify pages, filters, slicers, cross-filtering, and scrolling.

Publishing creates a versioned Supabase report snapshot. Repeating Publish for the same report creates another recoverable version instead of a separate unrelated report.

## Production later

The same variable names are used in production. Replace the localhost website/API addresses with the Railway and hosted Web Tool domains, then rebuild the relevant application. The service-role value belongs only in the backend hosting environment and must never be configured in the hosted browser frontend.
