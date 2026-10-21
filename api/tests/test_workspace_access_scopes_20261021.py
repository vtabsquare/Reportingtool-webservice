from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class WorkspaceAccessScopeContractTests(unittest.TestCase):
    def test_workspace_backend_keeps_membership_and_report_grants_separate(self):
        source = (ROOT / "api" / "app" / "supabase_store.py").read_text(encoding="utf-8")
        self.assertIn("def ensure_personal_workspace", source)
        self.assertIn("access_scope = 'workspace' if has_workspace_access else 'report'", source)
        self.assertIn("report_map = {report_id: report for report_id, report in report_map.items() if report_id in direct_report_ids}", source)
        self.assertIn("'can_manage_workspace': access_scope == 'workspace' and role == 'Admin'", source)


    def test_workspace_ui_never_uses_first_team_workspace_as_personal_fallback(self):
        source = (ROOT / "src" / "v11" / "CloudWorkspace.tsx").read_text(encoding="utf-8")
        self.assertIn("workspaces.find(isPersonalWorkspace) || null", source)
        self.assertIn("ordered.find(workspace => !isPersonalWorkspace(workspace)) || ordered[0]", source)
        self.assertIn("activeWorkspace.access_scope === 'report'", source)
        self.assertIn("activeWorkspace.can_manage_workspace", source)


    def test_report_only_workspace_does_not_load_workspace_semantic_models(self):
        source = (ROOT / "src" / "v11" / "SemanticModelService.tsx").read_text(encoding="utf-8")
        self.assertIn("if(workspace.access_scope==='report')", source)
        self.assertIn("item.report?.role || workspace.role", source)
        self.assertIn("canManage(item.report!.role || workspace.role)", source)


    def test_supabase_patch_provisions_and_backfills_personal_workspaces(self):
        sql = (ROOT / "api" / "supabase_migrations" / "019_workspace_report_access_and_provisioning.sql").read_text(encoding="utf-8")
        self.assertIn("provision_vtab_personal_workspace", sql)
        self.assertIn("AFTER INSERT ON auth.users", sql)
        self.assertIn("FOR account IN SELECT id, email FROM auth.users", sql)
        self.assertIn("has_vtab_workspace_shell_access", sql)
        self.assertIn("report_access_grants", sql)


if __name__ == "__main__":
    unittest.main()
