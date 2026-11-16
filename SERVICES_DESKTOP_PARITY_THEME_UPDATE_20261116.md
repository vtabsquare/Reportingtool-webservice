# VTAB Reporting Services — Desktop Visual Parity and Theme Update

This update is intended to be copied over an existing **Reporting Tool Services 6.1.18** source folder. It preserves the Services-only authentication, workspace permissions, sharing, refresh, subscription, alert, and publishing flows.

## Included updates

1. **Desktop visual parity**
   - Synchronizes the current chart renderer and visual capability registry.
   - Keeps category colors stable and prevents color repetition until the palette is exhausted.
   - Synchronizes current funnel, treemap, gauge, progress, chart-label, tooltip, and dark-canvas behavior.

2. **Advanced KPI parity**
   - Adds the compact sparkline KPI template.
   - Supports internal card background and header background on/off controls.
   - Synchronizes KPI icon, icon background, header, comparison, variance, and additional-detail formatting.
   - Preserves transparent KPI surfaces and blank-measure display behavior.

3. **Card property separation**
   - Normal Card and Multi-row Card now use separate property definitions.

4. **Table and Matrix parity**
   - Removes visual pagination behavior.
   - Adds persistent per-column widths, column ordering, minimum/maximum widths, search visibility, row-count visibility, and table/matrix corner-radius controls.
   - Synchronizes hierarchy expansion and matrix formatting behavior.

5. **Published report appearance**
   - Passes each report page's light/dark canvas state to every visual renderer.
   - Removes residual borders when border formatting is disabled.
   - Preserves independent report-canvas styling even when the Services portal theme changes.

6. **Measure engine parity**
   - Synchronizes scalar iterator, nested CALCULATE, DATEADD, filter-context, and single-row KPI query fixes.
   - Prevents previous-period and year-on-year measures from incorrectly returning the current-period result or zero.

7. **Services light/dark theme switch**
   - Adds an accessible Sun/Moon control to the Services header.
   - Persists the selected mode in the browser.
   - Applies a scoped dark theme to the Services portal without overriding a published report's own canvas theme.

## Apply

1. Stop the Services frontend/backend.
2. Copy the contents of the update package into the existing Services source folder and allow matching files to be replaced.
3. From the Services source folder, run:

   ```powershell
   npm run build:web
   ```

4. Deploy/restart the Services application using the existing deployment process.
5. Perform a hard refresh in the browser once after deployment.

## Verification performed

- Production Services web build: passed.
- Visual formatting contracts: 78/78 passed.
- Services visual/theme parity contract: 9/9 passed.
- Matrix, sorting, slicer, published visual, and paginated publication contracts: passed.
- Updated Python measure-engine modules: syntax compilation passed.

The build reports only the existing large-bundle advisory; it does not report a compilation failure.
