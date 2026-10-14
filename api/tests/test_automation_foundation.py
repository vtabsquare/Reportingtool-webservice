import unittest
from pathlib import Path


ROOT = Path(__file__).parents[2]


class AutomationFoundationTests(unittest.TestCase):
    def test_phase_two_and_three_schema_is_complete(self):
        sql = (ROOT / "api" / "supabase_migrations" / "018_subscriptions_and_alerts.sql").read_text(encoding="utf-8")
        for table in (
            "report_subscriptions", "subscription_recipients", "subscription_executions",
            "alert_rules", "alert_evaluations", "alert_events",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS public.{table}", sql)
        self.assertIn("FOR UPDATE SKIP LOCKED", sql)
        self.assertIn("claim_vtab_subscriptions", sql)
        self.assertIn("claim_vtab_alerts", sql)

    def test_email_artifacts_are_private(self):
        sql = (ROOT / "api" / "supabase_migrations" / "018_subscriptions_and_alerts.sql").read_text(encoding="utf-8")
        self.assertIn("'vtab-email-artifacts','vtab-email-artifacts',false", sql)

    def test_brevo_configuration_is_server_side(self):
        env = (ROOT / "web.env.example").read_text(encoding="utf-8")
        self.assertIn("VTAB_BREVO_API_KEY", env)
        self.assertIn("VTAB_BREVO_FROM_EMAIL", env)
        self.assertNotIn("VITE_BREVO", env)

    def test_brevo_api_supports_attachments(self):
        source = (ROOT / "api" / "app" / "exports.py").read_text(encoding="utf-8")
        self.assertIn("base64.b64encode(attachment)", source)
        self.assertIn("VTAB_BREVO_API_KEY", source)


if __name__ == "__main__":
    unittest.main()
