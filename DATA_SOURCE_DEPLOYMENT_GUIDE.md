# VTAB Services 5.2 — data-source deployment

## Required once for every Services deployment

1. In Supabase SQL Editor, run `api/supabase_migrations/008_refresh_runtime.sql` after migrations 004 and 005.
2. Generate a stable encryption key in PowerShell:

   ```powershell
   [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
   ```

3. Save it only in the backend as `VTAB_CREDENTIAL_ENCRYPTION_KEY`. Never expose the service-role key or encryption key in frontend settings.
4. Set `VTAB_REFRESH_WORKER_ENABLED=1`. Use an always-on backend; a sleeping free web service cannot start refreshes on time.
5. Set the frontend `VITE_API_URL` to the deployed backend URL ending in `/api/v1`.
6. Open report `...` > Settings > Scheduled refresh. All three readiness checks must be green.

## Local testing

1. Copy `web.env.example` to `web.env` and fill in the Supabase URL, anon key, service-role key, and encryption key.
2. Run migration 008 in the same Supabase project.
3. Run `python run_web_tool.py`. The runner installs dependencies, rebuilds the website, verifies the 5.2 API routes, and disables browser caching.
4. For a database on the same PC, select **Same network** and use `127.0.0.1` as host. For another LAN database, use its private DNS name/IP and allow the Services PC through its firewall.

## Cloud deployment

Use `api/Dockerfile` for the API. It installs Microsoft ODBC Driver 18, which SQL Server requires in addition to the Python `pyodbc` package. Deploy the static site separately and set `VITE_API_URL` to the API.

Backend-only settings: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VTAB_CREDENTIAL_ENCRYPTION_KEY`, `VTAB_REFRESH_WORKER_ENABLED`, `VTAB_REFRESH_POLL_SECONDS`, `VTAB_WEB_URL`, and `VTAB_ALLOWED_ORIGINS`.

Frontend build settings: `VITE_APP_MODE=WORKSPACE_ONLY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`, and `VITE_WEB_URL`.

## Connector processes

### PostgreSQL

1. Create a login with `CONNECT`, schema `USAGE`, and `SELECT` only.
2. For a cloud database, allow the Services backend outbound/static IP and require TLS. For the same network, allow the Services machine on port 5432.
3. Enter host, port, database, username, password, or a `postgresql://` connection string.
4. Test and load tables, map each model table, select a schedule, and activate.

### SQL Server and Azure SQL

1. Create a read-only login (`db_datareader` or narrower grants).
2. Install Microsoft ODBC Driver 18 on a local Services host; the supplied Dockerfile installs it in cloud deployments.
3. Allow TCP 1433 from the Services host and keep encryption enabled.
4. Enter server, database, login, and password or a complete ODBC connection string; test, map tables, and activate.

### MySQL and MariaDB

1. Create a user with `SELECT` only for the reporting schema.
2. Allow TCP 3306 from the Services host and require TLS for cloud traffic.
3. Enter the individual fields or a `mysql://` / `mariadb://` connection string.
4. Test, load tables, map each report table, and activate.

### Google Sheets

1. Share the Sheet as **Anyone with the link can view**. Do not grant edit permission.
2. Paste the normal Google Sheets URL.
3. VTAB converts it to the CSV export URL and reads a real response during Test connection.
4. Map the Sheet to the report table and activate the schedule.

## Local/private database from a cloud-hosted Service

`localhost` in a cloud service refers to the cloud container, not the user's PC. A connection string alone cannot cross a private firewall safely. The Power BI pattern uses an outbound on-premises gateway agent.

VTAB 5.2 clearly marks this path as requiring VTAB Gateway; it does not falsely report it as connected. Until that separately installable gateway is delivered, run the Services backend on the database network or use a secured cloud database/private network connection that the backend can reach.
