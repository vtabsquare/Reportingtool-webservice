import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app import reporting_service, rls_runtime, semantic_engine


class ServicesPerformanceRegressionTests(unittest.TestCase):
    def setUp(self):
        reporting_service.clear_service_runtime_caches()
        rls_runtime.clear_rls_cache()
        semantic_engine.clear_cache()

    def test_authentication_is_reused_for_the_same_access_token(self):
        calls = 0

        class Auth:
            def get_user(self, _token):
                nonlocal calls
                calls += 1
                return SimpleNamespace(user=SimpleNamespace(id="user-1", email="viewer@example.com"))

        with patch.object(reporting_service, "_anon_client", return_value=SimpleNamespace(auth=Auth())):
            self.assertEqual(reporting_service.authenticate("token-1")["id"], "user-1")
            self.assertEqual(reporting_service.authenticate("token-1")["id"], "user-1")
        self.assertEqual(calls, 1)

    def test_rls_resolution_is_single_flight_and_cached(self):
        calls = 0
        barrier = threading.Barrier(4)
        results = []

        def resolve(*_args):
            nonlocal calls
            calls += 1
            return {"context": {"userId": "user-1"}, "rules": []}

        def worker():
            barrier.wait()
            results.append(rls_runtime.resolve_published_rls("report-1", {}, "token-1"))

        with patch.object(rls_runtime, "authenticate", return_value={"id": "user-1", "email": "viewer@example.com"}), patch.object(rls_runtime, "_resolve_published_rls_impl", side_effect=resolve):
            threads = [threading.Thread(target=worker) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(calls, 1)
        self.assertEqual(len(results), 4)

    def test_snapshot_download_and_deep_copy_are_reused(self):
        downloads = 0
        project = {
            "report": {"id": "report-1", "pages": []},
            "model": {"tables": {"Sales": {"sourceStoragePath": "user/report/sales.parquet"}}},
        }

        class Bucket:
            def download(self, _path):
                nonlocal downloads
                downloads += 1
                return b"PAR1-data"

        class Storage:
            def from_(self, _bucket):
                return Bucket()

        client = SimpleNamespace(storage=Storage())
        with tempfile.TemporaryDirectory() as directory, patch.object(reporting_service, "authenticate", return_value={"id": "user-1"}), patch.object(reporting_service, "_anon_client", return_value=client), patch.object(reporting_service.tempfile, "gettempdir", return_value=directory):
            first = reporting_service.hydrate_snapshot_sources(project, "token-1", skip_auth_check=True)
            second = reporting_service.hydrate_snapshot_sources(project, "token-1", skip_auth_check=True)
        self.assertIs(first, second)
        self.assertEqual(downloads, 1)

    def test_published_visual_queries_never_embed_the_project_definition(self):
        source = (Path(__file__).parents[2] / "src" / "v11" / "PublishedViewer.tsx").read_text(encoding="utf-8")
        self.assertNotIn("/published/query-snapshot", source)
        self.assertIn("`/published/${reportId}/query`", source)
        self.assertIn("visualId:v.id", source)

    def test_report_navigation_does_not_select_the_complete_project_json(self):
        source = (Path(__file__).parents[1] / "app" / "supabase_store.py").read_text(encoding="utf-8")
        listing = source[source.index("def list_accessible_reports"):source.index("# ── Package Upload")]
        self.assertNotIn('project_json, workspace_id', listing)
        self.assertIn('paginatedReports:project_json->paginatedReports', listing)

    def test_chart_execution_is_not_serialized_by_the_ddl_lock(self):
        active = 0
        maximum = 0
        state_lock = threading.Lock()
        start = threading.Barrier(2)

        class Connection:
            description = [("value",)]
            def execute(self, *_args):
                nonlocal active, maximum
                start.wait()
                with state_lock:
                    active += 1
                    maximum = max(maximum, active)
                time.sleep(0.03)
                with state_lock:
                    active -= 1
                return self
            def fetchall(self): return [(1,)]
            def close(self): pass

        def worker(marker):
            semantic_engine.execute({}, {"marker": marker})

        with patch.object(semantic_engine, "ensure_analytics_ready"), patch.object(semantic_engine, "compile_query", return_value=("SELECT 1", [])), patch.object(semantic_engine, "connect", side_effect=lambda: Connection()):
            threads = [threading.Thread(target=worker, args=(marker,)) for marker in (1, 2)]
            for thread in threads: thread.start()
            for thread in threads: thread.join()
        self.assertEqual(maximum, 2)


if __name__ == "__main__":
    unittest.main()
