# VTAB Services feedback fixes — update-only package

This package updates **Services only**. It contains no Desktop files and is not
a complete project.

## Changed files

- `src/v11/SemanticModelService.tsx`
- `api/app/server.py`
- `api/app/supabase_store.py`
- `api/app/refresh_worker.py`
- `api/supabase_migrations/011_gateway_configuration.sql`
- `api/supabase_migrations/012_services_runtime_readiness.sql`
- `api/tests/test_semantic_model_service_regressions.py`

## Apply

- [ ] Back up the current Services source and Supabase database.
- [ ] Copy the `src` and `api` folders over the matching paths in the current
      Services project.
- [ ] If it has not already been applied, run
      `api/supabase_migrations/011_gateway_configuration.sql` in Supabase.
- [ ] Run `api/supabase_migrations/012_services_runtime_readiness.sql` once.
- [ ] Confirm the backend still has `VTAB_CREDENTIAL_ENCRYPTION_KEY`, Supabase
      service-role credentials, and `VTAB_REFRESH_WORKER_ENABLED=1`.
- [ ] Rebuild/redeploy the Services frontend and backend.
- [ ] Restart the refresh worker.

## Covered feedback

- [x] A single click on a report name opens the published report viewer.
- [x] Report content continues to come from the published project snapshot.
- [x] A publish-time snapshot is labelled `Published Snapshot`, not `Available`.
- [x] Snapshot availability is separated from live connection readiness.
- [x] Semantic models show `Setup required` until every table is mapped to a
      tested live source.
- [x] Refresh Now and scheduled refresh remain disabled until the model is ready.
- [x] Saving a connection repeats the test on the backend; the browser cannot
      falsely mark an untested connection as connected.
- [x] The settings page explains direct/cloud, deployed Services network, Render,
      localhost, and on-premises gateway choices.
- [x] Clicking outside the semantic-model dialog closes it.
- [x] Clicking outside a three-dot menu closes the menu.
- [x] Refresh Now opens Refresh History immediately and reports Queued, Running,
      Succeeded, or Failed while polling the backend.
- [x] Previous successful runs cannot be mistaken for a newly queued request.
- [x] Credentials remain encrypted and are never returned by runtime APIs.
- [x] Failed multi-source refreshes preserve the previous successful snapshot.

## Connection test

- [ ] Open the semantic model's **Settings**.
- [ ] Choose cloud/direct when the deployed Services backend can reach the source.
- [ ] Choose Services network gateway when the backend should act as the runtime.
- [ ] Choose on-premises gateway only after its agent is installed and Online.
- [ ] Enter credentials and map every semantic-model table exactly once.
- [ ] Select **Test Connection**, then **Save**.
- [ ] Confirm the model changes from `Setup required` to `Ready`.
- [ ] Run **Refresh Now** and observe it reach Succeeded or Failed.
- [ ] Open the report and verify refreshed data after a successful run.

## Verification completed

- Python syntax compilation: passed.
- Backend regression tests: 4 passed.
- TypeScript type check: passed.
- Production Vite build: passed (existing chunk-size warning only).
