# VTAB Reporting Services 6.1.6

This release mirrors the Desktop 6.1.6 semantic measure engine so published reports keep the same behavior after publication.

- Adds executable `STDEV.P`, `STDEV.S`, `VAR.P`, and `VAR.S` support.
- Supports iterator-local `VAR ... RETURN` expressions.
- Correctly applies context transition and `ALL` inside concentration measures.
- Routes `BLANK()` and every other validated scalar measure through the DuckDB storage adapter.
- Includes the securities-measure regression suite used by Desktop.
- Preserves the existing workspace, report-access, group-governance, slicer, formatting, and publication behavior.
