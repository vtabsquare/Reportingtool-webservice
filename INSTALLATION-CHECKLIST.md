# VTAB Services semantic-model runtime update

This archive contains only new or changed files. It is not a full project.

## Install

- [ ] Back up the matching files in your working VTAB Services 5.2.1 project.
- [ ] Copy the `api` and `src` folders from this archive over the same folders in your Services project.
- [ ] In Supabase SQL Editor, run `api/supabase_migrations/009_semantic_model_assets.sql` only if it was not already applied.
- [ ] Run `api/supabase_migrations/010_semantic_model_runtime.sql` after migration 009.
- [ ] Confirm the backend has `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and the existing VTAB credential-encryption key configured.
- [ ] Confirm `VTAB_REFRESH_WORKER_ENABLED=1` on the backend process.
- [ ] Rebuild the web application and restart both the web and API services.

## Acceptance checklist

- [ ] **My Workspace** appears first and has no Delete Workspace control.
- [ ] Calling the delete-workspace API for **My Workspace** is rejected by the backend.
- [ ] A custom workspace can still be deleted by an Admin.
- [ ] Reports and connected semantic models appear together inside the selected workspace.
- [ ] The semantic-model menu contains only: **Open**, **Refresh Now**, **Refresh History**, **Settings**, and **Delete**.
- [ ] Settings contains only: **Data Source Configuration**, **Gateway Setup**, **Refresh Schedule**, and **Parameters** when published parameters exist.
- [ ] A semantic model can store multiple connections, with different model tables mapped to different connections.
- [ ] SQL Server, PostgreSQL, MySQL/MariaDB tests authenticate, open the database, and execute a live `SELECT 1`.
- [ ] REST tests perform a real authenticated HTTP request and report the returned HTTP failure when access is rejected.
- [ ] Saving/editing a connection never returns a password or API token to the browser.
- [ ] Refresh Now queues the semantic-model job, and Refresh History shows status, duration, table/row counts, and errors.
- [ ] A scheduled refresh reads all configured connections and table mappings.
- [ ] If one connection or gateway fails, the refresh is marked failed and the previous successful report/model snapshot remains active.
- [ ] Parameter changes remain pending until the next refresh; **Apply & Refresh Now** saves and queues the refresh.

## Gateway note

The Services application now stores per-source gateway mappings and checks the registered gateway's real status before refresh. It deliberately does not invent an Online gateway. A private-network source requires an actual VTAB gateway agent/runtime to register in `vtab_gateways` and maintain `status`, `last_heartbeat`, and `version`. Directly reachable sources work without a gateway.

## Files included

- `api/app/connectors.py`
- `api/app/refresh_worker.py`
- `api/app/reporting_service.py`
- `api/app/server.py`
- `api/app/supabase_store.py`
- `api/supabase_migrations/009_semantic_model_assets.sql`
- `api/supabase_migrations/010_semantic_model_runtime.sql`
- `src/v11/CloudWorkspace.tsx`
- `src/v11/PublishToServiceDialog.tsx`
- `src/v11/ReportServiceSettings.tsx`
- `src/v11/SemanticModelService.tsx`
