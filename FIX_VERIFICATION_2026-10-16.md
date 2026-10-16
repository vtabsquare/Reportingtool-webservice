# Colleague issue regression fix — 2026-10-16

## Corrected

- Text-column `COUNT` and `DISTINCTCOUNT` no longer cast values to numbers.
- Measures accidentally persisted in dimension-style wells are normalized before relationship planning.
- Map visuals accept aggregated measures/KPIs in Size, Color, Label, and Tooltip query paths.
- Numeric map color measures use a continuous negative-to-positive scale.
- Legacy reports with City/Region/State text saved in Geometry are geocoded as named locations; valid GeoJSON is unchanged.
- Published map payloads retain geographic dimensions and aggregated map measures.
- Raw table queries preserve all source rows up to the visual limit rather than implicitly grouping them.
- Current- and previous-period DAX regression coverage is included.

## Verification

- Exact Active Patients formula from the supplied evidence: passed with 241 distinct patients.
- Raw two-column table: 241 of 241 records returned.
- Map Region + Total Revenue measure: three aggregated regions and correct grand total.
- Text count and distinct count: 241 and 241.
- Current Month Revenue and Previous Month Revenue: both non-blank.
- Existing issue 12/13/14/15/17 suite: 5/5 passed.
- Services production frontend build: passed.

No database schema or SQL migration is required.
