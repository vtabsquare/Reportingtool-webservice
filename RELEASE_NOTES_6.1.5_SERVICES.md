# VTAB Reporting Services 6.1.5 — Desktop Publishing Parity

This full Services source synchronizes the published-report runtime with Desktop 6.1.5 while retaining the existing Services governance, workspace, export, refresh, automation, security, and offline-recovery features.

## Runtime compatibility

- Added the complete semantic DAX v2 parser, binder, compatibility, reconstruction, and DuckDB lowering stack.
- Published visual queries now execute saved measures through the same semantic compiler used by Desktop validation.
- Included support for measure definitions, dependent measures, virtual iterator columns, context transitions, Power BI compatibility rewrites, and complex date/iterator measures.
- The obsolete AI measure-generation endpoint was removed; Services evaluates the manually-authored semantic measure definition published by Desktop.

## Visual compatibility

- Pie, donut, and legend-driven chart colors are deterministic by category identity and no longer depend on database row order.
- Saved category/legend color overrides are applied to bar, column, stacked, line, area, combo, pie, and donut visuals.
- Published list, dropdown, and tile slicers use the Desktop font-size and typography contract.
- Independent slicer selections, self-filter prevention, dropdown overflow, workspace switching, and published export safeguards from the Services branch are preserved.

## Governance preserved

- Personal workspace provisioning.
- Workspace-level and report-level access.
- Group-derived and direct access handling.
- Viewer restrictions for semantic-model administration.
- `019_workspace_report_access_and_provisioning.sql` is included for deployments that have not applied it.

## Verification

- Services WORKSPACE_ONLY production build: passed.
- Visual-formatting contracts: 75/75 passed.
- Desktop/Services synchronization contracts: 8/8 passed.
- DAX and colleague/access regressions: 50/50 passed.
- Published DAX, visual parity, access, isolation, and semantic-model regressions: 15/15 passed.
- Private snapshot hydration tests: 2/2 passed.

