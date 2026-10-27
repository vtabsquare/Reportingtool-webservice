const fs = require('node:fs');
const assert = require('node:assert/strict');

const viewer = fs.readFileSync('src/v11/PublishedViewer.tsx', 'utf8');
const css = fs.readFileSync('src/formatting-authority.css', 'utf8');

assert.match(viewer, /data-visual-background=\{backgroundOn\?'on':'off'\}/);
assert.match(viewer, /data-title-background=\{titleBackgroundOn\?'on':'off'\}/);
assert.match(viewer, /data-visual-border=\{f\.borderVisible\?'on':'off'\}/);
assert.match(viewer, /viewerPixelObject/);
assert.doesNotMatch(viewer, /className=\{`viewerVisualWrapper \$\{v\.geometryVersion===2\?'canvasObject'/);
assert.match(viewer, /const background=publishedColor\(bg,transparency\)/);
assert.match(viewer, /const titleBackgroundOn=.*titleBackground=publishedColor\(titleBg,titleTransparency\)/);
assert.match(viewer, /'--viewer-background':background/);
assert.match(viewer, /'--visual-title-radius':titleRadius/);

assert.match(css, /\.viewerVisual\[data-visual-background="off"\]\{background:transparent!important/);
assert.match(css, /\.viewerVisual\[data-title-background="off"\] \.viewerVisualTitle\{background:transparent!important/);
assert.match(css, /\.publishedViewer \.viewerVisual\[data-visual-border="off"\]\{border:0!important/);
assert.match(css, /\.publishedViewer \.viewerVisualWrapper\.viewerPixelObject\{background:transparent!important/);
assert.match(css, /border-radius:var\(--visual-title-radius,0\)!important/);
assert.match(css, /backdrop-filter:var\(--visual-backdrop,none\)!important/);

console.log('Published visual parity contract verified.');
