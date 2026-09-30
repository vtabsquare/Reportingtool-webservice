# Reporting Services 5.2.6 — Loading Overlay Fix

## Corrected behavior

The “Preparing visuals” notification is now positioned as an overlay at the top-center of the report area. It no longer participates in the report stage's horizontal flex layout, so it cannot occupy the left side or push the report canvas to the right.

Per-visual loading placeholders, page batching, snapshot caching and the other 5.2.5 performance improvements are unchanged.

## Apply the update

Copy the supplied files into the matching locations in your existing Reporting Services 5.2.5 source folder and replace the old files. Then rebuild and redeploy:

```text
npm install
npm run build:web
```

Restart or redeploy the API as well if you want `/api/v1/health` to report version 5.2.6.

## Verification

1. Open a published report.
2. Press Refresh or change a slicer so the page reloads.
3. “Preparing visuals” should appear centered near the top of the report area.
4. The report canvas must remain centered and retain its full width while loading.
5. Once data is ready, the overlay should disappear without moving the canvas.
