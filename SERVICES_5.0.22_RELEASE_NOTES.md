# VTAB Reporting Services 5.0.22

## Fixed

- Published visuals now accept Desktop implicit measures such as
  `sales_dataset_100_rows_multi_year_1_Copy.OrderID::count`.
- Required relationship tables are included when an implicit raw-column
  aggregate is queried.
- Private report snapshots are downloaded with the signed-in viewer token and
  queried locally by the Services API.
- Valid service accounts and workspace members are no longer rejected by a
  second, narrower browser-side permission check after Supabase RLS has already
  authorized the report.
- Published project JSON works whether Supabase returns it as text or JSON.
- Geometry-v2 pages keep the exact Desktop page width, height, orientation,
  visual coordinates, rotation, stacking order, padding, borders and fonts.
- Fit Page and Fit Width only shrink the authored page; they never enlarge text
  or charts beyond the Desktop design size.
- Decorative Services styles no longer force chart heights, overflow, KPI font
  sizes or title sizes that cause overlap and clipping.
- Text boxes, slicers, images and chart canvases stay inside their authored
  visual boxes.

## Data sources carried into Services

The shared connector layer includes CSV, TSV/TXT, Excel, JSON/JSONL, Parquet,
XML, folders, Google Sheets, SharePoint/OneDrive, SQL Server, Azure SQL,
Synapse, Fabric Warehouse, PostgreSQL, Redshift, MySQL, MariaDB, SQLite,
generic ODBC and Microsoft Access. Database discovery returns schemas and
tables for multi-select import, matching the Desktop navigator flow.

Published reports use private, per-table Parquet snapshots. This makes reports
with several original source types run consistently in Services without
shipping database credentials to the browser.

## Verification completed

- Complete backend regression suite: 88 passed
- Exact Page 2 `OrderID::count` regression
- Private snapshot and publish regression suite
- Connector discovery/import regression suite
- TypeScript type check
- Python backend compilation
- Services API route smoke test
- Production WORKSPACE_ONLY frontend build
