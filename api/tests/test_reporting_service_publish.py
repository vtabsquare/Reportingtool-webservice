from types import SimpleNamespace

import pytest

from app import reporting_service as service


def project():
    return {
        "id": "project-1",
        "name": "Sales",
        "report": {"id": "report-1", "name": "Sales", "pages": [{"id": "p1", "visuals": []}]},
        "model": {"tables": {"Sales": {"columns": {"Amount": "Amount"}}}, "measures": {}},
        "dataSources": [{"name": "Warehouse", "server": "db.local", "password": "must-not-publish", "credentialRef": "vault://sales"}],
    }


def test_prepare_snapshot_preserves_common_definition_and_removes_secrets():
    original = project()
    snapshot = service.prepare_report_snapshot(original)
    assert snapshot["report"]["pages"][0]["id"] == "p1"
    assert snapshot["model"]["tables"]["Sales"]["columns"]["Amount"] == "Amount"
    assert "password" not in snapshot["dataSources"][0]
    assert snapshot["dataSources"][0]["credentialRef"] == "vault://sales"
    assert original["dataSources"][0]["password"] == "must-not-publish"


def test_prepare_snapshot_preserves_pixel_geometry_formatting_and_layer_order():
    original = project()
    visual = {
        "id": "visual-1", "type": "bar", "title": "Revenue",
        "x": 117.5, "y": 83, "w": 502.25, "h": 301,
        "geometryVersion": 2, "rotation": 7, "zIndex": 4, "visible": True,
        "bindings": {"axis": ["Sales.Region"], "values": ["Revenue"]},
        "format": {"background": "#123456", "borderVisible": True, "titleAlignment": "right"},
    }
    original["report"]["pages"][0]["visuals"] = [visual]

    snapshot = service.prepare_report_snapshot(original)

    assert snapshot["report"]["pages"][0]["visuals"][0] == visual
    assert service.report_definition_hash(snapshot) == service.report_definition_hash(snapshot)


def test_prepare_snapshot_rejects_invalid_or_duplicate_visual_geometry():
    original = project()
    visual = {"id": "visual-1", "x": 0, "y": 0, "w": 100, "h": 80, "geometryVersion": 2, "bindings": {}, "format": {}}
    original["report"]["pages"][0]["visuals"] = [visual, {**visual, "w": 0}]
    with pytest.raises(service.ServiceValidationError, match="duplicated|positive"):
        service.prepare_report_snapshot(original)


@pytest.mark.parametrize("bad_project, message", [
    ({}, "report definition"),
    ({"report": {}, "model": {}}, "report page"),
    ({"report": {"pages": [{}]}, "model": {}}, "visual definition"),
])
def test_prepare_snapshot_rejects_invalid_report_packages(bad_project, message):
    with pytest.raises(service.ServiceValidationError, match=message):
        service.prepare_report_snapshot(bad_project)


def test_publish_calls_transactional_rpc_and_returns_version(monkeypatch):
    captured = {}

    class Rpc:
        def execute(self):
            return SimpleNamespace(data={
                "report_id": "report-1", "workspace_id": "workspace-1",
                "version_id": "version-2", "version": "1.1", "published_at": "2026-08-28T10:00:00Z",
            })

    class Client:
        def rpc(self, name, payload):
            captured.update({"name": name, "payload": payload})
            return Rpc()

    monkeypatch.setattr(service, "authenticate", lambda token: {"id": "user-1", "email": "author@example.com"})
    monkeypatch.setattr(service, "list_workspace_reports", lambda workspace_id, token: [])
    monkeypatch.setattr(service, "_anon_client", lambda token=None: Client())
    result = service.publish_report({
        "workspaceId": "workspace-1",
        "reportId": "report-1",
        "reportName": "Sales Dashboard",
        "project": project(),
        "desktopVersion": "5.0.8",
        "reportSchemaVersion": "1.0",
        "changeDescription": "Added margin KPI",
    }, "valid-token", "https://reports.example.com")

    assert captured["name"] == "publish_vtab_report"
    assert captured["payload"]["p_workspace_id"] == "workspace-1"
    assert captured["payload"]["p_project_json"]["report"]["name"] == "Sales Dashboard"
    assert captured["payload"]["p_metadata"]["reportDefinitionHash"] == result["reportDefinitionHash"]
    assert result["version"] == "1.1"
    assert result["reportUrl"] == "https://reports.example.com/?workspace=1&report=report-1"


def test_publish_rejects_incompatible_schema_before_writing(monkeypatch):
    monkeypatch.setattr(service, "authenticate", lambda token: {"id": "user-1", "email": "author@example.com"})
    with pytest.raises(service.ServiceValidationError, match="not supported"):
        service.publish_report({
            "workspaceId": "workspace-1", "reportName": "Sales", "project": project(),
            "desktopVersion": "5.0.8", "reportSchemaVersion": "2.0",
        }, "valid-token")


def test_hydrate_snapshot_downloads_private_data_to_local_cache(monkeypatch, tmp_path):
    snapshot = project()
    snapshot["model"]["tables"]["Sales"]["sourceStoragePath"] = "user-1/report-1/sales.parquet"

    class Query:
        def select(self, *_): return self
        def eq(self, *_): return self
        def limit(self, *_): return self
        def execute(self): return SimpleNamespace(data=[{"id": "report-1"}])

    class Bucket:
        def download(self, path):
            assert path == "user-1/report-1/sales.parquet"
            return b"PAR1-test-data"

    class Storage:
        def from_(self, bucket):
            assert bucket == "vtab-reports"
            return Bucket()

    class Client:
        storage = Storage()
        def table(self, name):
            assert name == "published_reports"
            return Query()

    monkeypatch.setattr(service, "authenticate", lambda token: {"id": "user-1"})
    monkeypatch.setattr(service, "_anon_client", lambda token=None: Client())
    monkeypatch.setattr(service.tempfile, "gettempdir", lambda: str(tmp_path))
    hydrated = service.hydrate_snapshot_sources(snapshot, "valid-token")
    local_path = hydrated["model"]["tables"]["Sales"]["sourceUrl"]
    assert local_path.endswith(".parquet")
    assert service.Path(local_path).read_bytes() == b"PAR1-test-data"
    assert "sourceUrl" not in snapshot["model"]["tables"]["Sales"]


def test_hydrate_snapshot_rejects_published_report_without_data(monkeypatch, tmp_path):
    snapshot = project()

    class Query:
        def select(self, *_): return self
        def eq(self, *_): return self
        def limit(self, *_): return self
        def execute(self): return SimpleNamespace(data=[{"id": "report-1"}])

    class Storage:
        def from_(self, _): return object()

    class Client:
        storage = Storage()
        def table(self, _): return Query()

    monkeypatch.setattr(service, "authenticate", lambda token: {"id": "user-1"})
    monkeypatch.setattr(service, "_anon_client", lambda token=None: Client())
    monkeypatch.setattr(service.tempfile, "gettempdir", lambda: str(tmp_path))
    with pytest.raises(service.ServiceValidationError, match="no private data snapshot"):
        service.hydrate_snapshot_sources(snapshot, "valid-token")
