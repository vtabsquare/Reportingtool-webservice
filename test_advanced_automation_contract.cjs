const fs = require('fs');
const assert = require('assert');

const read = p => fs.readFileSync(p, 'utf8');
const migration = read('api/supabase_migrations/020_advanced_report_automation.sql');
const platform = read('api/app/automation_platform.py');
const service = read('api/app/automation_service.py');
const server = read('api/app/server.py');
const dialog = read('src/v11/ReportAutomationDialog.tsx');
const settings = read('src/v11/NotificationSettingsDialog.tsx');

for (const table of ['automation_workspace_policies','automation_workflows','automation_workflow_versions','automation_executions','automation_execution_steps','automation_delivery_records','automation_audit_log']) {
  assert(migration.includes(table), `migration missing ${table}`);
}
assert(platform.includes('Only the workspace owner can change automation availability.'));
assert(platform.includes('idempotency_key'));
assert(platform.includes('execute_workflow_execution'));
assert(server.includes("authorization:str|None=Header(default=None)"));
assert(server.includes('/api/v1/service/automation/workspaces/{workspace_id}/policy'));
assert(service.includes('silently expand a subscription to every workspace member'));
assert(dialog.includes('Owner access policy'));
assert(dialog.includes('After successful refresh'));
assert(dialog.includes('threshold_secondary'));
assert(settings.includes('Workflow Manager'));
assert(settings.includes('Execution') || settings.includes('History'));
console.log('Advanced automation contract passed.');
