# VTAB Reporting Services — Published Visual Parity Fix

This is a Services-only, update-only package. It does not replace the full project.

## What was fixed

- Published visuals now treat the saved Desktop `backgroundEnabled` setting as authoritative.
- An explicitly disabled visual background renders as true transparency, never a white theme fallback.
- An explicitly disabled title background renders as true transparency, with no inherited border, rounding, or shadow.
- Saved border, per-edge border, corner radius, shadow, padding, typography, and title settings remain authoritative.
- Card, KPI, progress, slicer, textbox, and image visuals are protected from decorative Services fallbacks.
- Dropdown slicers retain the same saved size and placement while their menus can still open outside the visual.
- Image visuals now receive the same complete published-format contract as every other visual.
- Partial transparency uses browser-safe `rgba(...)` output for saved hex colors.
- Published visual wrappers no longer reuse the Desktop authoring-only `canvasObject` class.
- `borderVisible: false` now has a dedicated Services-viewer fail-safe that removes every border width, style, and outline.

## Root cause confirmed

A read-only check of the live published report showed that the backend already stores the Desktop settings correctly. For example, the affected cards, text boxes, and slicers contained `backgroundEnabled: false`, zero corner radius, disabled borders, and disabled shadows. The mismatch was introduced by Services frontend fallback styles overriding those valid values.

No backend replacement is included because changing the correctly working storage path would add unnecessary risk.

## Files to replace

- `src/v11/PublishedViewer.tsx`
- `src/formatting-authority.css`

## Installation

Recommended, from PowerShell:

```powershell
.\Install-Services-Update.ps1 -ServicesProject "D:\path\to\Reporting Tool Services"
```

The installer verifies the target, creates a timestamped backup under `.vtab-backups`, and copies only the two updated files.

Manual installation is also possible: copy the two files from this package to the same relative paths in the Services project.

Then rebuild and deploy the Services frontend:

```powershell
npm run build:web
```

## Verification

Run the included contract check from this package directory:

```powershell
node test_published_visual_parity_contract.cjs
```

After deployment, republish or reopen the existing test report and confirm:

1. The Global Sales cards have no background where Desktop has no background.
2. The report title/text box is not placed inside a white rounded Services container.
3. Country, State Province, City, and Category dropdown slicers sit directly on the blue panel, matching Desktop.
4. Saved colors, sizes, padding, borders, corners, shadows, and title backgrounds match the Desktop report.

Existing published metadata does not need migration or republishing for this renderer fix.
