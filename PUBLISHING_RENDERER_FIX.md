# Desktop-to-Service rendering fix

## Root cause

Desktop 5.0.22 publishes current visuals with `geometryVersion: 2`, where `x`, `y`, `w`, and `h` are pixel values. The 5.0.8 web viewer ignored that version, rounded the values, imposed minimum grid spans, and rebuilt every visual in a responsive 12-column grid. It also used service-only default styling and did not understand several fields in the current desktop visual schema.

## Changes

- Geometry-v2 reports now use exact absolute pixel geometry, rotation, visibility, and z-order.
- Geometry-v2 positions are measured from the full page origin, matching Desktop. The dashboard header is an overlay in that same coordinate space and is no longer added a second time to every visual's vertical position.
- The published canvas keeps the exact Desktop dimensions and aspect ratio (for example 960×720, 4:3). Fit Width and Full Report are shrink-only and never upscale a report beyond 100%.
- Legacy reports continue to use their original grid layout.
- Fit-to-width and fit-to-page scale the complete desktop canvas uniformly; they do not reflow individual visuals.
- The page header uses the saved title, subtitle, dimensions, colors, padding, and radius without substituting service text.
- Visual background, transparency, borders, per-edge settings, corner radii, shadow, font, title formatting, and body padding are applied from the published definition.
- Text boxes restore rich text and general text formatting.
- Button and slicer formatting from the current desktop schema is supported.
- Published slicers now reuse the Desktop list/search/dropdown presentation instead of replacing list slicers with service-only pill buttons.
- The viewer opens in **Actual** mode, preserving the authored pixel dimensions. Fit modes remain available and can only shrink the complete canvas.
- ECharts tooltips are isolated from chart-host sizing rules and constrained to content size, preventing the chart-sized white hover overlay.
- The web visual types now include the Desktop 5.0.22 geometry and formatting fields.
- Publish validation rejects missing/duplicate persistent IDs, missing bindings/format objects, and invalid geometry.
- A stable SHA-256 report-definition hash is stored in version metadata and returned by publish, allowing the desktop snapshot and stored version to be compared.

## Deployment

The `dist-web` directory in this package has already been rebuilt in workspace-only mode. Deploy it using the web application's existing deployment process. Deploy the updated backend files as well so publish validation and definition hashing are active.

After deployment, republish an existing desktop report to create a new current version, then verify it in **Actual** view first. **Fit Width** and **Full Report** should have the same relative layout at a uniform scale.

## Verification performed

- Production Vite build completed successfully.
- Backend module compiled successfully.
- Direct regression checks verified exact geometry/format preservation, stable definition hashing, and invalid-geometry rejection.
- The review-video regression was checked against the demonstrated header/slicer/KPI/chart arrangement: the pixel layer now starts at page coordinate `(0, 0)` and page auto-height no longer double-counts the header.
- A browser layout regression fixture measured a 960×720 published page as exactly 960×720 in a 1280-pixel viewport and measured its sample tooltip as content-sized rather than visual-sized.
- Frontend and API product versions now come from the same root package version. The local runner passes that version to the API process, preventing the 5.0.16 website / 5.0.15 API startup mismatch.
