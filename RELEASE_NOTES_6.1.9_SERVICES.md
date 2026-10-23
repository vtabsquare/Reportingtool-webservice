# VTAB Reporting Services 6.1.9

## Desktop-to-Services publication parity

- Published interactive reports now open in **Fit report** mode, matching the Desktop designer and keeping the complete saved canvas visible without unnecessary page scrollbars.
- Modern pixel-positioned reports no longer receive the legacy Services dashboard-header overlay. Title text boxes, backgrounds, colors, sizes, and positions now come from the exact visuals saved by Desktop.
- Multi-row card density is now based on the saved visual container height rather than the browser window width. This removes breakpoint-dependent card growth and the resulting internal scrollbar.
- Existing Services 6.1.8 dropdown-popover and PDF/PPT export fallback fixes are preserved.

## Verification

- Workspace production build: passed.
- Published visual parity regression tests: 6 passed.
- Shared visual-formatting contract: 75 passed.

After deployment, republish the report from Desktop so Services receives the newest saved report snapshot.
