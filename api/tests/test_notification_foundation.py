import unittest
from pathlib import Path

from app.notification_service import DEFAULT_PREFERENCES, _channel_flags


class NotificationFoundationTests(unittest.TestCase):
    def test_refresh_failure_is_enabled_by_default(self):
        self.assertEqual(_channel_flags(DEFAULT_PREFERENCES, "refresh.failed", "refresh"), (True, True))

    def test_refresh_success_is_opt_in(self):
        self.assertEqual(_channel_flags(DEFAULT_PREFERENCES, "refresh.succeeded", "refresh"), (False, False))

    def test_alerts_support_both_channels(self):
        self.assertEqual(_channel_flags(DEFAULT_PREFERENCES, "alert.triggered", "alert"), (True, True))

    def test_global_email_switch_overrides_category(self):
        preferences = {**DEFAULT_PREFERENCES, "email_enabled": False}
        self.assertEqual(_channel_flags(preferences, "alert.triggered", "alert"), (True, False))

    def test_migration_contains_durable_claim_and_idempotency(self):
        migration = (Path(__file__).parents[1] / "supabase_migrations" / "017_notification_email_foundation.sql").read_text(encoding="utf-8")
        self.assertIn("idempotency_key text NOT NULL UNIQUE", migration)
        self.assertIn("FOR UPDATE SKIP LOCKED", migration)
        self.assertIn("claim_vtab_email_jobs", migration)


if __name__ == "__main__":
    unittest.main()

