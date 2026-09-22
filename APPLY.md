# Services browser-tab reset fix

Copy these two files over the matching files in the current Services source:

- `src/studio.tsx`
- `src/v11/CloudWorkspace.tsx`

Then rebuild/restart the Services frontend. No database migration or backend
change is required for this fix.

## Expected result

- Open semantic-model Settings and enter part of a connection form.
- Switch to another browser tab and return.
- The selected workspace, open Settings dialog, expanded section, and entered
  values remain in place.
- Supabase can still refresh its access token without reloading workspace data.

Verification: TypeScript type check and production Vite build passed.
