from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_rendered_export_is_bounded_and_does_not_require_full_project_payload():
    server = source("api/app/server.py")
    viewer = source("src/v11/PublishedViewer.tsx")
    paginated = source("src/v11/PaginatedReportViewer.tsx")
    nginx = source("deploy/nginx-reportservices.conf")
    assert "_get_cloud_project(report_id)" in server
    assert "data:image/jpeg;base64," in server and "data:image/webp;base64," in server
    assert "100*1024*1024" in server
    assert "const exportProject=" in viewer and "project:exportProject" in viewer
    assert "const exportProject=" in paginated and "project:exportProject" in paginated
    assert nginx.count("client_max_body_size 100M;") >= 2


def test_slicers_preserve_independent_state_and_do_not_self_filter():
    viewer = source("src/v11/PublishedViewer.tsx")
    designer = source("src/v11/ReportWorkbench.tsx")
    server = source("api/app/server.py")
    assert "interactionFilterMap" in viewer and "handleCrossFilter" in viewer
    assert "activeFilter={activeFilter}" in viewer
    assert "v.type==='slicer'?(!visualResults[v.id]&&visualLoading)" in viewer
    assert "setVisualLoading(true);setVisualLoadError('');\n" in viewer
    assert "allOptions.length>1" in viewer and "allOptions.length>1" in designer
    assert "if visual.get('type') == 'slicer':" in server and "axis_fields" in server


def test_viewer_semantic_model_access_is_blocked_in_ui_and_backend():
    service = source("src/v11/SemanticModelService.tsx")
    cloud = source("src/v11/CloudWorkspace.tsx")
    reporting = source("api/app/reporting_service.py")
    store = source("api/app/supabase_store.py")
    assert "canAccessSemanticModel" in service
    assert "!canAccessSemanticModel(workspace.role)" in service
    assert "['Admin','Member','Contributor','Owner','Co-Owner'].includes(activeWorkspace.role)" in cloud
    assert "require_semantic_model" in reporting and 'role == "Viewer"' in reporting
    assert "allowed_roles = ('Admin', 'Member', 'Contributor', 'Owner', 'Co-Owner')" in store


def test_workspace_switching_and_network_guard_preserve_application_state():
    cloud = source("src/v11/CloudWorkspace.tsx")
    main = source("src/main.tsx")
    api = source("src/api.ts")
    guard = source("src/components/NetworkStatusGuard.tsx")
    assert "workspaceReqRef" in cloud and "workspaceLoading" in cloud and "loadingWorkspaceId" in cloud
    assert "<NetworkStatusGuard><Application/></NetworkStatusGuard>" in main
    assert "vtab:network-offline" in api and "announceNetworkFailure" in api
    assert "display:'none'" in guard and "vtabToggleOffline" in guard and "RETRY_SECONDS=5" in guard

