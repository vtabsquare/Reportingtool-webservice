# VTAB Services local startup and sign-in fix

## Corrected failure

The local runner built the Services website with `/api/v1` URLs but its HTTP
server treated those URLs as front-end routes. It returned `index.html` instead
of API JSON, producing the banner:

`VTAB local API routing failed at /api/v1/cloud/reports`

This was independent of the Supabase project health.

## Implemented corrections

- The local website server now reverse-proxies every `/api/*` method to the
  Services API configured by `VTAB_API_HOST` and `VTAB_API_PORT`.
- Development proxy configuration now uses the Services API port `8830`, not
  the Desktop API port `8820`.
- Existing compatible API processes are safely reused on rerun.
- Stale website processes are detected. The new build selects the next free web
  port rather than sharing a Windows port with an obsolete build.
- Cached Supabase sessions are validated before bypassing the login screen.
  Revoked or expired sessions return to sign-in; temporary network errors do
  not silently sign the user out.
- Services-specific routing messages now refer to the Services runner.

## Start

Run:

`python run_web_tool.py`

Use the exact **Website** URL printed by the runner. If an older process owns
port 4173, the corrected runner may print 4174 or another free port.

## Verification performed

- Production front-end build completed.
- Backend imported successfully with 200 registered routes.
- Local proxy regression tests passed for GET and POST requests.
- End-to-end local verification returned JSON from
  `http://127.0.0.1:<selected-port>/api/v1/health` and HTML only for the website
  root.
