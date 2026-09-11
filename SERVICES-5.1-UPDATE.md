# VTAB Services 5.1 update

This release turns the earlier schedule form into a working scheduled-refresh foundation.

## Before deployment

1. Open the Supabase SQL Editor and run `api/supabase_migrations/008_refresh_runtime.sql` once.
2. Add `VTAB_CREDENTIAL_ENCRYPTION_KEY` to the backend's private environment variables. Generate a suitable value in PowerShell with:

   ```powershell
   [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
   ```

   Keep this value stable. Changing or losing it makes existing saved refresh credentials unreadable.
3. Keep `SUPABASE_SERVICE_ROLE_KEY` on the backend only. Never add either secret to the frontend/static-site environment.
4. Deploy the backend and web application. The supplied Render definitions enable the worker and poll every 30 seconds.

The backend process must remain running for schedules to fire on time. If the hosting plan sleeps inactive web services, use an always-on instance (or deploy the same worker as a dedicated background process).

## Using Refresh Center

Open a report's Refresh action, create a schedule, test the source, and map every report table to a read-only `SELECT`/CTE query. The report snapshot changes only after every mapped table has refreshed successfully. Refresh Center also provides Run now, pause/resume, delete, next/last-run information, and run history.

PostgreSQL, SQL Server/Azure SQL, MySQL, MariaDB, and shared Google Sheets are supported by the cloud runner. A database must be reachable from the hosted Services backend. Databases that exist only on a user's PC or private office network require the planned VTAB Gateway and are intentionally not represented as cloud-reachable.

## Security and recovery behavior

- Connection credentials are encrypted in the API process before being written to Supabase.
- Stored credentials are never returned by the jobs API.
- Queries are restricted to read-only `SELECT` or CTE statements.
- Concurrent workers claim jobs with database locking, preventing duplicate scheduled execution.
- A failed multi-table refresh retains the last known-good published report definition.
- Failures appear in history and create an in-app notification; four consecutive failures place the schedule in Error until Run now reactivates it.

Schedules created by the old prototype used plaintext credentials. For safety, 5.1 refuses to run those entries. Delete/recreate them in Refresh Center.
