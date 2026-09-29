# Reporting Services Performance Optimization — 5.2.2

This release implements the four performance corrections identified in the supplied optimization report.

## Implemented corrections

1. **Lightweight visual requests**
   - Published dashboard visuals now send only the visual ID and active filter state.
   - The backend retrieves the cached published definition and derives dimensions, measures, visual filters, sorting, and limits from the stored visual.
   - The legacy snapshot endpoint remains available for compatibility, but the published viewer no longer sends a complete project definition per chart.

2. **Cached and single-flight security resolution**
   - Verified Supabase authentication is cached for five minutes using a SHA-256 token key; raw tokens are never stored as cache keys.
   - Published RLS results are cached for five minutes per report and access token.
   - Concurrent first-load visual requests share one RLS lookup instead of repeating the same report, workspace, grant, group, and role queries.
   - RLS caches are invalidated immediately after membership changes, publishing, or version restoration.

3. **Concurrent analytical queries**
   - DuckDB view creation remains protected by the DDL lock, while chart query execution runs outside that lock.
   - Created Parquet views are reused from the process cache.
   - The optional DuckDB HTTP extension is no longer installed on every connection; installation is attempted at most once per process.

4. **No large definitions in navigation lists**
   - Accessible-report and workspace lists select only report metadata and the small paginated-report projection.
   - Full `project_json` is loaded only when a report is opened.
   - Semantic-model lists use published summary metadata rather than loading the model definition to calculate counts.

## Additional first-load improvements

- Concurrent requests for the same uncached cloud report share one full-definition fetch.
- Hydrated snapshot definitions and downloaded Parquet paths are reused for five minutes instead of deep-copying the report and checking/downloading every source per chart.
- Authorization is resolved before private snapshot hydration.
- Report-, page-, visual-, and interaction-level filters are combined correctly for published visuals.

## Configuration

- `VTAB_SECURITY_CACHE_TTL_SECONDS` defaults to `300`.
- `VTAB_AUTH_CACHE_MAX` defaults to `1024` entries.
- `VTAB_HYDRATED_CACHE_MAX` defaults to `64` entries.

## Verification completed

- Production web build completed with Vite (2,442 modules transformed).
- Python syntax compilation passed for all changed backend modules.
- Six focused regression tests passed, covering authentication reuse, RLS single-flight behavior, snapshot reuse, lightweight published requests, report-list projections, and concurrent chart execution.

## Deployment

Deploy the included `dist-web` directory and restart the Python Reporting Services API using the updated `api/app` sources. A restart is required so the new process caches and query path are active.
