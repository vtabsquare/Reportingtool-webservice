import assert from 'node:assert/strict';
import fs from 'node:fs';

const viewer=fs.readFileSync('src/v11/PublishedViewer.tsx','utf8');
const schema=fs.readFileSync('src/visualFormattingSchema.ts','utf8');
const map=fs.readFileSync('src/components/AdvancedMapVisual.tsx','utf8');
const formatting=fs.readFileSync('src/components/FormattingWorkspace.tsx','utf8');
const deferredText=fs.readFileSync('src/components/DeferredTextInput.tsx','utf8');
const styles=fs.readFileSync('src/styles.css','utf8');

assert.match(viewer,/slicerPresentationStyle/,'published slicers must inherit the complete typography contract');
assert.match(viewer,/--slicer-font/,'published dropdowns must inherit slicer font family');
assert.match(viewer,/tileMinHeight/,'published tiles must grow for enlarged text');
assert.match(viewer,/const resolvedSlicerTypography/,'published slicers must resolve typography for nested controls');
assert.match(viewer,/className="slicerDropdownOptions customScrollbar" style=\{resolvedSlicerTypography\}/,'published dropdown option tray must receive resolved typography directly');
assert.match(viewer,/style=\{\{\.\.\.resolvedSlicerTypography,borderRadius:f\.slicerCornerRadius/,'published tile buttons must receive resolved typography directly');
assert.match(styles,/\.slicerVisual \.slicerDropdownTrigger[\s\S]*font-size:var\(--slicer-size/,'dropdown typography must use the shared slicer size');
assert.match(styles,/min-height:var\(--slicer-tile-min-height/,'tile buttons must use dynamic minimum height');
assert.match(styles,/justify-content:var\(--slicer-justify/,'tile alignment must follow slicer text alignment');

assert.doesNotMatch(schema,/map:\[[^\]]*mapLegend/,'map formatting must not expose a legend card');
assert.doesNotMatch(map,/vtabMapLegend/,'map renderer must not render the removed legend');
assert.match(schema,/map:\[mapType,mapSymbols,mapAreas,mapLabels\]/,'map formatting must retain all non-legend controls');

assert.match(formatting,/DeferredTextInput/,'format text properties must use deferred editing');
assert.match(formatting,/visual\.title=String\(value\?\?''\)/,'an intentionally empty title must be preserved');
assert.match(formatting,/Prefix<DeferredTextInput/,'number-format prefix text must use deferred editing');
assert.match(formatting,/Suffix<DeferredTextInput/,'number-format suffix text must use deferred editing');
assert.match(deferredText,/onBlur=\{event=>\{commit\(\)/,'text changes must commit on blur');
assert.match(deferredText,/draft!==text/,'text input must keep an independent draft while editing');

console.log('Slicer, map-legend removal, deferred text, and dynamic tile sizing contract passed.');

