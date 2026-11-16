# VTAB Reporting Services — Canvas, Theme and Zoom Fix

This hotfix applies to the previously synchronized Reporting Tool Services 6.1.18 source.

## Fixed

### 1. Published report looked pale or whitish

The Services stylesheet was forcing a light-gray page background over the background configured in Desktop. Transparent report artwork therefore blended against the wrong color.

The published page background is now authoritative, pixel-layout visual bodies remain transparent, and the Services portal theme cannot recolor the report canvas.

### 2. Incomplete Services dark theme

The original dark rules loaded before the main Services portal stylesheet, allowing later light declarations to override them.

The dedicated theme now loads at the authoritative end of the portal stylesheet and covers:

- Global header and search
- Navigation rail and workspace drawer
- Workspace content area
- Filter pills and quick-access cards
- Report and semantic-model tables
- Help and profile menus
- Notifications and notification settings
- Automation and scheduling dialogs
- Inputs, selectors, hover states and active states

Published reports remain isolated and continue using their Desktop-authored light or dark canvas.

### 3. Viewer zoom range and fitting

- Slider range is now 0–100%.
- Zoom buttons stop at 100%.
- Ctrl/mouse-wheel zoom stops at 100%.
- Fit Page and Fit Width never enlarge the authored canvas beyond 100%.
- Fit Page remains the initial optimal dashboard view.
- Clicking the percentage restores exactly 100%.

## Apply

1. Stop Reporting Services.
2. Copy this update over the existing Services source and replace matching files.
3. Run `npm run build:web` if deploying from source.
4. Restart/deploy Services.
5. Hard-refresh the browser once to remove the previous cached CSS and JavaScript bundles.

The package also contains the ready-built `dist-web` output.

## Verification

- Canvas/theme/zoom regressions: 7/7 passed.
- Services visual/theme parity: 9/9 passed.
- Visual formatting contracts: 78/78 passed.
- Published visual parity: passed.
- Services UI/export contracts: 5/5 passed.
- Production web build: passed.
