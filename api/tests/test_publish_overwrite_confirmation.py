import unittest

from app import reporting_service as service


class _Result:
    data = {
        "report_id": "existing-report",
        "workspace_id": "workspace-1",
        "version_id": "version-2",
        "version": "1.1",
        "published_at": "2026-08-28T00:00:00Z",
    }


class _Rpc:
    def execute(self):
        return _Result()


class _Client:
    def rpc(self, _name, _payload):
        return _Rpc()


class PublishOverwriteConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.original_authenticate = service.authenticate
        self.original_list = service.list_workspace_reports
        self.original_client = service._anon_client
        service.authenticate = lambda _token: {"id": "user-1", "email": "author@example.com"}
        service.list_workspace_reports = lambda _workspace, _token: [
            {"id": "existing-report", "name": "Sales", "workspace_id": "workspace-1"}
        ]
        service._anon_client = lambda _token=None: _Client()
        self.payload = {
            "workspaceId": "workspace-1",
            "reportId": "desktop-report",
            "reportName": "Sales",
            "project": {"name": "Sales", "report": {"id": "desktop-report", "pages": [{"id": "page-1", "visuals": []}]}, "model": {}},
            "reportSchemaVersion": "1.0",
        }

    def tearDown(self):
        service.authenticate = self.original_authenticate
        service.list_workspace_reports = self.original_list
        service._anon_client = self.original_client

    def test_existing_name_requires_explicit_replace(self):
        with self.assertRaises(service.ServiceConflictError):
            service.publish_report(self.payload, "token")

    def test_confirmed_replace_reuses_existing_report_id(self):
        result = service.publish_report({**self.payload, "overwrite": True}, "token")
        self.assertEqual(result["reportId"], "existing-report")
        self.assertEqual(result["version"], "1.1")


if __name__ == "__main__":
    unittest.main()
