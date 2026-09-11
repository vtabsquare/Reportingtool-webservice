# VTAB Reporting Service — implementation and verification

## Scope and source-of-truth decision

The existing `Project` JSON remains the common report definition. Desktop authoring and the browser viewer continue to use the same pages, visuals, bindings, filters, slicers, formatting, semantic model, measures, relationships, and security metadata. The service integration is additive; it does not replace the desktop renderer or its save/load behavior.

The supplied requirements describe a multi-release platform. Implementing all enterprise phases in one change would put the completed desktop application at unnecessary risk. The work is therefore ordered around a usable vertical slice first.

## Complete requested capability inventory

| Area | This release | Planned phase |
|---|---|---|
| Shared report definition and compatibility versions | Implemented | Maintain with migrations |
| Supabase authentication shared by Desktop/Web | Existing, retained; server token validation added | Session administration later |
| Organizations and tenant keys | Schema foundation implemented | Organization UI in Phase 7 |
| My Workspace | Automatically provisioned | Workspace settings in Phase 1 follow-up |
| Shared workspaces | Existing UI retained | Rename/description/removal improvements in Phase 1 follow-up |
| Admin, Member, Contributor, Viewer roles | Implemented in schema, API checks, and member UI | Central permission service extended to every operation in Phase 4 |
| Desktop workspace selection and publish | Implemented | Package upload moved to background jobs for large models in Phase 6 |
| Server-side package validation and secret removal | Implemented | Object-storage malware/content scanning in Phase 6 |
| Immutable report versions | Implemented in database/API | Version-history/restore UI in Phase 2 follow-up |
| Browser report rendering/interactions | Existing shared viewer retained | Drill/tooltips parity matrix in Phase 3 |
| Report sharing | Existing report/workspace sharing retained | Removal, groups, invitations in Phase 4 |
| Backend RLS | Database workspace/report RLS and existing model RLS retained | Organization-wide RLS audit in Phase 4 |
| Semantic model as a service object | Implemented on publish | Reuse/deduplication UI in Phase 3 |
| Data sources and encrypted credentials | Existing connection UI; published secrets are removed | Vault-backed credentials in Phase 5 |
| Manual refresh and history | Not in this vertical slice | Phase 5 |
| Scheduled refresh, queue, worker, retry | Existing scheduler prototype retained | Redis/worker implementation in Phase 6 |
| Notifications | Publish notification schema/write implemented | Inbox/email channels in Phase 6 |
| Audit | Publish audit schema/write implemented | Full audit coverage and admin screen in Phase 7 |
| Admin, search, home, favorites, recent | Existing basic portal retained | Phase 7 |
| Health/structured monitoring/rate limits | Existing health endpoints retained | Production observability in Phase 7 |

## Implemented publish flow

```text
Desktop Publish
  -> validate signed-in Supabase session
  -> load permitted workspaces
  -> select workspace and report name
  -> save current desktop project
  -> upload/synchronize analytical snapshot
  -> remove inline credentials
  -> validate report schema and size
  -> PostgreSQL transaction
       -> authorize workspace role
       -> create/update report
       -> append immutable version
       -> upsert semantic model
       -> grant workspace access
       -> write audit record
       -> create notification
  -> return report/version/workspace/web URL
  -> open shared browser viewer
```

Viewer, editor, and model code remain separate at the UI level but consume the same saved definition.

## Service data model

```text
organizations
  1 -> many organization_members -> auth.users
  1 -> many workspaces
         1 -> many workspace_members -> auth.users
         1 -> many published_reports
                1 -> many report_versions (immutable snapshots)
                1 -> 1 semantic_models
                many -> many users through report_access_grants
         1 -> many audit_logs
  1 -> many notifications -> auth.users
```

Large Parquet/model artifacts continue to use the private `vtab-reports` object-storage bucket; relational tables contain metadata and report/version definitions.

## Deployment setup

1. Keep the existing Supabase project and apply SQL files in this exact order:
   1. `api/supabase_migration.sql`
   2. `api/supabase_rpc.sql`
   3. `api/supabase_migrations/003_users_mirror.sql`
   4. `api/supabase_migrations/004_scheduler.sql`
   5. `api/supabase_migrations/005_reporting_service_foundation.sql`
2. Configure the backend environment (never put the service-role key in the desktop installer):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VTAB_WEB_URL` pointing to the deployed workspace, for example `https://reports.company.com`
   - `VTAB_ALLOWED_ORIGINS` containing the deployed workspace origin
3. Configure the frontend build with:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_WEB_URL`
4. Build the web portal with `npm run build:web` and deploy `dist-web` plus the FastAPI service.
5. Build the Desktop application using the existing installer process only after the service URL is confirmed.

## Manual verification

### A. First publish

1. Register/sign in to the web workspace once.
2. Start Desktop and sign in with the same account.
3. Open a working report and choose **Publish**.
4. Select **My Workspace**, confirm the report name, enter a change description, and publish.
5. Confirm the result shows workspace, report name, and version `1.0`.
6. Select **Open in Reporting Service**.
7. Verify every page opens and compare charts, tables, cards, slicers, page filters, cross-filtering, sorting, navigation, full-screen, PDF, and PowerPoint behavior with Desktop.

### B. Versioning

1. Change one visible title or measure in Desktop and publish the same report again.
2. Confirm the returned version is `1.1`; the previous row in `report_versions` must still exist.
3. Call `GET /api/v1/service/reports/{report_id}/versions` while signed in and confirm both versions are listed.
4. Restore `1.0` through `POST /api/v1/service/reports/{report_id}/versions/{version_id}/restore` and verify the browser viewer shows the older definition.

### C. Permissions and tenant isolation

1. Add four test users to a workspace, one per role.
2. Confirm Admin, Member, and Contributor can publish; Viewer must receive a clear permission message and cannot publish by changing the workspace ID in the request.
3. Sign in as a user outside the workspace and verify report, version, and workspace endpoints return access denied.
4. Confirm a report ID from another workspace cannot be overwritten or moved.

### D. Package security and compatibility

1. Add a test data-source object containing a password and a `credentialRef`, then publish.
2. Confirm the version JSON contains the reference but not the password.
3. Submit a package with `reportSchemaVersion: "2.0"`; confirm it is rejected with the supported schema shown.
4. Confirm a project with no pages or malformed visuals is rejected before any database write.

### E. Existing desktop regression

1. Open, edit, save, close, and reopen an existing local report without publishing.
2. Verify data import, transforms, relationships, measures, report editing, undo/redo, themes, export packages, and the local viewer still work.
3. Disconnect the service/network and confirm local authoring/save remains usable; only cloud publishing should fail.

## Automated verification completed

- TypeScript strict check: passed.
- Production frontend build: passed.
- New Reporting Service publish tests: 6 passed.
- Existing core and report-isolation tests: 9 passed.
- Existing release/open-bug regression tests: 10 passed.
- Total targeted backend tests: 25 passed.

The production build still reports the existing large studio JavaScript chunk warning. It does not break the build; code splitting should be handled as a separate performance release to avoid changing desktop behavior during service integration.
