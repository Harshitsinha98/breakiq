# BreakIQ Firestore → Supabase Import Utility

This utility runs locally. It reads existing Firebase/Firestore data and upserts normalized rows into the BreakIQ Supabase project.

## Requirements

- Node.js 20+
- Read-only Firebase Admin credentials for the existing Firebase project
- A Supabase service-role key kept only on your local machine
- Firebase Auth users already imported to Supabase Auth using https://supabase.com/docs/guides/platform/migrating-to-supabase/firebase-auth

## Setup on macOS/Linux

From this directory:

    npm install
    cp .env.example .env

Edit .env locally:

- GOOGLE_APPLICATION_CREDENTIALS: absolute path to Firebase service-account JSON
- FIREBASE_PROJECT_ID: existing Firebase project (default erp-break-system-fda79)
- SUPABASE_URL: BreakIQ Supabase URL
- SUPABASE_SERVICE_ROLE_KEY: Supabase service-role key

Load the environment and run a dry run (no database writes):

    set -a
    source .env
    set +a
    npm run migrate:firestore

The importer lists planned row counts and stops before writing if it cannot match every Firestore user by the internal email convention <employeeId lowercased>@breakapp.internal.

## Apply

After verifying the dry-run output and taking a fresh Firebase export:

    npm run migrate:firestore -- --apply

This performs batched upserts. It does not delete destination records. Re-running is intended to be idempotent for primary-key conflicts, but review the dry run first, especially after production has moved to Supabase.

## Important limitations

- Authentication records must be imported first; the utility deliberately refuses to invent user ID mappings.
- Do a write freeze or a documented final delta import during cutover. This script is a collection export/import, not live replication.
- Review counts, project IDs, roles, and active break states before switching traffic.
- Never commit .env, service-account files, exported records, database passwords, WhatsApp secrets, or the service-role key.