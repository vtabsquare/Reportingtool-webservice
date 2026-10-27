# Desktop-to-Services parity boundary

This release treats the Desktop published project snapshot as the presentation source of truth. Services preserves the saved page size, visual geometry, formatting, field bindings, sorting metadata, category colors, matrix configuration, map hierarchy, slicer style, and Unified Data Model definition.

Services remains authoritative for authentication, authorization, workspaces, sharing, row-level security enforcement, refresh execution, notifications, subscriptions, alerts, exports, gateways, and private snapshot access.

## Compatibility rule for future updates

When a Desktop visual contract changes, update the shared Services renderer additively. Do not replace Services-only state management or server security behavior. Maintain readers for older published payload locations when a field moves, as done here for slicer style.

## Files added or synchronized in this release

- `src/components/AdvancedMapVisual.tsx`
- `src/components/MatrixVisual.tsx`
- `src/components/matrixVisual.css`
- `src/components/DeferredTextInput.tsx`
- `src/components/Chart.tsx`
- `src/components/FormattingWorkspace.tsx`
- `src/calendarSorting.ts`
- `src/sortingEngine.ts`
- `src/mapEngine.ts`
- `src/mapGeography.ts`
- `src/mapVisual.css`
- `src/types.ts`
- `src/visualFormattingSchema.ts`
- `src/v11/PublishedViewer.tsx`
- local administrative and place-name map assets under `src/assets/maps/`

The existing Services backend and portal files were retained and only user-facing Unified Data Model wording was updated.
