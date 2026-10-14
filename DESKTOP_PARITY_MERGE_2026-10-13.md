# Desktop parity merge — 2026-10-13

This package keeps the supplied Reporting Services interface and merges the
technical report-runtime updates from the latest Desktop code.

## Included fixes

- Measure names are derived from the text before the first top-level `=`.
- Names containing spaces and `%` are treated as text, not DAX expressions.
- `COUNTROWS`, iterator functions, nested `DIVIDE`, and measure-based
  `CALCULATE` expressions compile through the Services semantic engine.
- Published shapes use the complete saved bounding box with no hidden inset or
  container padding, including fill/outline visibility and rounded corners.
- Geometry-version 2 visuals retain their saved pixel `x`, `y`, `width`, and
  `height` in the published report.
- Published cards no longer create an internal scrollbar inside the visual.
- Returning from Paginated Reports restores the dashboard in Fit to width mode.
- The supplied Services ribbon/button interface was preserved.

## Verification

- `npm run build:web` — passed.
- Python syntax compilation for the updated API modules — passed.
- `api/tests/verify_desktop_parity_20261013.py` — passed.

The generated `dist-web` production output is included. Dependency folders and
local runtime data are intentionally not included in the delivery archive; run
`npm install` when dependencies need to be restored.
