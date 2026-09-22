# Report pairing and multi-source update

Only changed files are included. Apply the Desktop and Services updates to their matching projects.

## Installation

- [ ] Copy `desktop/api/app/server.py` and `desktop/api/app/reporting_service.py` into the Desktop project.
- [ ] Copy the files under `services/` into the same relative paths in the Services project.
- [ ] Keep migration `010_semantic_model_runtime.sql` applied. This incremental update does not add another migration.
- [ ] Rebuild/restart Desktop, Services web, and Services API.
- [ ] For an exact source-lineage test, import or reconnect the test sources after installing this update, then publish. Older projects may not contain enough historical metadata to distinguish the original database from their already-materialized snapshot.

## Workspace ordering

- [ ] Each report row is immediately followed by its connected semantic-model row.
- [ ] Similar names such as `Sales Dashboard` and `Sales Dashboard 1` remain paired by IDs, not by text matching.
- [ ] Searching for either member of a pair keeps the report and its connected model together.

## Four-source test

Create one Desktop report using PostgreSQL Sales, SQL Server Customers, a CSV Targets file, and a REST Exchange Rates source.

- [ ] Desktop stores one non-secret source-lineage entry per imported source.
- [ ] Passwords, API keys, and tokens are absent from the published source manifest.
- [ ] Publishing creates one report and one combined semantic model—not four models.
- [ ] Relationships, measures, calculated/model metadata, query definitions, and source references remain in the combined semantic model.
- [ ] Data Source Configuration shows all four sources, including unconfigured external sources.
- [ ] PostgreSQL and REST can use Direct access.
- [ ] SQL Server can be mapped to its own gateway.
- [ ] CSV is shown as Managed File and reads its published private-storage asset, never the original Desktop path.
- [ ] Each model table is mapped to exactly one source connection.
- [ ] Scheduled refresh cannot be enabled while any model table is missing a mapping, duplicated, or attached to an untested connection.
- [ ] One refresh job reads every configured connection for the semantic model.
- [ ] If any source or required gateway fails, the run fails and the last successful model remains active.
- [ ] Refresh History shows the failed stage, error, and suggested diagnostic.

## Implemented architecture

| Test requirement | Result |
|---|---|
| One report → one semantic model | Implemented |
| Multiple source connections per model | Implemented |
| Source-level table mappings | Implemented |
| Source-specific gateway mapping | Implemented |
| Credentials stored separately and encrypted | Implemented |
| Managed CSV/file asset in private storage | Implemented |
| PostgreSQL, SQL Server, MySQL/MariaDB, REST live connection tests | Implemented |
| Model-wide scheduled/manual refresh | Implemented |
| All-or-nothing activation | Implemented |
| Conditional parameters | Implemented |
| Published transformed data | Implemented; Desktop materializes and publishes the transformed table snapshot |
| Scheduled replay of arbitrary Desktop transformation steps | Not included in this update; scheduled refresh uses the read-only query configured for each final model-table mapping |
| Real private-network gateway transport | Requires a deployed VTAB gateway agent; Services never fabricates an Online heartbeat |

## Files

Desktop:

- `api/app/server.py`
- `api/app/reporting_service.py`

Services:

- `api/app/server.py`
- `api/app/reporting_service.py`
- `api/app/supabase_store.py`
- `api/app/refresh_worker.py`
- `src/v11/SemanticModelService.tsx`
