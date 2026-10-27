# VTAB Reporting Services 6.1.10

## Desktop publication parity

- Published reports now use the Desktop universal sorting engine, including calendar order, numeric order, visual overrides, and model-level Sort by Column definitions.
- Matrix visuals now use the dedicated hierarchy renderer with row and column drill levels, independent subtotals and grand totals, stable aggregation, conditional formatting, frozen row headers, and virtualized scrolling.
- Map visuals now support country, state/province, and city/location context controls, exact administrative child boundaries where packaged boundary data is available, contextual city lookup, synchronized cross-filtering, filled-map authority, and safe point handling while panning.
- Slicer typography is applied consistently to list, dropdown, and tile presentations. Enlarged tile text increases tile height instead of being clipped.
- Single-select slicer values can be selected again to clear the current selection.
- Category and legend colors are stable by category identity and no longer depend on query row order.
- Visual backgrounds, title backgrounds, cards, corners, shadows, and blank buttons follow the saved Desktop formatting contract.
- Older published slicers that stored their style under the legacy formatting object remain supported.

## Unified Data Model terminology

All user-facing Services labels, messages, and generated default names now use **Unified Data Model**. Internal API routes, database columns, and migration object names remain unchanged so existing deployments and published reports remain compatible.

## Preserved Services behavior

Authentication, workspaces, sharing, row-level security, notifications, refresh schedules, subscriptions, alerts, exports, paginated reports, gateways, and private snapshot handling are retained from the Services 6.1.9 baseline.

## Verification

- Services production web build: passed.
- Desktop parity runtime checks: passed.
- Visual formatting contract: 75/75 passed.
- Advanced map regression checks: 20/20 passed.
- Services UI/export contracts: 5/5 passed.
- Services/Desktop engine synchronization contracts: 13/13 passed.
- Python runtime source compilation: passed.

Republish reports from the current Desktop build after deployment so Services receives the latest visual, sorting, matrix, map, and Unified Data Model metadata.
