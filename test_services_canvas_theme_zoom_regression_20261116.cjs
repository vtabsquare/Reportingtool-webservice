const fs = require('node:fs');
const assert = require('node:assert/strict');

const viewer = fs.readFileSync('src/v11/PublishedViewer.tsx','utf8');
const workspace = fs.readFileSync('src/v11/CloudWorkspace.tsx','utf8');
const styles = fs.readFileSync('src/styles.css','utf8');
const powerbi = fs.readFileSync('src/powerbi.css','utf8');

const checks = [
  ['published page background remains authoritative', viewer.includes("'--published-page-background':publishedPageBackground") && styles.includes('.viewerPage.pixelPublishedPage{background:var(--published-page-background,transparent)!important}')],
  ['dark canvas uses the same base layer as Desktop', viewer.includes("import {DARK_REPORT_THEME,isColorDark}") && viewer.includes("s.canvasTheme==='dark'?DARK_REPORT_THEME.canvas") && viewer.includes("data-canvas-theme={isPublishedDarkCanvas?'dark':'light'}")],
  ['saved image opacity is composited above the canvas base', viewer.includes("opacity:(s.backgroundImageOpacity!==undefined?s.backgroundImageOpacity:100)/100")],
  ['pixel visual bodies do not add a white wash', styles.includes('.pixelPublishedPage .viewerPageLayer,.pixelPublishedPage .viewerGrid,.pixelPublishedPage .viewerVisualBody{background:transparent!important}')],
  ['zoom slider is limited to 0 through 100', viewer.includes('min={0}') && viewer.includes('max={100}') && !viewer.includes('max={300}')],
  ['fit and wheel zoom never enlarge beyond 100 percent', viewer.includes('Math.min(1,next)') && viewer.includes('Math.min(1,Math.round(prev*factor*100)/100)')],
  ['portal and published viewer themes are isolated', workspace.includes('pbi-app-shell servicesPortalShell') && powerbi.includes('.servicesPortalShell')],
  ['dark portal covers navigation, content, cards and tables', powerbi.includes('.servicesPortalShell .pbi-topbar') && powerbi.includes('.servicesPortalShell .pbi-canvas') && powerbi.includes('.servicesPortalShell .pbi-quick-card') && powerbi.includes('.servicesPortalShell .pbi-table td')],
  ['dark portal covers menus, notifications and dialogs', workspace.includes('pbi-help-menu') && workspace.includes('pbi-user-menu') && powerbi.includes('.servicesPortalShell .vtabNotificationPanel') && powerbi.includes('.servicesPortalShell .vtabAutomationDialog')],
];

const failures = checks.filter(([,pass])=>!pass).map(([name])=>name);
for(const [name,pass] of checks) console.log(`${pass?'PASS':'FAIL'} ${name}`);
assert.deepEqual(failures,[],`${failures.length} Services canvas/theme/zoom regression check(s) failed`);
console.log(`${checks.length}/${checks.length} Services canvas/theme/zoom regression checks passed`);
