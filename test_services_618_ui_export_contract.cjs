const fs = require('node:fs');
const assert = require('node:assert/strict');

const viewer = fs.readFileSync('src/v11/PublishedViewer.tsx', 'utf8');
const authority = fs.readFileSync('src/formatting-authority.css', 'utf8');
const server = fs.readFileSync('api/app/server.py', 'utf8');

const checks = [
  ['open published slicer wrapper escapes clipping', authority.includes('.viewerVisualWrapper:has(.viewerVisual-slicer.slicerDropdownOpen)')],
  ['open slicer body and contents escape clipping', authority.includes('.viewerVisual-slicer.slicerDropdownOpen .viewerVisualBody') && authority.includes('.viewerVisual-slicer.slicerDropdownOpen .viewerSlicerContents')],
  ['published wrapper supports canonical and legacy slicer style', viewer.includes("v.slicerStyle||(v.format as any)?.slicerStyle") && viewer.includes("publishedSlicerStyle==='dropdown'")],
  ['rendered export has direct service fallback', viewer.includes("apiDownload(`/published/${reportId}/export/${fmt}`")],
  ['direct export supports cloud-published reports', server.includes("(item or {}).get('project') or _get_cloud_project(report_id)")],
];

const failures = checks.filter(([, pass]) => !pass).map(([name]) => name);
for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
assert.deepEqual(failures, []);
console.log(`${checks.length}/${checks.length} Services 6.1.8 UI/export contracts passed`);
