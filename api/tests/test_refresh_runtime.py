import os
import unittest
from unittest.mock import patch

import pandas as pd

from app.credential_vault import CredentialConfigurationError, decrypt_credentials, encrypt_credentials
from app.refresh_worker import execute_refresh, parse_project, validate_refresh_frame


class _Result:
    def __init__(self, data): self.data = data


class _Query:
    def __init__(self, client, table): self.client, self.table_name, self.patch = client, table, None
    def select(self, *_args): return self
    def eq(self, *_args): return self
    def limit(self, *_args): return self
    def update(self, value): self.patch = value; return self
    def execute(self):
        if self.table_name == "published_reports" and self.patch is None:
            return _Result([self.client.report])
        if self.table_name == "published_reports": self.client.updates.append(self.patch)
        return _Result([self.patch or {}])


class _Bucket:
    def __init__(self, client): self.client = client
    def upload(self, path, payload, *_args): self.client.uploads.append((path, payload))


class _Storage:
    def __init__(self, client): self.client = client
    def from_(self, _name): return _Bucket(self.client)


class _Client:
    def __init__(self):
        self.report = {"id":"r1", "name":"Report", "owner_id":"u1", "project_json":{"model":{"tables":{"Sales":{},"Customers":{}}}}}
        self.uploads, self.updates = [], []
        self.storage = _Storage(self)
    def table(self, name): return _Query(self, name)


class RefreshCredentialTests(unittest.TestCase):
    def test_round_trip_is_encrypted(self):
        with patch.dict(os.environ, {"VTAB_CREDENTIAL_ENCRYPTION_KEY": "test-only-key-that-is-more-than-thirty-two-characters"}):
            value = encrypt_credentials({"username": "reader", "password": "private"})
            self.assertTrue(value.startswith("v1:"))
            self.assertNotIn("private", value)
            self.assertEqual(decrypt_credentials(value)["password"], "private")

    def test_fallback_to_service_role_key(self):
        env = {
            "VTAB_CREDENTIAL_ENCRYPTION_KEY": "",
            "SUPABASE_SERVICE_ROLE_KEY": "fallback-service-role-key-that-is-at-least-thirty-two-chars"
        }
        with patch.dict(os.environ, env):
            value = encrypt_credentials({"sheet_url": "https://docs.google.com/test"})
            self.assertTrue(value.startswith("v1:"))
            self.assertEqual(decrypt_credentials(value)["sheet_url"], "https://docs.google.com/test")

    def test_legacy_plaintext_is_refused(self):
        with self.assertRaises(CredentialConfigurationError):
            decrypt_credentials('{"password":"old-plaintext"}')

    def test_project_parser_returns_a_copy(self):
        original = {"model": {"tables": {"Sales": {}}}}
        parsed = parse_project(original)
        parsed["model"]["tables"]["Sales"]["changed"] = True
        self.assertNotIn("changed", original["model"]["tables"]["Sales"])

    def test_refresh_switches_report_only_after_all_tables_upload(self):
        client = _Client()
        job = {"report_id":"r1","created_by":"u1","source_type":"postgresql","credentials_enc":"encrypted","source_config":{"mappings":[{"table":"Sales","query":"SELECT * FROM sales"},{"table":"Customers","query":"SELECT * FROM customers"}]}}
        with patch("app.refresh_worker.decrypt_credentials", return_value={}), patch("app.refresh_worker.source_frame", return_value=pd.DataFrame({"id":[1,2]})), patch("app.refresh_worker.parquet_bytes", return_value=b"parquet"):
            result = execute_refresh(job, client)
        self.assertEqual(result["rows"], 4)
        self.assertEqual(len(client.uploads), 2)
        self.assertEqual(len(client.updates), 1)

    def test_failed_table_does_not_switch_published_report(self):
        client = _Client()
        job = {"report_id":"r1","created_by":"u1","source_type":"postgresql","credentials_enc":"encrypted","source_config":{"mappings":[{"table":"Sales","query":"SELECT * FROM sales"},{"table":"Customers","query":"SELECT * FROM customers"}]}}
        frames = [pd.DataFrame({"id":[1]}), RuntimeError("database unavailable")]
        with patch("app.refresh_worker.decrypt_credentials", return_value={}), patch("app.refresh_worker.source_frame", side_effect=frames), patch("app.refresh_worker.parquet_bytes", return_value=b"parquet"):
            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                execute_refresh(job, client)
        self.assertEqual(client.updates, [])

    def test_refresh_rejects_missing_model_columns_before_snapshot_switch(self):
        client = _Client()
        client.report["project_json"]["model"]["tables"] = {
            "Customers": {"columns": {"CustomerID": "CustomerID", "Segment": "Segment", "Region": "Region"}}
        }
        job = {"report_id":"r1","created_by":"u1","source_type":"postgresql","credentials_enc":"encrypted","source_config":{"mappings":[{"table":"Customers","query":"SELECT * FROM customers"}]}}
        with patch("app.refresh_worker.decrypt_credentials", return_value={}), patch("app.refresh_worker.source_frame", return_value=pd.DataFrame({"CustomerID":[1], "Name":["A"]})), patch("app.refresh_worker.parquet_bytes", return_value=b"parquet"):
            with self.assertRaisesRegex(ValueError, "missing model columns: Segment, Region"):
                execute_refresh(job, client)
        self.assertEqual(client.uploads, [])
        self.assertEqual(client.updates, [])

    def test_refresh_normalizes_column_case_without_breaking_model(self):
        frame = validate_refresh_frame(
            pd.DataFrame({"customerid":[1], "segment":["Retail"]}),
            "Customers",
            {"columns": {"CustomerID": "CustomerID", "Segment": "Segment"}},
        )
        self.assertEqual(list(frame.columns), ["CustomerID", "Segment"])

    def test_manifest_preserves_and_enriches_per_table_google_sheet_names(self):
        from app.reporting_service import _attach_source_manifest, enrich_source_manifest
        snapshot = {
            "dataSources": [
                {"id": "src-1", "name": "Orders", "type": "google_sheets", "configuration": {"url": "https://docs.google.com/spreadsheets/d/abc/edit", "sheetRange": "'Orders!A:ZZ"}},
                {"id": "src-1", "name": "Customers", "type": "google_sheets", "configuration": {"url": "https://docs.google.com/spreadsheets/d/abc/edit", "sheetRange": "'Customers!A:ZZ"}},
            ],
            "transform": {
                "queries": [
                    {"sourceId": "src-1", "sourceType": "google_sheets", "semanticName": "Orders", "sourceConfig": {"url": "https://docs.google.com/spreadsheets/d/abc/edit", "sheetRange": "'Orders!A:ZZ"}},
                    {"sourceId": "src-1", "sourceType": "google_sheets", "semanticName": "Customers", "sourceConfig": {"url": "https://docs.google.com/spreadsheets/d/abc/edit", "sheetRange": "'Customers!A:ZZ"}},
                ]
            },
            "model": {
                "tables": {
                    "Orders": {"sourceType": "google_sheets", "sourceConfig": {"url": "https://docs.google.com/spreadsheets/d/abc/edit", "sheetRange": "'Orders!A:ZZ"}},
                    "Customers": {"sourceType": "google_sheets", "sourceConfig": {"url": "https://docs.google.com/spreadsheets/d/abc/edit", "sheetRange": "'Customers!A:ZZ"}},
                }
            },
        }
        _attach_source_manifest(snapshot)
        sources = snapshot["model"]["sourceManifest"]["sources"]
        self.assertEqual(len(sources), 1)
        by_table = {item["modelTable"]: item for item in sources[0]["tables"]}
        self.assertEqual(by_table["Orders"]["sheet"], "Orders")
        self.assertEqual(by_table["Customers"]["sheet"], "Customers")

        # Legacy manifest without per-table sheet is enriched from model.tables[*].sourceConfig
        legacy_def = {
            "tables": snapshot["model"]["tables"],
            "sourceManifest": {"version": 1, "sources": [{"id": "src-1", "type": "google_sheets", "configuration": {"url": "https://docs.google.com/spreadsheets/d/abc/edit"}, "tables": [{"modelTable": "Orders"}, {"modelTable": "Customers"}]}]},
        }
        enriched = enrich_source_manifest(legacy_def)
        enriched_by_table = {item["modelTable"]: item for item in enriched["sources"][0]["tables"]}
        self.assertEqual(enriched_by_table["Orders"]["sheet"], "Orders")
        self.assertEqual(enriched_by_table["Customers"]["sheet"], "Customers")

    def test_google_sheets_connection_validation_rejects_mismapped_worksheet(self):
        import io
        from app.server import _validate_google_sheets_table_mappings

        xlsx_buf = io.BytesIO()
        with pd.ExcelWriter(xlsx_buf, engine="openpyxl") as writer:
            pd.DataFrame({"OrderID": ["O1"], "CustomerID": ["C1"], "SalesAmount": [100.0]}).to_excel(writer, sheet_name="Orders", index=False)
            pd.DataFrame({"CustomerID": ["C1"], "Region": ["West"], "City": ["Seattle"]}).to_excel(writer, sheet_name="Customers", index=False)
        xlsx_bytes = xlsx_buf.getvalue()

        model = {
            "definition": {
                "tables": {
                    "Orders": {"columns": {"OrderID": "OrderID", "CustomerID": "CustomerID", "SalesAmount": "SalesAmount"}},
                    "Customers": {"columns": {"CustomerID": "CustomerID", "Region": "Region", "City": "City"}},
                }
            }
        }
        url = "https://docs.google.com/spreadsheets/d/test123/edit"
        with patch("app.connectors._download_public_xlsx", return_value=xlsx_bytes):
            bad = _validate_google_sheets_table_mappings(
                model, {"url": url},
                [{"table": "Orders", "url": url, "sheet": "Orders"}, {"table": "Customers", "url": url, "sheet": "Orders"}],
            )
            self.assertIsNotNone(bad)
            self.assertFalse(bad["ok"])
            self.assertIn("Region", bad["message"])

            missing_tab = _validate_google_sheets_table_mappings(
                model, {"url": url},
                [{"table": "Customers", "url": url, "sheet": "NoSuchTab"}],
            )
            self.assertIsNotNone(missing_tab)
            self.assertFalse(missing_tab["ok"])
            self.assertIn("NoSuchTab", missing_tab["message"])

            good = _validate_google_sheets_table_mappings(
                model, {"url": url},
                [{"table": "Orders", "url": url, "sheet": "Orders"}, {"table": "Customers", "url": url, "sheet": "Customers"}],
            )
            self.assertIsNone(good)

    def test_parquet_round_trip_without_pyarrow(self):
        from app.refresh_worker import _read_parquet_bytes, parquet_bytes
        df = pd.DataFrame({"CustomerID": ["C1", "C2"], "Region": ["West", "East"]})
        raw = parquet_bytes(df)
        restored = _read_parquet_bytes(raw)
        self.assertEqual(list(restored.columns), ["CustomerID", "Region"])
        self.assertEqual(len(restored), 2)

    def test_cloud_project_cache_invalidates_when_db_updated_at_changes(self):
        import time
        from app import server

        state = {
            "updated_at": "2026-11-26T07:51:41Z",
            "project_json": {"report": {"id": "rep-cache-test", "name": "Alerts test", "pages": []}, "model": {"tables": {"Orders": {"sourceStoragePath": "old.parquet"}}}},
            "full_fetches": 0,
        }

        class _MockQuery:
            def __init__(self, cols): self.cols = cols
            def select(self, cols): return _MockQuery(cols)
            def eq(self, *_args): return self
            def limit(self, *_args): return self
            def execute(self):
                if "project_json" in self.cols:
                    state["full_fetches"] += 1
                    return _Result([{"project_json": state["project_json"], "updated_at": state["updated_at"], "published_at": "2026-11-26T07:00:00Z", "name": "Alerts test"}])
                return _Result([{"updated_at": state["updated_at"]}])

        class _MockClient:
            def table(self, name): return _MockQuery("")

        server._invalidate_server_cache("rep-cache-test")
        with patch("app.supabase_store._admin_client", return_value=_MockClient()):
            p1 = server._get_cloud_project("rep-cache-test", bypass_cache=False)
            self.assertEqual(p1["model"]["tables"]["Orders"]["sourceStoragePath"], "old.parquet")
            self.assertEqual(state["full_fetches"], 1)

            # Simulate >1.5s elapsed while updated_at has not changed -> uses cache, no full fetch
            with server._cloud_project_cache_lock:
                server._cloud_project_cache["rep-cache-test"]["time"] = time.time() - 5.0
            p2 = server._get_cloud_project("rep-cache-test", bypass_cache=False)
            self.assertEqual(p2["model"]["tables"]["Orders"]["sourceStoragePath"], "old.parquet")
            self.assertEqual(state["full_fetches"], 1)

            # Simulate refresh updating Supabase updated_at & project_json -> detects mismatch and fetches new snapshot
            state["updated_at"] = "2026-11-26T07:53:15Z"
            state["project_json"] = {"report": {"id": "rep-cache-test", "name": "Alerts test", "pages": []}, "model": {"tables": {"Orders": {"sourceStoragePath": "new_503.parquet"}}}}
            with server._cloud_project_cache_lock:
                server._cloud_project_cache["rep-cache-test"]["time"] = time.time() - 5.0
            p3 = server._get_cloud_project("rep-cache-test", bypass_cache=False)
            self.assertEqual(p3["model"]["tables"]["Orders"]["sourceStoragePath"], "new_503.parquet")
            self.assertEqual(p3["updated_at"], "2026-11-26T07:53:15Z")
            self.assertEqual(state["full_fetches"], 2)
        server._invalidate_server_cache("rep-cache-test")


if __name__ == "__main__":
    unittest.main()
