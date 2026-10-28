const fs = require('fs');

const viewer = fs.readFileSync('src/v11/PaginatedReportViewer.tsx', 'utf8');
const pdf = fs.readFileSync('api/app/paginated_reports.py', 'utf8');

const checks = [
  ['automatic cascading parameters', 'effectiveDependencyIds'],
  ['dependent selections are cleared', 'dependentParameterIds'],
  ['child option queries include parent filters', 'dependencyFilters.push'],
  ['published images preserve fit', "objectFit:item.imageFit||'contain'"],
  ['published images preserve accessibility text', "item.altText||'Report image'"],
  ['unselected parameters render as All', "if(isEmpty(raw))return'All'"],
  ['published parameter pane clears filters', 'className="paginatedClearParameters"'],
  ['published line objects preserve authored thickness', 'item.lineWidth||item.borderWidth'],
  ['published text preserves vertical alignment', "item.verticalAlign==='bottom'"],
  ['published text preserves wrapping', "item.textWrap===false?'nowrap':'pre-wrap'"],
  ['published section text follows the Desktop canvas scale contract', 'propertyScale=scale/3.15'],
  ['published section text keeps Desktop color', "color:item.color||'#111827'"],
  ['published table applies saved formats', 'formatValue(rowValue(row,column.field),column.format)'],
  ['PDF applies saved formats', '_format_value(_row_value(row'],
  ['PDF accepts transparent object backgrounds', 'item.get("background") != "transparent"'],
  ['PDF line objects preserve authored thickness', 'item.get("lineWidth") or item.get("borderWidth")'],
];

const failures = checks.filter(([, needle]) => !(viewer.includes(needle) || pdf.includes(needle)));
if (failures.length) {
  console.error('Paginated publication parity contract failed:');
  failures.forEach(([label]) => console.error(`- ${label}`));
  process.exit(1);
}
console.log(`Paginated publication parity contract passed (${checks.length} checks).`);
