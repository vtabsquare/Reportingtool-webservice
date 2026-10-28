const fs = require('fs');

const viewer = fs.readFileSync('src/v11/PublishedViewer.tsx', 'utf8');
const styles = fs.readFileSync('src/styles.css', 'utf8');
const workspace = fs.readFileSync('src/v11/CloudWorkspace.tsx', 'utf8');

const checks = [
  ['published shadows keep horizontal offset', 'f.shadowOffsetX??0'],
  ['published shadows keep vertical offset', 'f.shadowOffset??8'],
  ['published shadows keep blur', 'f.shadowBlur??24'],
  ['published shadows keep opacity', '${shadowOpacity}%, transparent'],
  ['pixel objects retain exact authored width and height', 'left:v.x,top:v.y,width:v.w,height:v.h'],
  ['pixel visual wrappers fill the authored rectangle', '.viewerGrid>.viewerPixelObject>.viewerVisual{width:100%;height:100%'],
  ['pixel visual effects retain the saved shadow', 'box-shadow:var(--viewer-shadow,var(--visual-shadow,none))!important'],
  ['workspace reports are ordered newest first', "new Date(b.updated_at||b.published_at||0).getTime()-new Date(a.updated_at||a.published_at||0).getTime()"],
];

const failures = checks.filter(([, needle]) => !(viewer.includes(needle) || styles.includes(needle) || workspace.includes(needle)));
if (failures.length) {
  console.error('Published visual parity contract failed:');
  failures.forEach(([label]) => console.error(`- ${label}`));
  process.exit(1);
}
console.log(`Published visual parity contract passed (${checks.length} checks).`);
