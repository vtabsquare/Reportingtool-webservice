# VTAB Services workspace hierarchy update

This Services-only update supersedes the earlier `VTAB-Services-Semantic-Model-Update-Only.zip` package.

Apply it over the original VTAB Services 5.2.1 project root while preserving the included relative paths. It contains eight changed/new source files only.

## Corrected navigation

- Workspaces are the primary hierarchy.
- `My Workspace` is sorted first and opens automatically.
- Custom workspaces appear below it in the sidebar.
- Opening a workspace shows Reports and connected Semantic Models in one content list.
- Report and Semantic Model rows remain separate assets inside the same workspace.
- Semantic Model three-dot actions include Open, Settings, Refresh history, permissions and lineage.

## Semantic-model Settings sections

- Semantic model description
- Gateway and cloud connections
- Data source credentials
- Parameters
- Query caching
- Refresh
- Q&A
- Explore
- Featured Q&A questions
- Approved for Copilot
- Endorsement
- Request access

Connections, credentials and refresh open the existing working Refresh Center. Features not implemented in the current Services release are explicitly shown as unavailable or not configured.

## Files included

- `api/app/reporting_service.py`
- `api/app/server.py`
- `api/app/supabase_store.py`
- `api/app/refresh_worker.py`
- `src/v11/CloudWorkspace.tsx`
- `src/v11/PublishToServiceDialog.tsx`
- `src/v11/ReportServiceSettings.tsx`
- `src/v11/SemanticModelService.tsx` (new)

## Apply

1. Keep a backup of the current working Services source.
2. Confirm Supabase migration `009_semantic_model_assets.sql` is installed.
3. Extract `VTAB-Services-Workspace-Hierarchy-Update-Only.zip` into the Services project root.
4. Rebuild the Services frontend.
5. Redeploy or restart Services.
6. Sign in and verify `My Workspace` first, followed by custom workspaces.

No Desktop, report-designer, text-box, canvas, chart, visual, formatting or transformation file is included.
