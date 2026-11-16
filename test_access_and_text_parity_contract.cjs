const fs=require('fs');
const assert=require('assert');

const permissions=fs.readFileSync('src/uiPermissions.ts','utf8');
const viewer=fs.readFileSync('src/v11/PublishedViewer.tsx','utf8');
const services=fs.readFileSync('src/services.tsx','utf8');
const server=fs.readFileSync('api/app/server.py','utf8');
const cloudWorkspace=fs.readFileSync('src/v11/CloudWorkspace.tsx','utf8');

assert(!permissions.includes('if(merged.all_commands===false)return'), 'all_commands must not disable individual permissions');
assert(viewer.includes("key==='all_commands'?permissions.all_commands!==false:permissions[key]!==false"), 'viewer must evaluate each command independently');
assert(server.includes("def published_ui_permissions"), 'report-specific permission endpoint is required');
assert(server.includes("if permissions.get(permission, True) is False"), 'backend must enforce the selected command only');
assert(services.indexOf('if(!session)return <SupabaseAuthGate')<services.indexOf('if(isEmbed && embedReportId)'), 'login must protect embedded reports');
assert(viewer.includes('publishedTextContent'), 'published text must use the Desktop-compatible inner text surface');
assert(viewer.includes('richTextRunsHtml(v.richTextRuns)'), 'formatted runs must survive publication');
assert(viewer.includes("fontSize:`${Number(f.fontSize??18)}px`"), 'saved font size must be emitted explicitly');
assert(viewer.includes("textAlign:f.textAlign??'left'"), 'saved text alignment must be emitted explicitly');
assert(!/initialItem=\{\{[^]*?\}\}\s*embedded\s*cloudMode/.test(cloudWorkspace), 'normal cloud report viewing must not force embedded restrictions');
assert(!cloudWorkspace.includes('workspacePermissions={userUiPermissions}'), 'stale navigation workspace permissions must not override report permissions');
assert(viewer.includes("if(allowed('can_view'))setActiveRibbonTab('View')"), 'a View-only user must land on the View ribbon');
assert(server.includes("sb.table('vtab_users').select('id').ilike('email', user_email)"), 'permission lookup must support authenticated identity aliases');
assert(server.includes("'can_view': ('view_ribbon',)"), 'legacy View ribbon permission keys must remain compatible');

console.log('Access, login, branding, and text parity contracts passed.');
