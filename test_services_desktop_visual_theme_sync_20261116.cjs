const fs = require('node:fs');
const assert = require('node:assert/strict');

const read = file => fs.readFileSync(file, 'utf8');
const chart = read('src/components/Chart.tsx');
const schema = read('src/visualFormattingSchema.ts');
const types = read('src/types.ts');
const viewer = read('src/v11/PublishedViewer.tsx');
const workspace = read('src/v11/CloudWorkspace.tsx');
const services = read('src/services.tsx');
const styles = read('src/styles.css');
const powerbi = read('src/powerbi.css');
const dax = read('api/app/dax_engine.py');
const semantic = read('api/app/semantic_engine.py');

const checks = [
  ['Services theme is persisted', services.includes('vtab-services-color-mode') && workspace.includes('localStorage.setItem(SERVICES_COLOR_MODE_KEY, colorMode)')],
  ['Services exposes an accessible theme switch', workspace.includes('pbi-theme-toggle') && workspace.includes('Switch to dark theme') && workspace.includes('Switch to light theme')],
  ['portal dark theme is scoped', powerbi.includes('html[data-color-mode="dark"] .servicesPortalShell')],
  ['published reports retain independent canvas themes', types.includes("canvasTheme?:'light'|'dark'") && viewer.includes('isDarkCanvas={s.canvasTheme')],
  ['advanced KPI appearance is synchronized', schema.includes("kpiTemplate','Template','trendCard'") && schema.includes("kpiSurfaceEnabled','Internal card background'") && chart.includes('compactSparklineStatus')],
  ['single and multi cards keep separate property models', schema.includes('card:[singleCardLayout') && schema.includes('multirowcard:[cardValue,multiCard')],
  ['tables persist per-column widths without pagination', types.includes('tableColumnWidths?:Record<string,number>') && chart.includes('tableColumnWidths:{...colWidthsRef.current}') && !chart.includes('premiumTablePager')],
  ['category colors avoid early repetition', chart.includes('distinctCategoryColors(values,palette,overrides)')],
  ['measure context fixes are present', dax.includes('apply_context_filters') && dax.includes('scalar_measure=') && semantic.includes('scalar-only requests to the single row')],
];

const failures = checks.filter(([, pass]) => !pass).map(([name]) => name);
for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
assert.deepEqual(failures, [], `${failures.length} Services visual/theme parity check(s) failed`);
console.log(`${checks.length}/${checks.length} Services visual/theme parity checks passed`);
