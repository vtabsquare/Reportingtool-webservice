# PROMPT: VTAB Reporting Manager Feature Enhancements (CODEX EXECUTION READY)

> **Instructions for AI / Codex**:  
> You are an expert full-stack engineer implementing targeted enhancements for the **VTAB Reporting Manager** codebase.  
> You must follow the instructions below with absolute precision.  
> **CRITICAL REQUIREMENT**: Strictly preserve 100% of existing functionality. Do not break, remove, or alter existing webhook endpoints, database tables, connector authentication (`X-VTAB-Agent-Token`), deployment state machine rules, or client update polling contracts.

---

## 1. Context & Architectural Overview

The **VTAB Reporting Manager** (`VTAB Reporting Manager/`) is a FastAPI + Vanilla JS control plane responsible for managing releases, tracking client environments, dispatching update webhooks, and monitoring deployment health for two core components:
1. `services` (`Reportingtool-webservice`)
2. `administration` (`Reporting-admin`)

### Core Files to Modify:
- **`manager/main.py`**: FastAPI route handlers, API endpoints, GitHub sync orchestration.
- **`manager/database.py`**: SQLite / Supabase PostgreSQL database abstraction layer.
- **`manager/contracts.py`**: Pydantic data schemas.
- **`manager/static/app.js`**: Frontend state management, rendering routines, event listeners.
- **`manager/static/index.html`**: Modal dialog structures and dialog templates.
- **`manager/static/styles.css`**: Styling for table views, badges, live tags, and view toggles.

---

## 2. Invariance & Safety Rules (DO NOT BREAK)

1. **Connector API Contract**: Endpoints `/api/v1/agent/*` must remain completely intact.
2. **Client Webhooks**: When an update is offered, webhooks dispatched to clients (`/api/v1/update/webhook` or `/api/update/webhook`) must retain the exact JSON structure:
   ```json
   {
     "deployment_id": "...",
     "component": "services|administration",
     "version": "commit-<sha>",
     "commit_sha": "<40-char-sha>",
     "release_notes": "...",
     "created_at": "..."
   }
   ```
3. **Database Schema Non-Destructive**: All SQL schema additions must use `IF NOT EXISTS` or safe fallback checks. Never drop existing tables or alter existing column constraints.

---

## 3. Detailed Specifications for the 8 Enhancements

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             8 CORE REQUIREMENTS                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 1. Inbound Commit Approval Gate in Deployments (Approve / Reject workflow)       │
│ 2. Audit Trail CSV Export in Settings                                            │
│ 3. Client Environments: Toggle Card View / Table View + Delete Client Option    │
│ 4. "Select All" Button in Offer Update Dialog                                   │
│ 5. Remove Category Pill Filter Buttons from Offer Update Dialog                  │
│ 6. Strictly ONE "LIVE" Tag per Component (dynamically moves to latest deployed) │
│ 7. One-Click Rollback Option to Previous Live Commit                             │
│ 8. "NEW" Tag on Latest Inbound Commit                                            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### FEATURE 1: Inbound Commit Approval Gate in Deployments

#### Goal:
When a new commit is synchronized from GitHub or received via webhook, it must **NOT** immediately show up as an available release in the **Release Catalog**. Instead, it must first appear in the **Deployments** view under an **"Incoming Commits for Approval"** section. Once an operator clicks **Approve**, the commit moves into the Release Catalog as deployable. If **Reject** is clicked, the commit is marked rejected and hidden from deployable releases.

#### Implementation Details:

1. **Backend (`manager/main.py`):**
   - When registering a release from GitHub in `register_release_candidate()`:
     - Set `status = "pending_approval"`
     - Set `validation_status = "pending"`
     - Set `validation_details_json = json.dumps({"approved": False, "source": "git_commit", "author": author})`
   - Ensure the approval endpoint exists:
     ```python
     @app.post("/api/v1/operator/releases/{release_id}/approve")
     def approve_release_commit(release_id: str, actor: OperatorIdentity = Depends(require_operator)):
         authorize(actor, {"super_admin", "release_manager", "operator"})
         release = release_or_404(release_id)
         now = utc_now()
         details = json_value(release.get("validation_details_json"), {})
         if isinstance(details, str):
             try: details = json.loads(details)
             except Exception: details = {}
         details["approved"] = True
         details["approved_by"] = str(actor)
         details["approved_at"] = now
         db.execute(
             "UPDATE releases SET status='available', validation_status='approved', validation_details_json=?, updated_at=? WHERE id=?",
             (json.dumps(details), now, release_id)
         )
         db.audit(str(actor), "release.approved", "release", release_id, details={"component": release["component"], "version": release["version"]})
         return {"ok": True, "release": serialize_row(release_or_404(release_id))}
     ```
   - Ensure the rejection endpoint exists:
     ```python
     @app.post("/api/v1/operator/releases/{release_id}/reject")
     def reject_release_commit(release_id: str, actor: OperatorIdentity = Depends(require_operator)):
         authorize(actor, {"super_admin", "release_manager", "operator"})
         release = release_or_404(release_id)
         now = utc_now()
         details = json_value(release.get("validation_details_json"), {})
         if isinstance(details, str):
             try: details = json.loads(details)
             except Exception: details = {}
         details["approved"] = False
         details["rejected_by"] = str(actor)
         details["rejected_at"] = now
         db.execute(
             "UPDATE releases SET status='rejected', validation_status='rejected', validation_details_json=?, updated_at=? WHERE id=?",
             (json.dumps(details), now, release_id)
         )
         db.audit(str(actor), "release.rejected", "release", release_id, details={"component": release["component"], "version": release["version"]})
         return {"ok": True, "release": serialize_row(release_or_404(release_id))}
     ```

2. **Frontend (`manager/static/app.js`):**
   - In `renderDeployments()`, insert the `renderPendingCommitsPanel()` immediately above the `Deployment history` table:
     ```javascript
     function renderDeployments(){
       return `${viewTitle('Deployment operations','Create plans, collect client approval, and monitor the complete rollout history')}
     <div class="workflow-banner">
       <div class="workflow-step done"><span>1</span><div><b>Choose client</b><small>Existing or new</small></div></div><i></i>
       <div class="workflow-step"><span>2</span><div><b>Select release</b><small>Published artifacts</small></div></div><i></i>
       <div class="workflow-step"><span>3</span><div><b>Client approval</b><small>Required gate</small></div></div><i></i>
       <div class="workflow-step"><span>4</span><div><b>Deploy & validate</b><small>Health reported</small></div></div>
     </div>
     ${renderPendingCommitsPanel()}
     ${panel('Deployment history','Offered, active, completed, and rolled-back jobs',deploymentTable(state.deployments,false))}`;
     }
     ```
   - The pending commits panel filters `state.releases` for `r.status === 'pending_approval' || (r.validation_status === 'pending' && r.status !== 'rejected')`.
   - Each row displays:
     - Component (`Services` or `Administration`)
     - Commit SHA link to GitHub
     - Commit message
     - Author
     - Committed date
     - Status: `<span class="badge amber">Pending Approval</span>`
     - Action buttons:
       - **✓ Approve** (`data-approve-commit="${commit.id}"`)
       - **✕ Reject** (`data-reject-commit="${commit.id}"`)
   - In `renderReleases()`, the Release Catalog only renders approved, non-pending releases:
     ```javascript
     const deployable = (state.releases || []).filter(r => r.status !== 'pending_approval' && r.status !== 'rejected');
     ```

---

### FEATURE 2: Export Audit Trail to CSV

#### Goal:
In **Settings -> Audit trail**, add a prominent **"Export CSV"** button that instantly generates and downloads an RFC 4180 compliant CSV file of the audit logs.

#### Implementation Details:

1. **Frontend (`manager/static/app.js`):**
   - Update `renderSettings()` to include the Export button in the panel header:
     ```javascript
     ${panel(
       'Audit trail',
       'Release, deployment, ticket, and connector events',
       auditTable(state.audit),
       'audit-panel',
       `<button class="secondary view-action" data-export-audit-csv>${icon('download')} Export CSV</button>`
     )}
     ```
   - Add the CSV exporter function in `app.js`:
     ```javascript
     function exportAuditToCsv() {
       if (!state.audit || !state.audit.length) {
         return notify('No audit trail records to export.', true);
       }
       const headers = ['Time', 'Actor', 'Action', 'Object Type', 'Object ID', 'Details'];
       const rows = state.audit.map(row => {
         const time = stamp(row.created_at) || row.created_at || '';
         const actor = (row.actor || '').replace(/"/g, '""');
         const action = (row.action || '').replace(/"/g, '""');
         const objType = (row.object_type || '').replace(/"/g, '""');
         const objId = (row.object_id || '').replace(/"/g, '""');
         const details = JSON.stringify(row.details || {}).replace(/"/g, '""');
         return `"${time}","${actor}","${action}","${objType}","${objId}","${details}"`;
       });
       const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
       const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
       const url = URL.createObjectURL(blob);
       const link = document.createElement('a');
       const dateStr = new Date().toISOString().slice(0, 10);
       link.setAttribute('href', url);
       link.setAttribute('download', `vtab_manager_audit_trail_${dateStr}.csv`);
       document.body.appendChild(link);
       link.click();
       document.body.removeChild(link);
       URL.revokeObjectURL(url);
       notify('Audit trail exported successfully!');
     }
     ```
   - In `bindActions()`:
     ```javascript
     const exportBtn = document.querySelector('[data-export-audit-csv]');
     if (exportBtn) exportBtn.onclick = exportAuditToCsv;
     ```

---

### FEATURE 3: Client Environments Card View & Table View Toggle + Delete Client

#### Goal:
1. Allow switching between the existing **Card Grid View** and a clean **Table View** on the Clients page.
2. Provide a **Delete Client** option in both views (with safe confirmation modal and cascading cleanup).

#### Implementation Details:

1. **Backend (`manager/main.py`):**
   - Add endpoint `DELETE /api/v1/operator/clients/{client_id}`:
     ```python
     @app.delete("/api/v1/operator/clients/{client_id}")
     def delete_client(client_id: str, actor: OperatorIdentity = Depends(require_operator)):
         authorize(actor, {"super_admin", "operator"})
         client = client_or_404(client_id)
         now = utc_now()
         db.execute("DELETE FROM deployment_locks WHERE client_id=?", (client_id,))
         db.execute("DELETE FROM client_agents WHERE client_id=?", (client_id,))
         db.execute("DELETE FROM deployments WHERE client_id=?", (client_id,))
         db.execute("DELETE FROM clients WHERE id=?", (client_id,))
         db.audit(str(actor), "client.deleted", "client", client_id, client_id, {"code": client.get("code"), "name": client.get("name")})
         return {"ok": True, "deleted_client_id": client_id}
     ```

2. **Frontend State & Views (`manager/static/app.js`):**
   - Add state variable: `let clientViewMode = 'grid'; // 'grid' | 'table'`
   - Update `renderClients()`:
     ```javascript
     function renderClients(){
       const actions = `
         <div class="row-actions">
           <div class="view-toggle-group" style="display:inline-flex;background:rgba(255,255,255,0.05);padding:2px;border-radius:6px;margin-right:8px;">
             <button class="toggle-btn ${clientViewMode==='grid'?'active':''}" data-client-view="grid" style="padding:4px 10px;font-size:12px;border:none;border-radius:4px;cursor:pointer;background:${clientViewMode==='grid'?'var(--cyan,#00f2fe)':'transparent'};color:${clientViewMode==='grid'?'#000':'var(--text-dim,#888)'};font-weight:600;">Cards</button>
             <button class="toggle-btn ${clientViewMode==='table'?'active':''}" data-client-view="table" style="padding:4px 10px;font-size:12px;border:none;border-radius:4px;cursor:pointer;background:${clientViewMode==='table'?'var(--cyan,#00f2fe)':'transparent'};color:${clientViewMode==='table'?'#000':'var(--text-dim,#888)'};font-weight:600;">Table</button>
           </div>
           <button class="secondary view-action" data-open-client>${icon('plus')} Register client</button>
         </div>`;
       const body = clientViewMode === 'table' ? clientTableView(state.clients) : clientTable(state.clients);
       return `${viewTitle('Client environments','Operational targets remain separate from their deployment history',actions)}${panel('Environment registry','Installed versions, database providers, and connector health',body)}`;
     }
     ```
   - Create `clientTableView(rows)`:
     ```javascript
     function clientTableView(rows){
       if(!rows.length) return empty('No client environments registered.',`<button class="text-action" data-open-deployment>Register one in a deployment</button>`);
       return `<div class="table-wrap"><table>
         <thead>
           <tr>
             <th>Client Name</th>
             <th>Code</th>
             <th>Environment</th>
             <th>Database</th>
             <th>Connector Health</th>
             <th>Reporting Services</th>
             <th>Administration</th>
             <th style="text-align:right;">Actions</th>
           </tr>
         </thead>
         <tbody>
           ${rows.map(row=>`<tr>
             <td><strong>${esc(row.name)}</strong></td>
             <td><span class="version-chip">${esc(row.code)}</span></td>
             <td>${badge(row.environment)}</td>
             <td><small>${esc(row.database_provider || 'supabase')}</small></td>
             <td><span class="health ${esc(row.last_health_status || 'unknown')}"><i></i>${esc(row.last_health_status || 'unknown')}</span></td>
             <td><small>${esc(row.installed_services_version || 'Not reported')}</small></td>
             <td><small>${esc(row.installed_admin_version || 'Not reported')}</small></td>
             <td style="text-align:right;">
               <div class="row-actions" style="justify-content:flex-end;gap:6px;">
                 <button class="table-action" data-configure-client="${row.id}">${icon('settings')} Edit</button>
                 <button class="table-action" data-delete-client="${row.id}" style="color:#ef4444;border-color:rgba(239,68,68,0.35);">Delete</button>
               </div>
             </td>
           </tr>`).join('')}
         </tbody>
       </table></div>`;
     }
     ```
   - Add delete client handler in `app.js`:
     ```javascript
     async function deleteClientAction(clientId) {
       const client = (state.clients || []).find(c => c.id === clientId);
       const name = client ? client.name : clientId;
       if (!confirm(`Are you sure you want to delete client environment "${name}"? This action cannot be undone.`)) return;
       try {
         notify(`Deleting client ${name}...`);
         await api(`/api/v1/operator/clients/${clientId}`, { method: 'DELETE' });
         notify(`Client ${name} deleted successfully.`);
         await loadAll();
       } catch (err) {
         notify(err.message, true);
       }
     }
     ```
   - In `bindActions()`:
     ```javascript
     document.querySelectorAll('[data-client-view]').forEach(btn => {
       btn.onclick = () => {
         clientViewMode = btn.dataset.clientView;
         render();
       };
     });
     document.querySelectorAll('[data-delete-client]').forEach(btn => {
       btn.onclick = () => deleteClientAction(btn.dataset.deleteClient);
     });
     ```

---

### FEATURE 4 & 5: Clean Offer Dialog — Remove Filter Pills & Add "Select All"

#### Goal:
In the **"Offer release to client companies"** dialog box (`#offerDialog`):
1. **Remove the category filter pills**: Delete the `[All (21)]`, `[Production]`, `[Staging]`, `[Healthy]` buttons.
2. **Add a prominent "Select All" button**: Replace "Select visible" with a clear "Select All" button that toggles all client companies with a single click.

#### Implementation Details:

1. **Markup (`manager/static/index.html`):**
   - Locate the `<div class="offer-filter-group" id="offerFilterGroup">` block (lines ~126-131) and **remove it entirely**.
   - In `<div class="selection-quick-actions">`, replace the actions with:
     ```html
     <div class="selection-quick-actions">
       <button type="button" class="text-action" id="offerSelectAllBtn" style="color:var(--cyan-strong,#38bdf8);font-weight:700;">Select All</button>
       <span class="divider">•</span>
       <button type="button" class="text-action" id="offerDeselectAllBtn">Clear selection</button>
     </div>
     ```

2. **JavaScript Logic (`manager/static/app.js`):**
   - In `openOfferDialog(releaseId)`:
     - Remove references to `#offerFilterGroup` element to prevent null pointer exceptions:
       ```javascript
       offerFilterMode = 'all';
       ```
   - Wire up `#offerSelectAllBtn`:
     ```javascript
     const selectAllBtn = $('offerSelectAllBtn');
     if (selectAllBtn) {
       selectAllBtn.onclick = () => {
         const eligibleClients = (state.clients || []).filter(c => {
           if (!offerSearchQuery) return true;
           const q = offerSearchQuery.toLowerCase();
           return (c.name || '').toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q);
         });
         eligibleClients.forEach(c => selectedOfferClientIds.add(c.id));
         renderOfferClientList();
       };
     }
     ```

---

### FEATURE 6: Strictly ONE "LIVE" Tag per Component

#### Goal:
Mark the release that is currently running in production with a vibrant **"● LIVE"** tag. When a newly offered commit finishes deployment on the client, the `LIVE` tag must immediately shift to the new commit. **There must strictly be only ONE release with the `LIVE` tag per component at any time.**

#### Implementation Details:

1. **Deriving the Active Live Release (`manager/static/app.js`):**
   - For any component (`services` or `administration`), compute the Live release by finding the most recent successfully completed deployment:
     ```javascript
     function getLiveReleaseIdForComponent(component) {
       const completedDeployments = (state.deployments || [])
         .filter(d => (d.status === 'succeeded' || d.status === 'completed') && (d.component || 'services') === component)
         .sort((a, b) => new Date(b.created_at || b.updated_at || 0) - new Date(a.created_at || a.updated_at || 0));
       
       if (completedDeployments.length && completedDeployments[0].release_id) {
         return completedDeployments[0].release_id;
       }
       
       // Fallback: Check if client environments report a specific target SHA/version
       const client = (state.clients || [])[0];
       if (client) {
         const reportedVer = component === 'services' ? client.installed_services_version : client.installed_admin_version;
         if (reportedVer) {
           const match = (state.releases || []).find(r => r.component === component && (
             r.version === reportedVer ||
             `v${r.version}` === reportedVer ||
             (r.git_commit_sha && reportedVer.includes(r.git_commit_sha.slice(0, 7)))
           ));
           if (match) return match.id;
         }
       }
       return null;
     }
     ```

2. **Rendering in `releaseTable(rows)`:**
   - In `releaseTable(rows)`:
     ```javascript
     const liveServicesId = getLiveReleaseIdForComponent('services');
     const liveAdminId = getLiveReleaseIdForComponent('administration');

     // Inside rows.map(row => { ... })
     const isLive = (row.component === 'services' && row.id === liveServicesId) ||
                    (row.component === 'administration' && row.id === liveAdminId);

     const liveBadge = isLive 
       ? `<span class="badge green live-tag" style="background:rgba(16,185,129,0.18);border:1px solid #10b981;color:#10b981;font-weight:700;display:inline-flex;align-items:center;gap:4px;margin-left:6px;"><i style="width:6px;height:6px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 2s infinite;"></i>LIVE</span>`
       : '';
     ```
   - Render `liveBadge` directly next to the Version chip or Commit chip:
     ```html
     <td><span class="version-chip">v${esc(row.version)}</span>${liveBadge}</td>
     ```

---

### FEATURE 7: One-Click Rollback to Previous Live Commit

#### Goal:
Provide a **"Rollback"** button on the commit that was live **immediately prior** to the current Live version. Clicking this button immediately opens the Offer dialog pre-loaded with this previous version, so when the client user clicks "Update Now", the system rolls back to that previous commit seamlessly.

#### Implementation Details:

1. **Identifying the Previous Live Release (`manager/static/app.js`):**
   ```javascript
   function getPreviousLiveReleaseIdForComponent(component) {
     const liveId = getLiveReleaseIdForComponent(component);
     const completedDeployments = (state.deployments || [])
       .filter(d => (d.status === 'succeeded' || d.status === 'completed') && (d.component || 'services') === component)
       .sort((a, b) => new Date(b.created_at || b.updated_at || 0) - new Date(a.created_at || a.updated_at || 0));

     // Find the first completed deployment with a DIFFERENT release_id than the current live
     const prevDep = completedDeployments.find(d => d.release_id && d.release_id !== liveId);
     if (prevDep) return prevDep.release_id;

     // Fallback: Previous available release in the chronological release catalog
     const compReleases = (state.releases || [])
       .filter(r => r.component === component && r.status === 'available')
       .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
     const liveIdx = compReleases.findIndex(r => r.id === liveId);
     if (liveIdx !== -1 && compReleases[liveIdx + 1]) {
       return compReleases[liveIdx + 1].id;
     }
     return null;
   }
   ```

2. **Rendering the Rollback Action:**
   - In `releaseTable(rows)`, for the release matching `prevLiveId`:
     ```javascript
     const prevLiveServicesId = getPreviousLiveReleaseIdForComponent('services');
     const prevLiveAdminId = getPreviousLiveReleaseIdForComponent('administration');

     const isRollbackTarget = (row.component === 'services' && row.id === prevLiveServicesId) ||
                              (row.component === 'administration' && row.id === prevLiveAdminId);

     const rollbackBtn = isRollbackTarget
       ? `<button class="table-action" data-rollback-release="${row.id}" style="color:#f59e0b;border-color:rgba(245,158,11,0.5);font-weight:600;display:inline-flex;align-items:center;gap:4px;" title="Rollback clients to this prior stable commit">
            ↺ Rollback
          </button>`
       : '';
     ```
   - In `bindActions()`:
     ```javascript
     document.querySelectorAll('[data-rollback-release]').forEach(btn => {
       btn.onclick = () => {
         const relId = btn.dataset.rollbackRelease;
         if (confirm('Initiate a rollback update to this previous version for your client environments?')) {
           offerRelease(relId);
         }
       };
     });
     ```

---

### FEATURE 8: "NEW" Tag on Latest Synced Commit

#### Goal:
Highlight the most recently synced commit for each component with a prominent **`NEW`** tag so operators can instantly identify incoming changes.

#### Implementation Details:

1. **Identifying Newest Release (`manager/static/app.js`):**
   ```javascript
   function getNewestReleaseIdForComponent(component) {
     const compReleases = (state.releases || [])
       .filter(r => r.component === component)
       .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
     return compReleases.length ? compReleases[0].id : null;
   }
   ```

2. **Rendering in Pending Commits & Release Catalog:**
   - For the newest release in each table:
     ```javascript
     const newestServicesId = getNewestReleaseIdForComponent('services');
     const newestAdminId = getNewestReleaseIdForComponent('administration');

     const isNewest = (row.component === 'services' && row.id === newestServicesId) ||
                      (row.component === 'administration' && row.id === newestAdminId);

     const newBadge = isNewest
       ? `<span class="badge cyan new-tag" style="background:rgba(56,189,248,0.18);border:1px solid #38bdf8;color:#38bdf8;font-weight:700;font-size:10px;padding:2px 6px;margin-left:6px;border-radius:4px;">✨ NEW</span>`
       : '';
     ```
   - Display `newBadge` next to the Commit chip or component cell.

---

## 4. CSS Styling Enhancements (`manager/static/styles.css`)

Add the following lightweight rules to `manager/static/styles.css` without modifying any existing classes:

```css
/* Live Tag Pulse */
@keyframes livePulse {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
  70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

.live-tag i {
  animation: livePulse 2s infinite ease-in-out;
}

/* View Toggle Buttons */
.view-toggle-group {
  display: inline-flex;
  background: var(--surface-2, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  padding: 2px;
}

.view-toggle-group .toggle-btn {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  border: none;
  background: transparent;
  color: var(--text-dim, #888);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.view-toggle-group .toggle-btn.active {
  background: var(--cyan, #00f2fe);
  color: #04070e;
}

/* Rollback Action Button */
.table-action[data-rollback-release] {
  background: rgba(245, 158, 11, 0.1);
  transition: all 0.2s ease;
}

.table-action[data-rollback-release]:hover {
  background: rgba(245, 158, 11, 0.25);
  border-color: #f59e0b;
}
```

---

## 5. Verification & Acceptance Checklist

Run these manual or automated checks to verify all 8 features pass:

1. **Commit Staging & Approval (Feature 1)**:
   - Click "Sync GitHub" or push a commit.
   - Verify commit appears under "Incoming commits for approval" on the Deployments page.
   - Verify it is NOT yet in the Release Catalog.
   - Click **Approve**. Confirm commit instantly moves to Release Catalog with status `Available`.
   - Test **Reject**: verify commit moves to rejected status and does not pollute the catalog.

2. **Audit CSV Export (Feature 2)**:
   - Go to Settings -> Audit Trail. Click **Export CSV**.
   - Verify file `vtab_manager_audit_trail_YYYY-MM-DD.csv` downloads with proper headers and escaping.

3. **Clients Table View & Delete (Feature 3)**:
   - Go to Clients page. Click **Table**. Confirm tabular view renders with all columns.
   - Click **Cards**. Confirm card view renders.
   - Click **Delete** on a test client. Confirm confirmation modal appears, deletes client, and refreshes view.

4. **Offer Dialog (Features 4 & 5)**:
   - Open "Offer update" dialog on any release.
   - Verify filter pill buttons (`All (21)`, `Production`, etc.) are gone.
   - Click **Select All**. Confirm all eligible companies are selected.
   - Click **Clear selection**. Confirm selection resets to 0.

5. **Single Live Tag & Rollback (Features 6 & 7)**:
   - Complete an update rollout on a client.
   - Confirm only that specific release has the **● LIVE** badge.
   - Confirm the immediate prior commit displays the **↺ Rollback** button.
   - Click **Rollback**. Confirm Offer Dialog opens pre-configured with that prior version.

6. **New Tag (Feature 8)**:
   - Verify the newest commit in the list is badged with **✨ NEW**.
