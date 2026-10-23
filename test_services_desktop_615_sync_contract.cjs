const fs = require('node:fs');
const assert = require('node:assert/strict');

const read = path => fs.readFileSync(path, 'utf8');
const chart = read('src/components/Chart.tsx');
const viewer = read('src/v11/PublishedViewer.tsx');
const schema = read('src/visualFormattingSchema.ts');
const colors = read('src/categoryColors.ts');
const semantic = read('api/app/semantic_engine.py');
const server = read('api/app/server.py');

const checks = [
  ['v2 semantic engine is the published-query compiler', semantic.includes('from .dax_v2 import analyze_measure') && semantic.includes('compile_for_duckdb')],
  ['AI measure generation is absent from Services', !server.includes("@app.post('/api/v1/measures/ai-generate')") && !server.includes('suggest_measure_from_prompt')],
  ['category colors are stable by category identity', colors.includes('stableCategoryColor') && colors.includes('Math.imul') && chart.includes('stableCategoryColor(cat, palette)')],
  ['legend series use persistent category colors', chart.includes('color:categoryColor(sn,si,0)') && schema.includes("title:'Legend and category colors'")],
  ['published slicers consume desktop typography', viewer.includes("'--slicer-size':`${f.tableFontSize||11}px`") && viewer.includes('slicerTileButton')],
  ['Services keeps independent slicer filters', viewer.includes('interactionFilterMap') && viewer.includes('handleCrossFilter') && viewer.includes('activeFilter={activeFilter}')],
  ['dropdown slicers remain visible outside their visual frame', viewer.includes("overflow:(v.type==='slicer'&&v.slicerStyle==='dropdown')?'visible':'hidden'")],
  ['workspace and report access migration is packaged', fs.existsSync('api/supabase_migrations/019_workspace_report_access_and_provisioning.sql')],
];

const failures = checks.filter(([, pass]) => !pass).map(([name]) => name);
for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
assert.deepEqual(failures, [], `${failures.length} Services/Desktop sync contract(s) failed`);
console.log(`${checks.length}/${checks.length} Services/Desktop 6.1.5 sync contracts passed`);

