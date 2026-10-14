# Desktop to Services synchronization — 2026-10-14

This source package preserves the existing Reporting Services shell, published-report toolbar, governance, notification center, subscriptions, alerts, email workers, security, and cloud workspace behavior. Shared report-authoring and rendering capabilities were synchronized from the latest Desktop source.

## Synchronized capabilities

- DAX recovery engine `5.0.23-dax-recovery-2`, with 74 supported functions, definition diagnostics, conservative typo repair, and 28 built-in health checks.
- Complex table expressions and iterators, including `VALUES`, `ALL`, `FILTER`, `SUMMARIZE`, `ADDCOLUMNS`, `TOPN`, `CONCATENATEX`, `MINX`, `MAXX`, `SUMX`, and `AVERAGEX`.
- Measure health API at `GET /api/v1/measures/health`; validation and save are protected by the engine self-test.
- Current Desktop measure workbench and automatic measure-name handling.
- Current visual formatting workspace, including general/visual property wiring, title formatting, rounded corners, conditional formatting, and table/matrix field-value formatting.
- Shape geometry, resizing, selection bounds, rotation, spacing, canvas interaction, and report-page deletion behavior.
- Tableau-inspired map visual, map field wells, spatial-file parsing, MapLibre rendering, layers, legends, points, paths, shapes, tooltips, and published-report map queries.
- Current Desktop report canvas, chart rendering, card/table sizing, scrollbar behavior, gauges, heatmaps, rich text, and exact geometry transfer into Reporting Services.
- Production web assets rebuilt into `dist-web`.

## Verification completed

- Services production web build: passed (`2394` modules transformed).
- DAX engine health: passed (`28/28`, `74` supported functions).
- Latest DAX regression files: passed (`19/19` test groups; parameterized stress matrices execute inside those groups).
- Python backend syntax compilation: passed.

## Database migrations

The Desktop parity and map synchronization add no new SQL tables.

The existing Services notification/alert/subscription work remains included and still requires these migrations on an environment where they have not already been applied:

1. `api/supabase_migrations/017_notification_email_foundation.sql`
2. `api/supabase_migrations/018_subscriptions_and_alerts.sql`

Brevo remains environment-configured; no credential is embedded in this source package. Use the variables documented in `web.env.example` and the existing deployment notes.

## Install and run

1. Run `npm install` after copying the source, or let the updated one-command runner install the locked packages automatically.
2. Apply migrations `017` and `018` only if the target Supabase database does not already contain them.
3. Configure the target environment from `web.env.example`.
4. Run `npm run build:web` or start with the existing Services runner.

The updated `run_web_tool.py` also detects a missing or outdated frontend dependency tree and runs the locked `npm ci` installation automatically. This prevents map modules such as `maplibre-gl` from being missing when updated source is copied over an older installation.
