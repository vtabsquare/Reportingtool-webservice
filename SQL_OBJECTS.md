# SQL objects for VTAB Services Phase 2 and Phase 3

Apply migrations in this order:

1. `017_notification_email_foundation.sql` — only if Phase 1 is not already installed.
2. `018_subscriptions_and_alerts.sql` — required for this delivery.

## New tables created by migration 018

| Table | Purpose |
|---|---|
| `report_subscriptions` | Subscription definition, schedule, delivery options, state, and next run. |
| `subscription_recipients` | Internal or permitted external recipients for each subscription. |
| `subscription_executions` | Auditable execution and delivery result for every scheduled/test run. |
| `alert_rules` | KPI/measure threshold, schedule, channels, cooldown, and current state. |
| `alert_evaluations` | Every measured value and state transition, including failures. |
| `alert_events` | Notification-producing alert events: triggered, repeated, recovered, or error. |

## Existing table altered by migration 018

`email_delivery_jobs` receives these nullable columns:

- `attachment_storage_path`
- `attachment_name`
- `attachment_type`

## Storage object

- Private Supabase Storage bucket: `vtab-email-artifacts`
- Default maximum object size: 25 MB.
- The application removes each generated email artifact after a successful send.

## Worker functions

- `claim_vtab_subscriptions(text, integer)`
- `claim_vtab_alerts(text, integer)`

Both functions use row locks with `SKIP LOCKED` and grant execution only to `service_role`.

## Security

- Row Level Security is enabled for all six new tables.
- Owners can manage their own subscriptions and alerts.
- Workspace Admins can manage workspace automation records.
- Execution/evaluation/event detail is limited to the owner or workspace Admin.
- Background delivery and evaluation use the server-side Supabase service role.
