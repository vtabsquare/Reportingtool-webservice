import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app import reporting_service as service


def _project(with_snapshot: bool = True):
    table = {"columns": {"Amount": "Amount"}}
    if with_snapshot:
        table["sourceStoragePath"] = "user-1/report-1/sales.parquet"
    return {
        "report": {"id": "report-1", "pages": [{"id": "page-1", "visuals": []}]},
        "model": {"tables": {"Sales": table}},
    }


class _Query:
    def select(self, *_): return self
    def eq(self, *_): return self
    def limit(self, *_): return self
    def execute(self): return SimpleNamespace(data=[{"id": "report-1"}])


class _Bucket:
    def download(self, path):
        if path != "user-1/report-1/sales.parquet":
            raise AssertionError(path)
        return b"PAR1-test-data"


class _Storage:
    def from_(self, bucket):
        if bucket != "vtab-reports":
            raise AssertionError(bucket)
        return _Bucket()


class _Client:
    storage = _Storage()

    def table(self, name):
        if name != "published_reports":
            raise AssertionError(name)
        return _Query()


class PublishedSnapshotHydrationTests(unittest.TestCase):
    def test_downloads_private_snapshot_to_local_parquet_cache(self):
        original = _project()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(service, "authenticate", return_value={"id": "user-1"}), \
             patch.object(service, "_anon_client", return_value=_Client()), \
             patch.object(service.tempfile, "gettempdir", return_value=directory):
            hydrated = service.hydrate_snapshot_sources(original, "valid-token")
            local_path = Path(hydrated["model"]["tables"]["Sales"]["sourceUrl"])
            self.assertEqual(local_path.read_bytes(), b"PAR1-test-data")
            self.assertNotIn("sourceUrl", original["model"]["tables"]["Sales"])

    def test_rejects_report_published_without_data_snapshot(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(service, "authenticate", return_value={"id": "user-1"}), \
             patch.object(service, "_anon_client", return_value=_Client()), \
             patch.object(service.tempfile, "gettempdir", return_value=directory):
            with self.assertRaisesRegex(service.ServiceValidationError, "no private data snapshot"):
                service.hydrate_snapshot_sources(_project(with_snapshot=False), "valid-token")


if __name__ == "__main__":
    unittest.main()
