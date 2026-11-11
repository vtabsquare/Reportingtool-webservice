const fs=require('fs');
const path=require('path');
const root=__dirname;
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const services=read('src/services.tsx');
const resolver=read('src/uiPermissions.ts');
const viewer=read('src/v11/PublishedViewer.tsx');
const workspace=read('src/v11/CloudWorkspace.tsx');
const server=read('api/app/server.py');

function expect(condition,message){if(!condition)throw new Error(message)}

expect(services.indexOf('if(isEmbed && embedReportId)')<services.indexOf('if(!session)return'), 'External embed must bypass the interactive sign-in gate.');
expect(services.includes("vtabpublicuser@gmail.com"), 'External embed must use the dedicated public identity.');
expect(resolver.includes('findConfiguredPermission(map,userId,userEmail)'), 'Permission resolver must support UUID and email identities.');
expect(!resolver.includes('if(merged.all_commands===false)'), 'A partial profile must not collapse because all_commands is false.');
expect(viewer.includes("key==='all_commands'?permissions.all_commands!==false:permissions[key]!==false"), 'Ribbon commands must use their own permission flags.');
expect(viewer.includes('/embed-permissions'), 'Iframe must load public-user permissions.');
expect(viewer.includes('/ui-permissions'), 'Portal must load authoritative logged-in user permissions.');
expect(workspace.includes("activeWorkspace?.id === viewing.workspace_id"), 'Portal must not resolve a report against a stale workspace.');
expect(server.includes("@app.get('/api/v1/published/{report_id}/embed-permissions')"), 'Public iframe permission endpoint is missing.');
expect(server.includes("@app.get('/api/v1/published/{report_id}/ui-permissions')"), 'Authenticated portal permission endpoint is missing.');
expect(!server.includes("configured.get('all_commands', True) is False or configured.get(permission, True) is False"), 'Backend must enforce the requested command, not the summary switch.');
console.log('Admin/Services permission contract verified.');
