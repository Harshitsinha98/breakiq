# BreakIQ — Firebase to Supabase Migration

## Current state

- Supabase project ref: nrunqihyyijjyihqqlfw
- Project URL: https://nrunqihyyijjyihqqlfw.supabase.co
- Region: Mumbai (ap-south-1)
- Git branch: migration/supabase

The initial PostgreSQL tables, RLS, role/project-scoped read policies, core clock-in/out and break RPCs, queue helpers, management RPCs, scheduled automation, notification outbox, and Edge Functions have been configured.

**This is not yet a production cutover.** Firebase remains the source of truth. Supabase currently contains initial project/config rows, but employee profiles, Firebase Auth users, shifts, breaks, presence history, and reports have not been imported. Do not point the live Vercel deployment at Supabase until the migration checklist passes.

## Important rules

- Never commit or share the Firebase service-account JSON, Supabase service-role key, database password, WhatsApp token, or local .env files.
- The publishable key is intended for browser apps. RLS and server-side authorization must remain enabled.
- Rotate the WhatsApp gateway token that was previously present in the public repository before using Supabase notifications.
- Keep the Firebase deployment available for rollback until after a tested cutover and reconciliation period.

## 1. Validate the target environment

1. Confirm the project ref and region above in Supabase.
2. Open Database → Tables and verify the tables have RLS enabled.
3. Open Database → Cron Jobs (or query cron.job) and verify the scheduled jobs are active.
4. Open Edge Functions and verify breakiq-admin and breakiq-notifications are deployed.
5. Set the rotated WHATSAPP_TOKEN in Edge Function secrets. Do not paste it into GitHub or chat. Until it is configured, notification delivery deliberately reports configured: false.
6. Check Supabase Security Advisor findings before production use. The outbox and counters are intentionally service-role-only; authenticated RPCs must continue enforcing user, role, and project authorization.

## 2. Configure the migration branch locally

    git clone https://github.com/Harshitsinha98/breakiq.git
    cd breakiq
    git checkout migration/supabase
    npm install
    npm run build

For local frontend development, copy .env.example to .env.local and set:

    VITE_SUPABASE_URL=https://nrunqihyyijjyihqqlfw.supabase.co
    VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key

Do not add a service-role key to any VITE_* variable.

## 3. Migrate Firebase Authentication

Use the official guide: https://supabase.com/docs/guides/platform/migrating-to-supabase/firebase-auth

- Export the Firebase Auth users from the existing Firebase project.
- Keep the employee convention: <employeeId lowercased>@breakapp.internal.
- Import users into this Supabase project using matching Firebase password-hash settings if password preservation is supported for the exported data.
- Confirm that existing Admin/Super Admin, Supervisor, and Agent accounts appear in Supabase Auth.
- Test sign-in with a pilot user before importing business records.

Supabase Auth user UUIDs can differ from Firebase UIDs. The migration script maps records by internal employee email and stores the original UID in legacy_firebase_uid; it does not assume the old UID equals the Supabase UUID.

## 4. Dry-run the Firestore data import

The utility in migration-tools is dry-run by default and does not modify the database unless --apply is supplied.

1. In Firebase Console, create a short-lived Firebase service-account key with only the access required to read Firestore. Save it locally outside this repository.
2. Copy migration-tools/.env.example to migration-tools/.env and fill in local paths and credentials. The service-role key must stay local.
3. From migration-tools, install dependencies and run the dry run:

    cd migration-tools
    npm install
    cp .env.example .env
    # Edit .env locally. Do not commit it.
    set -a
    source .env
    set +a
    npm run migrate:firestore

The dry run reports planned row counts and stops if a Firestore employee lacks a matching Supabase Auth user. Fix the Auth mapping first; do not bypass this check.

Review the table counts, unusual roles, missing employee IDs, and project codes before proceeding.

## 5. Apply the data import

Only after dry-run counts and user mapping have been reviewed, run:

    npm run migrate:firestore -- --apply

The importer upserts data in batches and does not delete rows. It maps projects, profiles, settings, shifts, breaks, presence, queue index, aggregates, counters, and reports. Legacy Firebase UIDs are retained for reconciliation.

If the app is still being used on Firebase during this import, plan a brief write-freeze or final delta import at cutover. A one-time export cannot capture writes made after the export. Do not let both backends accept production writes at the same time.

## 6. Validate before traffic switch

- Compare Firebase and Supabase Auth user counts and employee IDs.
- Compare project IDs and effective settings.
- Compare shift/break counts and representative records, including shiftId, statuses, times, break budgets, queue sequence, and report totals.
- Test Agent login, clock-in, lockout timing, break request, queue promotion, scheduled break, accept/timeout, end break, logout, and reports.
- Test Supervisor access and ensure another project cannot be queried.
- Test Admin provisioning, editing, password reset, removal, settings updates, emergency pause/resume, force-end, and queue flush.
- Verify Realtime roster/heartbeats and check Cron run results.
- Configure and test the rotated WhatsApp token using a test recipient.
- Review the staging build in GitHub Actions: https://github.com/Harshitsinha98/breakiq/actions

## 7. Vercel cutover

Do not update the production Vercel environment until staging tests pass.

In Vercel project settings, configure VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY. Deploy a preview from migration/supabase and test with pilot accounts. Create a pull request to main only after approval and complete test sign-off. Preserve the Firebase deployment and export as rollback options.

## 8. Rollback

If a cutover test fails, switch the Vercel production deployment/environment back to the last Firebase-connected release. Keep Supabase records for diagnosis; do not delete the new project or overwrite Firebase data while investigating. Reconcile write differences before attempting another cutover.