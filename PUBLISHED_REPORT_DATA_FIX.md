# VTAB 5.0.14 — Published report data fix

## What the video showed

Publish and Replace completed, and the report appeared in My Reports. When the
report was opened, slicers were empty, cards showed dashes, and every visual
eventually displayed a Reporting Service query error.

## Root cause

1. Desktop and the Services Web Tool both used API port `8820`. They could send
   requests to the wrong backend when both applications were running.
2. The installer reused a backend EXE using file modification times. A newer UI
   could therefore be packaged with older Python service code.
3. `/cloud/sync-data` logged upload failures and still returned success, allowing
   a report definition to publish without its Parquet data snapshot.
4. The Services query path depended on DuckDB reading a signed HTTPS URL. The
   optional HTTP extension is not reliable in every packaged runtime.

## Fix

- Desktop keeps API port `8820`; the Services Web Tool now uses `8830`.
- The installer fingerprints every backend source file and always rebuilds the
  backend when any backend source changes.
- Publish now stops with a clear table name if any data snapshot is missing or
  cannot upload. It cannot show a false success.
- The Services API downloads each authorized private Supabase object to a
  content-addressed local cache and DuckDB reads that local Parquet file.
- Application and backend versions are aligned at `5.0.14`.

## Apply and test

1. Copy the updated files into both the Desktop and Services Web Tool source.
2. In the Web Tool `web.env`, use:
   - `VITE_API_URL=http://127.0.0.1:8830/api/v1`
   - `VTAB_API_PORT=8830`
3. Stop the old Desktop and Web Tool.
4. Build Desktop with `python build_installer.py`, install version 5.0.14, and
   confirm `http://127.0.0.1:8820/api/v1/health` shows version 5.0.14.
5. Start the Web Tool with `python run_web_tool.py`, and confirm
   `http://127.0.0.1:8830/api/v1/health` shows version 5.0.14.
6. Open the report in Desktop, save it, choose Publish, and confirm Replace.
7. Open the report in the Web Tool. Slicers, cards, charts, and tables should all
   contain the same data as Desktop.

Old published versions that were created without a data snapshot cannot repair
themselves. Republish once from Desktop 5.0.14; the report keeps its report ID
and receives a new recoverable version.
