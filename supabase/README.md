# Database migrations

**Rule: no more hand-pasting SQL into the Supabase dashboard.** Every schema
change is a versioned file in `supabase/migrations/`, applied with the Supabase
CLI. This gives ordering, review, rollback, and staging/prod parity.

## One-time setup (per machine)

```bash
# Install CLI (already on this machine via Homebrew): brew install supabase/tap/supabase
supabase login                      # opens browser; uses YOUR Supabase account
supabase link --project-ref zjrgbsrsthtmxkislgcm
```

## Baseline the already-applied history (one-time)

The schema created before CLI adoption is the root-level `schema.sql` +
`supabase-*.sql` files (applied by hand; catalogued in `HISTORY.md`). They are
**already live in prod** — do not re-run them. They stay at the repo root
because `setup-db.js`/`try-connect.js` read `schema.sql` directly and code
comments reference the others.

`supabase/migrations/` is the source of truth for **new** changes only. On a
fresh clone the CLI will try to push the first migration; that's fine — every
migration here is idempotent (`CREATE OR REPLACE` / `IF NOT EXISTS`), so a
re-apply is a no-op even against the live DB.

## Day-to-day workflow

```bash
# 1. Create a new migration
supabase migration new add_some_column
#    → creates supabase/migrations/<timestamp>_add_some_column.sql

# 2. Write the SQL (idempotent: use IF NOT EXISTS / CREATE OR REPLACE)

# 3. Preview what will run against the linked project
supabase db push --dry-run

# 4. Apply to the hosted project
supabase db push
```

## Conventions

- **Idempotent always** — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
  EXISTS`, `CREATE OR REPLACE VIEW/FUNCTION`. Safe to re-run.
- **Never edit an applied migration** — write a new one that alters.
- **Test on staging first** if the change is risky (see `cloudbuild-staging.yaml`).
- **Timestamps** — `supabase migration new` generates them; don't hand-name.

## Current CLI-managed migrations

| File | Purpose |
|------|---------|
| `20260725000001_active_row_views.sql` | `active_users`/`active_bookings`/`active_pets` views — soft-delete-safe reads |
