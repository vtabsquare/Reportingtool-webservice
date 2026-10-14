# VTAB Services complete Phase 1–3 update

This is the corrected update-only delivery containing all notification work from Phase 1 plus subscriptions and alerts from Phases 2 and 3.

## Migration order

1. Apply `api/supabase_migrations/017_notification_email_foundation.sql`.
2. Apply `api/supabase_migrations/018_subscriptions_and_alerts.sql`.

Both migrations are rerunnable. `IF NOT EXISTS`, `DROP POLICY IF EXISTS`, and replacement functions are used where appropriate.

## Phase 1 included

- Notification bell with unread badge and live Supabase updates.
- Notification list, mark-read, mark-all-read, dismiss, and pagination.
- Global notification preferences and category/channel controls.
- Refresh failure notifications enabled by default.
- Refresh success notifications available as an opt-in.
- Sharing/access notifications.
- Durable email queue, attempts, retries, and delivery status.
- Brevo and SMTP server-side delivery.
- Refresh schedule notification switches in Semantic Model settings.

## Phase 2 included

- Scheduled report subscriptions.
- Hourly, daily, weekly, monthly, and after-refresh delivery.
- Secure links and optional PDF attachments.
- Recipient authorization recheck before every delivery.
- Subscription execution history and test-now support.

## Phase 3 included

- Card, KPI, and Gauge measure alerts.
- Six comparison operators.
- Triggered, sustained, repeated, recovered, and error states.
- Cooldown and recovery controls.
- Alert evaluation and event history.
- In-app and email alert channels.

## Brevo environment variables

```text
VTAB_BREVO_API_KEY=<your Brevo API key / ID>
VTAB_BREVO_FROM_EMAIL=<a sender email verified in Brevo>
VTAB_BREVO_SENDER_NAME=VTAB Reporting Services
```

Keep these variables on the Services API host. Do not add a `VITE_` prefix.

## Complete merge-file list

- `api/supabase_migrations/017_notification_email_foundation.sql`
- `api/supabase_migrations/018_subscriptions_and_alerts.sql`
- `api/app/automation_service.py`
- `api/app/automation_worker.py`
- `api/app/email_worker.py`
- `api/app/exports.py`
- `api/app/notification_service.py`
- `api/app/refresh_worker.py`
- `api/app/rls_runtime.py`
- `api/app/server.py`
- `api/app/supabase_store.py`
- `api/cloud_backend.py`
- `src/v11/NotificationCenter.tsx`
- `src/v11/NotificationSettingsDialog.tsx`
- `src/v11/CloudWorkspace.tsx`
- `src/v11/SemanticModelService.tsx`
- `src/v11/ReportAutomationDialog.tsx`
- `src/v11/PublishedViewer.tsx`
- `src/powerbi.css`
- `web.env.example`
- `api/tests/test_notification_foundation.py`
- `api/tests/test_automation_foundation.py`

## Verification

- Production Services web build passed.
- Python syntax compilation passed.
- Nine focused Phase 1–3 notification and automation tests passed.
