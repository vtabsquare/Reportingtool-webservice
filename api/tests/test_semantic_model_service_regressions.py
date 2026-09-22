import unittest
from unittest.mock import patch

from app.supabase_store import _ensure_managed_file_connections, complete_refresh_job


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, client, table):
        self.client, self.table_name, self.patch, self.row_id = client, table, None, None

    def select(self, *_args): return self
    def eq(self, field, value):
        if field == 'id': self.row_id = value
        return self
    def update(self, value):
        self.patch = value
        return self
    def execute(self):
        if self.patch is not None:
            self.client.updates.append((self.table_name, self.row_id, self.patch))
            return _Result([self.patch])
        if self.table_name == 'semantic_model_connections':
            return _Result(self.client.connections)
        return _Result([])


class _Client:
    def __init__(self, connections=None):
        self.connections = connections or []
        self.updates = []

    def table(self, name): return _Query(self, name)


class SemanticModelServiceRegressionTests(unittest.TestCase):
    def test_published_snapshot_is_not_marked_as_a_tested_live_connection(self):
        client = _Client([
            {'id': 'managed', 'name': 'Published sales snapshot', 'source_type': 'managed_file', 'table_mappings': [{'table': 'sales', 'storage_path': 'sales.parquet'}]},
        ])
        model = {'id': 'm1', 'workspace_id': 'w1', 'definition': {'sourceManifest': {'sources': [
            {'name': 'Published sales snapshot', 'type': 'managed_file', 'tables': [{'modelTable': 'sales', 'managedStoragePath': 'sales.parquet'}]},
        ]}}}
        _ensure_managed_file_connections(client, model, 'u1')
        patches = [value for table, row_id, value in client.updates if table == 'semantic_model_connections' and row_id == 'managed']
        self.assertTrue(patches)
        self.assertEqual(patches[-1]['status'], 'not_configured')

    def test_live_source_keeps_managed_snapshot_from_reclaiming_same_table(self):
        client = _Client([
            {'id': 'managed', 'name': 'Imported customers', 'source_type': 'managed_file', 'table_mappings': [{'table': 'customers', 'storage_path': 'old.parquet'}]},
            {'id': 'live', 'name': 'Postgres', 'source_type': 'postgresql', 'table_mappings': [{'table': 'customers', 'query': 'select * from customers'}]},
        ])
        model = {'id': 'm1', 'workspace_id': 'w1', 'definition': {'sourceManifest': {'sources': [
            {'name': 'Imported customers', 'type': 'managed_file', 'tables': [{'modelTable': 'customers', 'managedStoragePath': 'old.parquet'}]},
        ]}}}
        _ensure_managed_file_connections(client, model, 'u1')
        self.assertIn(('semantic_model_connections', 'managed', {'table_mappings': []}), client.updates)

    def test_manual_only_refresh_returns_to_paused(self):
        client = _Client()
        job = {'id': 'j1', 'report_id': 'r1', 'created_by': 'u1', 'cron_expr': '0 0 1 1 *', 'timezone': 'UTC', 'source_config': {'manual_only': True}, 'retry_count': 0}
        with patch('app.supabase_store._compute_next_run', return_value='future'):
            complete_refresh_job(job, True, None, client)
        patch_value = client.updates[0][2]
        self.assertEqual(patch_value['status'], 'paused')
        self.assertIsNone(patch_value['next_run'])

    def test_manual_refresh_of_paused_schedule_does_not_enable_schedule(self):
        client = _Client()
        job = {'id': 'j1', 'report_id': 'r1', 'created_by': 'u1', 'cron_expr': '0 6 * * *', 'timezone': 'UTC', 'source_config': {'_manual_restore_status': 'paused'}, 'retry_count': 3}
        with patch('app.supabase_store._compute_next_run', return_value='future'):
            complete_refresh_job(job, True, None, client)
        patch_value = client.updates[0][2]
        self.assertEqual(patch_value['status'], 'paused')
        self.assertIsNone(patch_value['next_run'])
        self.assertNotIn('_manual_restore_status', patch_value['source_config'])


if __name__ == '__main__':
    unittest.main()
