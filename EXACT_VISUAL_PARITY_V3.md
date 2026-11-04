# VTAB Reporting Services 6.1.10 — Exact Visual Parity v3

This is a cumulative Services-only replacement package. It includes v2 and the backend compiler correction exposed by the newly published Advanced KPI.

## Confirmed root causes

### Numeric KPI was compiled as a date

The compiler previously treated any generated expression containing `AS DATE` or `INTERVAL` as date-valued. A numeric measure using `PREVIOUSMONTH` contains those tokens inside its aggregate filter, so a condition such as `[KPI Variance] > 0` became a `DOUBLE > DATE` comparison.

Date detection now evaluates the scalar result type instead of searching the entire generated SQL. Numeric time-intelligence measures remain numeric, while actual date-valued expressions continue to receive date coercion.

### Published page expanded from 16:9 to approximately 3:2

The viewer could treat older pixel coordinates as legacy grid coordinates when `geometryVersion` was absent. It then inflated page height using grid calculations. Fixed page presets could also be auto-grown by stale `autoFitHeight` metadata.

Services now:

- infers pixel geometry from the saved coordinate range;
- never auto-grows a fixed 16:9, 16:10, 4:3, Letter, Tooltip, or A4 preset;
- uses the current Desktop fallback of 1920 × 1080;
- applies the same rules during browser export.

## Apply safely

1. Back up the current Reporting Services project.
2. Copy the complete contents of this package into the Services project root and replace matching files.
3. Confirm that `api/app/dax_engine.py` is replaced. This file is essential for the red Binder Error shown in the report.
4. Rebuild the web application with `npm run build:web`.
5. Restart the backend process as well as the web service. Restarting only the frontend leaves the old measure compiler active.
6. Republish the report from Desktop, then hard-refresh the Services page.

## Acceptance checks

- The red `DOUBLE` versus `DATE` Binder Error no longer appears.
- The published canvas remains 16:9 and matches the Desktop page bounds.
- Background Cover fills the canvas; Contain intentionally preserves aspect-ratio gutters.
- Advanced KPI primary values, comparison values, variance/percentage, arrow/status, labels, colors, and positions render.
- Normal cards retain Desktop padding, alignment, title, background, border, radius, and shadow.

## Verification performed

- Exact failing KPI compiler pattern: passed.
- Python backend compilation: passed.
- Services workflow and parity contract: passed.
- Published visual-parity contract: passed.
- 75 visual-formatting checks: passed.
- Desktop parity suite for maps, matrix, sorting, and slicers: passed.
- Production Services web build: passed.

