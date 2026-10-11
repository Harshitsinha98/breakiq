# Firestore → Supabase Import Utility

This local utility reads the existing BreakIQ Firestore project and upserts normalized rows into the target Supabase project. It is not used by the browser app.

## Requirements

- Node.js 20+
- Firebase Admin credentials with access to read the legacy Firestore project
- Supabase service-role key, stored only locally
- Existing Firebase Auth users imported to Supabase Auth using the official guide: https://supabase.com/docs/guides/platform/migrating-to-supabase/firebase-auth

## Configure

```bash
npm install
cp .env.example .env
```

Edit `.env` locally:

- `GOOGLE_APPLICATION_CREDENTIALS`: absolute path to a Firebase service-account JSON file.
- `FIREBASE_PROJECT_ID`: existing project, normally `erp-break-system-fda79`.
- `SUPABASE_URL`: target Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: target project's service-role secret.

Load variables and run a dry run:

```bash
set -a
source .env
set +a
npm run migrate:firestore
```

The dry run makes **no database writes**. It reports planned row counts and stops if a Firebase profile cannot be matched with a Supabase Auth user using `<employeeId lowercased>@breakapp.internal`.

## Apply

Only after reviewing the dry-run output and taking a fresh Firebase export:

```bash
npm run migrate:firestore -- --apply
```

The importer upserts in batches and does not delete target rows. Verify counts, IDs, roles, project IDs, timestamps, active shift/break references, and reports after import.

## Important limitations and safety

- Import Auth users first; the script deliberately does not invent user UUID mappings.
- A one-time export is not live replication. Use a short write-freeze or a documented final delta import at cutover.
- Never commit or share `.env`, Firebase service-account files, exported data, database passwords, WhatsApp secrets, or the Supabase service-role key.
- Never use the Supabase publishable key for the migration utility.
