from contextlib import contextmanager
from pathlib import Path
import sys
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app import connectors, server, supabase_store
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from run_web_tool import SetupError, ensure_local_encryption_key, validate


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "_supabase_user_id_from_token", lambda _authorization: "user-1")
    return TestClient(server.app)


@pytest.mark.parametrize("source_type", ["postgresql", "postgres", "sqlserver", "mysql", "mariadb"])
def test_database_connection_endpoint_uses_shared_connector(client, monkeypatch, source_type):
    seen = {}
    def fake_test(payload):
        seen.update(payload)
        return {"ok": True, "message": f"{payload['type']} connected"}
    monkeypatch.setattr(connectors, "test_connection", fake_test)
    response = client.post("/api/v1/scheduler/jobs/_new/test-connection", json={"source_type": source_type, "credentials": {"host": "db", "database": "sales"}})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert seen == {"type": source_type, "config": {"host": "db", "database": "sales"}}


def test_table_discovery_returns_selectable_queries(client, monkeypatch):
    expected = [{"schema": "public", "name": "orders", "qualifiedName": "public.orders", "query": 'SELECT * FROM "public"."orders"'}]
    monkeypatch.setattr(connectors, "list_database_tables", lambda source_type, credentials: expected)
    response = client.post("/api/v1/scheduler/discover-tables", json={"source_type": "postgresql", "credentials": {"host": "db"}})
    assert response.status_code == 200
    assert response.json() == expected


def test_google_sheet_connection_reads_real_response(client, monkeypatch):
    monkeypatch.setattr(connectors, "_validate_remote_url", lambda _url: None)
    monkeypatch.setattr(connectors, "_google_sheet_csv", lambda _url: "https://docs.google.com/export.csv")
    response_object = Mock()
    response_object.read.return_value = b"OrderID,Amount\n1,10\n"
    response_object.headers = {"content-type": "text/csv"}
    @contextmanager
    def opened(*_args, **_kwargs):
        yield response_object
    monkeypatch.setattr("urllib.request.urlopen", opened)
    response = client.post("/api/v1/scheduler/jobs/_new/test-connection", json={"source_type": "google_sheets", "credentials": {"sheet_url": "https://docs.google.com/sheet"}})
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_preflight_is_exposed_to_the_ui(client, monkeypatch):
    expected = {"ok": True, "checks": [{"id": "database", "ok": True, "message": "ready"}]}
    monkeypatch.setattr(supabase_store, "refresh_preflight", lambda _user_id: expected)
    response = client.get("/api/v1/scheduler/preflight")
    assert response.status_code == 200
    assert response.json() == expected


def test_discovery_rejects_unimplemented_connector(client):
    response = client.post("/api/v1/scheduler/discover-tables", json={"source_type": "oracle", "credentials": {}})
    assert response.status_code == 400
    assert "not available" in response.json()["detail"]


def test_local_runner_refuses_missing_encryption_key(tmp_path, monkeypatch):
    monkeypatch.setattr("run_web_tool.WEB_ENV", tmp_path / "web.env")
    (tmp_path / "web.env").write_text("configured", encoding="utf-8")
    values = {
        "VITE_SUPABASE_URL": "https://project.supabase.co",
        "VITE_SUPABASE_ANON_KEY": "a" * 50,
        "SUPABASE_SERVICE_ROLE_KEY": "s" * 50,
        "VITE_APP_MODE": "WORKSPACE_ONLY",
        "VTAB_API_PORT": "8830",
        "VITE_API_URL": "http://127.0.0.1:8830/api/v1",
    }
    with pytest.raises(SetupError, match="VTAB_CREDENTIAL_ENCRYPTION_KEY"):
        validate(values)


def test_local_runner_generates_and_persists_encryption_key(tmp_path, monkeypatch):
    target = tmp_path / "web.env"
    target.write_text("VITE_APP_MODE=WORKSPACE_ONLY\nVTAB_CREDENTIAL_ENCRYPTION_KEY=REPLACE_WITH_KEY\n", encoding="utf-8")
    monkeypatch.setattr("run_web_tool.WEB_ENV", target)
    values = {"VTAB_CREDENTIAL_ENCRYPTION_KEY": "REPLACE_WITH_KEY"}
    ensure_local_encryption_key(values)
    assert len(values["VTAB_CREDENTIAL_ENCRYPTION_KEY"]) >= 32
    saved = target.read_text(encoding="utf-8")
    assert values["VTAB_CREDENTIAL_ENCRYPTION_KEY"] in saved
    assert "REPLACE_WITH_KEY" not in saved
