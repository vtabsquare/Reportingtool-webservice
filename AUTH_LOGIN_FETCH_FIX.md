# Services Login — `Failed to fetch` Fix

## Verified cause

On 5 November 2026, the deployed Services site and VTAB API responded normally,
but the configured Supabase project Auth endpoints returned Cloudflare HTTP 522
after approximately 20 seconds. The timeout response omitted CORS headers, so the
browser displayed the misleading message `Failed to fetch` before credentials
could be accepted or rejected.

## Code fix

- Direct Supabase login remains the primary route.
- Network/CORS failures retry through the same-origin VTAB API.
- The fallback endpoint is rate limited and forwards the password only to the
  configured Supabase Auth password-grant endpoint; it never stores the password.
- The backend translates upstream timeouts into a clear HTTP 503 response.
- The login form now states that credentials were not rejected when cloud Auth is unavailable.
- `/api/v1/auth/cloud-status` provides a safe operational health check.

## Required infrastructure action

Open the Supabase dashboard for project `asjscibujiikthxmpxgg` and verify that the
project is active. If it is paused or unhealthy, resume/restart it and confirm that:

```text
https://asjscibujiikthxmpxgg.supabase.co/auth/v1/settings
```

returns promptly when called with the public anon key. Then redeploy the updated
Services backend and frontend together.

The fallback improves resilience and diagnostics, but it cannot validate a password
while the upstream Supabase Auth service itself is offline.
