# VTAB Reporting Services 6.1.10 — Exact Visual Parity v2

This is a cumulative Services-only update. It includes the earlier Desktop parity and post-deployment workflow files plus the visual-parity corrections below. Copy it over the matching Services project root; do not copy it into the Desktop project.

## Defects corrected

1. Advanced KPI percentage, status, and conditional color roles were not included by the published-query builder. Services now queries `variance`, `indicator`, and `color` bindings in addition to the primary and target values.
2. Services classified a visual as wide at 540 pixels while Desktop uses 900 pixels. Both applications now use the same breakpoint, preventing KPI and multi-card reflow after publishing.
3. The published viewer applied fixed card padding and centering. Current pixel reports now use the saved Desktop padding, alignment, background, border, radius, and shadow.
4. Page background images now use the same `cover`, `contain`, `stretch`, or `center` rule as Desktop. A Desktop page saved as Cover will therefore fill the same 16:9 canvas in Services.
5. Normal cards and Advanced KPI visuals now receive the same premium visual container contract used by Desktop.

## Apply

1. Back up the current Services project.
2. Copy every file in this package into the Services project root and allow matching files to be replaced.
3. Keep the existing environment values. Compare `web.env.example` only for newly introduced variables.
4. Run `npm install` when dependency metadata differs, then run `npm run build:web`.
5. Restart the Services backend and web deployment.
6. Publish the report again from the latest Desktop build, then hard-refresh the browser. Republishing is important for reports whose older snapshot predates the explicit Advanced KPI role bindings.

## Verification

- The canvas retains its authored 1920 × 1080 ratio without changing the saved page size.
- A background saved as Cover has no side gutters; Contain intentionally retains gutters when the image ratio differs.
- Advanced KPI variance/percentage, indicator/arrow, color, labels, and saved positions appear.
- Normal cards retain Desktop padding, label/value alignment, border, radius, shadow, and background.
- Buttons, icons, maps, filters, and the update workflow remain unchanged.

## Automated checks completed

- Python backend compilation
- Services update and visual-parity contract
- 75 visual-formatting contract checks
- Published visual-parity contract
- Production web build

