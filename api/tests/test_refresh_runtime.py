import os
import unittest
from unittest.mock import patch

import pandas as pd

from app.credential_vault import CredentialConfigurationError, decrypt_credentials, encrypt_credentials
from app.refresh_worker import execute_refresh, parse_project


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


if __name__ == "__main__":
    unittest.main()
