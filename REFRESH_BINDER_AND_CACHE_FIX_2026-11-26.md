# Post-Refresh Binder Error and Stale Dashboard Cache Fix (2026-11-26)

## Overview

This document captures the root causes and fixes for two data-refresh issues observed in **VTAB Reporting Services** on the `Alerts test` report:

1. **Post-refresh DuckDB `Binder Error` on multi-table Google Sheets models** (`Values list "Customers" does not have a column named "Region"` / `"City"`).
2. **Stale dashboard data after Semantic Model refresh** (refresh history showed `553` total rows / `503` orders, while the opened dashboard continued displaying `502.00` and the earlier `01:21 PM` timestamp).

---

## Issue 1: Post-Refresh DuckDB `Binder Error` on Multi-Table Google Sheets

### Symptoms
- Initial dashboard load succeeded using the published Parquet snapshots.
- After running a data refresh, charts using fields from the `Customers` table (`SalesAmount by Region`, `SalesAmount by City`) failed with:
  - `Binder Error: Values list "Customers" does not have a column named "Region"`
  - `Binder Error: Values list "Customers" does not have a column named "City"`

### Root Cause
1. **Per-table Google Sheets metadata was dropped in `sourceManifest`**:
   - Both `Orders` and `Customers` came from the same Google Spreadsheet (`sourceId`), with per-table `sourceConfig.sheetRange` values (`'Orders!A:ZZ` and `'Customers!A:ZZ`).
   - `_attach_source_manifest` in `api/app/reporting_service.py` grouped both tables under one `source` entry (`Orders`) and omitted per-table `sheet`, `sheetRange`, and `url` fields from `source["tables"]`.
2. **Single worksheet input overwrote all table mappings in the UI**:
   - `DirectConnectionDialog` in `src/v11/SimpleSemanticModelSettings.tsx` rendered only a single `Worksheet name` field (`form.sheet`) and constructed `table_mappings` with `sheet: cleanSheet || item.sheet || item.name || ''`.
   - When `cleanSheet` was `"Orders"`, saving the connection mapped **both** `Orders` and `Customers` to `sheet: "Orders"`.
3. **Connection test did not validate worksheet mappings**:
   - `_test_semantic_model_connection_payload` in `api/app/server.py` only tested spreadsheet URL reachability (`test_connection`) without checking whether each mapped worksheet existed or matched the model table's columns.
4. **Refresh persisted the wrong table schema**:
   - When an un-updated worker without `validate_refresh_frame` executed the job, it downloaded the `Orders` tab for `Customers` and wrote a `Customers_*.parquet` file with `Orders` columns (`OrderID`, `SalesAmount`, etc.), causing DuckDB to fail with `Binder Error` whenever a visual queried `Customers.Region` or `Customers.City`.

### Fixes
- **`api/app/reporting_service.py`**:
  - Added `_extract_sheet_name`, `_build_manifest_table_entry`, and `enrich_source_manifest`.
  - Updated `_attach_source_manifest` to deduplicate `source_id` entries and retain per-table `sheet`, `sheetRange`, `url`, and `sourceObject` metadata.
- **`api/app/supabase_store.py`**:
  - Updated `get_semantic_model_runtime` to return `enrich_source_manifest(definition)` so already-published models expose per-table worksheet names without requiring a Desktop republish.
  - Normalized missing `sheet` values from `sheetRange` inside `save_semantic_model_connection`.
- **`api/app/server.py`**:
  - Added `_validate_google_sheets_table_mappings` inside `_test_semantic_model_connection_payload` to verify each mapped worksheet exists in the workbook and passes `validate_refresh_frame` against the semantic model's expected columns before **Test and save** succeeds.
- **`api/app/refresh_worker.py`**:
  - Updated `source_frame` to fall back to `sheetRange`/`sheet_range` if `sheet`/`sheet_name` is missing.
  - Added DuckDB-backed `_read_parquet_bytes` for `managed_file` refreshes so Parquet reads do not depend on `pyarrow` or `fastparquet`.
- **`src/v11/SimpleSemanticModelSettings.tsx`**:
  - Updated `DirectConnectionDialog` with `extractSheetName` and per-table `Table → Worksheet mapping` inputs for multi-table Google Sheets connections instead of overwriting every table with a single worksheet name.
- **Data Repair (`Alerts test`)**:
  - Updated `Customers` in `semantic_model_connections` to `sheet: "Customers"` and re-ran `execute_refresh` (`Orders`: `501` rows, `Customers`: `50` rows).

---

## Issue 2: Stale Dashboard Data After Semantic Model Refresh

### Symptoms
- Triggering a refresh from the Unified Data Model (`Alerts test Unified Data Model`) completed with `Succeeded · 2 tables · 553 rows` (`503` orders + `50` customers) at `1:23:16 PM`.
- Reopening the dashboard (`/?workspace=1&report=b5ed5667-5081-4f5e-b2ec-e1e7c50319b5`) at `1:25 PM` still showed `Data updated 11/26/2026 01:21 PM` and `Total Orders: 502.00`.

### Root Cause
1. **300-second blind cache in `_get_cloud_project`**:
   - When the report was queried at `1:22 PM`, `_cloud_project_cache` cached the `1:21 PM` (`502` orders) `project_json` for 300 seconds.
   - Opening the dashboard at `1:25 PM` called `/api/v1/published/{report_id}/definition` and `/api/v1/published/{report_id}/query-batch` without `bypass_cache=1`, so `_get_cloud_project` served the cached `1:21 PM` definition until the 300-second TTL expired without checking whether `published_reports.updated_at` in Supabase had changed.
2. **Missing cache invalidation when polling `bridge_refresh_status`**:
   - In `api/app/data_bridge.py`, `bridge_refresh_status` only invalidated report caches in branch #3 (`vtab_bridge_refresh_jobs`), not in branch #1 (`refresh_runs`) or branch #2 (`scheduled_jobs`).
3. **Stale nested `report.updated_at` and viewer query dependencies**:
   - `_get_cloud_project` used `p_report.setdefault('updated_at', ...)` instead of updating `p_report['updated_at']` to the latest row timestamp.
   - `PublishedViewer.tsx`'s visual query `useEffect` did not include `item?.updated_at` in its dependency array.

### Fixes
- **`api/app/server.py`**:
  - Updated `_get_cloud_project` to store `updated_at` in `_cloud_project_cache` and, after a 1.5s burst window, check `published_reports.updated_at` in Supabase; on mismatch, it calls `invalidate_report_cache(report_id)` and reloads the latest `project_json`.
  - Updated `p_report['updated_at'] = row.get('updated_at')` so nested report timestamps remain accurate.
- **`api/app/data_bridge.py`**:
  - Added `_invalidate_semantic_model_reports` and invoked it whenever `bridge_refresh_status` observes `status == "succeeded"` across `refresh_runs`, `scheduled_jobs`, and `vtab_bridge_refresh_jobs`.
- **`src/v11/PublishedViewer.tsx`**:
  - Added `item?.updated_at` to the page visual query `useEffect` dependency list.

---

## Verification

- **Backend unit tests** (`api/tests/test_refresh_runtime.py`, `test_semantic_model_service_regressions.py`, `test_notification_foundation.py`, `test_automation_foundation.py`):
  - `Ran 26 tests in 9.231s — OK`, including new tests covering multi-table Google Sheets manifest preservation/enrichment, connection worksheet validation, DuckDB Parquet round-trip, and `_get_cloud_project` cache invalidation on `updated_at` change.
- **Frontend contract tests & build**:
  - `npm run test:services-update-workflow`, `npm run test:admin-services-permissions`, `npm run test:notification-visibility`, and `npm run build:web` passed.
- **Live local Services verification (`http://127.0.0.1:4173`)**:
  - `/api/v1/health` returned `status: "ok"`.
  - `/api/v1/published/b5ed5667-5081-4f5e-b2ec-e1e7c50319b5/definition` returned `updated_at: 2026-11-26T07:53:15.86108+00:00`.
  - `/api/v1/published/b5ed5667-5081-4f5e-b2ec-e1e7c50319b5/query-batch` returned all 7 visuals with 0 errors and `Total Orders: 503`.

> **Deployment note**: If a remote backend instance (such as Render) also polls the shared Supabase `scheduled_jobs` table, deploy these backend updates there as well so remote workers enforce `validate_refresh_frame` and cache invalidation consistently.
