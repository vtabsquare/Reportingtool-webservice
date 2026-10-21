VTAB REPORTING SERVICES — GROUP GOVERNANCE UPDATE ONLY
======================================================

This is not the complete Services application.

Copy this file into the same relative location in the existing Services project:

  api/app/supabase_store.py

Before using access groups, execute the Admin Console migration in Supabase:

  backend/supabase_migrations/001_admin_governance.sql

The Admin Console materializes group assignments into workspace_members, so the
existing Services workspace/report authorization recognizes group users
immediately. This Services update records direct memberships separately and
prevents removal of a direct assignment from accidentally removing access that
is still granted through an access group.
