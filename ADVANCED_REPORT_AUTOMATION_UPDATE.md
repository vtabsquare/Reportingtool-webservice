# VTAB Services — Advanced Report Automation Update

This is a Services-only update. It preserves the existing subscription, alert,
notification, refresh, export, RLS, and email-queue foundations while adding the
advanced automation platform.

## Included

- Professional multi-step subscription and alert interface.
- Once, hourly, daily, weekly, monthly, yearly, custom-cron, and successful-refresh schedules.
- Time-zone aware scheduling.
- Explicit To, CC, and BCC recipients; recipient permissions are revalidated on every run.
- Owner-controlled automation policy for subscriptions, scheduled delivery, alerts,
  workflows, external recipients, member management, Run now, formats, and recipient limits.
- Between/outside alert ranges, state transitions, cooldowns, repeat behavior, and recovery notifications.
- Versioned workflow definitions, durable queued executions, sequential steps, retries,
  dead-letter state, execution steps, and immutable audit records.
- Email templates, delivery records, execution summaries, and workflow APIs.
- Secured notification-policy endpoints (the previous unauthenticated policy gap is closed).
- Non-destructive migration; existing subscription and alert records remain compatible.

## Required deployment order

1. Back up the Supabase/PostgreSQL database.
2. Confirm migration `018_subscriptions_and_alerts.sql` is already applied.
3. Apply `api/supabase_migrations/020_advanced_report_automation.sql`.
4. Deploy the updated Services backend and web application together.
5. Restart the automation and email workers.
6. Sign in as a workspace owner and review **Owner access policy** in Subscribe or Alert.
7. Create a test subscription, run a test alert, and confirm execution/delivery history.

## Environment variables

Existing email/provider variables remain unchanged. These flags add fail-safe capability gates:

```env
VTAB_AUTOMATION_WORKER_ENABLED=1
VTAB_AUTOMATION_POLL_SECONDS=30
VTAB_AUTOMATION_WORKER_ID=
VTAB_SUBSCRIPTION_MAX_RECIPIENTS=25
VTAB_SUBSCRIPTION_ATTACHMENT_MAX_BYTES=20971520
VTAB_ALLOW_EXTERNAL_EMAIL=0
VTAB_AUTOMATION_TABULAR_EXPORTS_ENABLED=0
VTAB_AUTOMATION_PAGINATED_EXPORT_ENABLED=0
```

Keep tabular and paginated export flags disabled until the corresponding report generator
is configured for the deployment. PDF, secure link, and report snapshot are safe defaults.

## Owner governance

Only a workspace owner or system administrator can change automation availability.
The API derives this authority from the authenticated user and stored workspace ownership;
it never trusts a browser-supplied role. Members can only create their own automation when
the owner permits it. Every delivery rechecks report access and row-level security.

## Validation completed

- Python compile and AST validation: passed.
- TypeScript/Vite production web build: passed.
- Migration is additive/non-destructive and uses `IF NOT EXISTS` or explicit constraint upgrades.

Runtime integration testing still requires the target Supabase project, SMTP provider,
storage bucket, and a published report containing live measures.
