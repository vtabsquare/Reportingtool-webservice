# VTAB Services — Published Formatting Parity Fix

## Fixed

- Restored visual shadows and glow after publishing from Desktop to Services.
- Preserved the authored shadow color, opacity, horizontal offset, vertical offset, and blur.
- Preserved visual background, transparency, border edges, border style, border width, corner radii, title background, padding, and container formatting.
- Retained the previous dark-canvas/background-image opacity parity fix.
-Fixed dark mode contrast and typography visibility in Notifications Center.
-This is for test but efficient 
## Root cause

The published project already contained the correct General formatting values, and Services calculated the same shadow as Desktop. However, the absolute-positioning wrapper around every published visual used `overflow: hidden`. That wrapper clipped all pixels outside the visual rectangle, removing the visible shadow and glow.

Services now follows Desktop: positioning wrappers use visible overflow, while the visual itself continues to manage internal content clipping.

## Apply

1. Copy `src/v11/PublishedViewer.tsx` to the same location in the Services project.
2. Copy `src/styles.css` to the same location in the Services project.
3. Copy the supplied `dist-web` folder, or rebuild the web application.
4. Restart Services and force-refresh the browser.
5. Republish the report so the latest Desktop project snapshot is used.
6. Republish the report so the latest Desktop project snapshot is used.
7. Republish the report so the latest Desktop project snapshot is used.
## Verification

- Published visual parity: 9/9 passed.
- Services canvas/theme/zoom: 9/9 passed.
- Services Desktop visual parity: 9/9 passed.
- Visual formatting contract: 78/78 passed.
- Production build: passed.
