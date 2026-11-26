# Reporting Tool Services full update - 2026-11-26

This source package contains the Services update for dashboard replacement,
safe data refresh, scheduled refresh, alert email delivery, and Snowflake.

## Included fixes

- Publishing an existing desktop report back to the same workspace updates the
  existing report. A different report with the same name still requires an
  explicit overwrite confirmation.
- Refresh results are validated against the semantic model before the active
  Parquet snapshot is changed. A refresh missing model columns fails safely and
  leaves the last working snapshot active, preventing post-refresh Binder
  Errors in published charts.
- Semantic model settings now expose hourly, daily, and weekly scheduled
  refresh controls, timezone, enable/pause, next-run status, and success/failure
  notifications.
- Alert email jobs wake the email worker immediately instead of waiting only for
  the polling interval.
- Snowflake supports connection testing, schema/table discovery, query import,
  manual refresh, and scheduled refresh with username/password or a raw
  Snowflake OAuth access token.

## Deployment requirements

1. Install frontend and backend dependencies from `package-lock.json` and
   `api/requirements.txt`.
2. Apply the packaged Supabase migrations through the latest migration.
3. Deploy the updated backend and the rebuilt `dist-web` frontend.
4. Enable the refresh, email, and automation workers as shown in
   `api/service.env.example` and the Render YAML files.
5. Configure one email provider:
   - Brevo: `VTAB_BREVO_API_KEY` and a verified
     `VTAB_BREVO_FROM_EMAIL`; or
   - SMTP: `VTAB_SMTP_HOST`, port, username/password, and from address.

Email delivery cannot succeed until the configured sender is verified by the
chosen provider.

## Snowflake authentication note

Hosted Services supports password authentication and a Snowflake-issued raw
OAuth access token, which are suitable for unattended scheduled refresh.
Interactive Google/Microsoft external-browser OIDC must run on the user's
machine, so use the Desktop/Data Bridge flow for that login method. Do not store
a Google ID token or Google password as the Snowflake OAuth token.
