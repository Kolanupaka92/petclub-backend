# Pre-CLI schema history

These root-level files were applied by hand in the Supabase SQL editor before
CLI migrations were adopted. They are already live in prod. Kept for reference;
all new changes go in `supabase/migrations/`. Listed in rough dependency order:

1. `schema.sql` — base schema (read at runtime by setup-db.js/try-connect.js)
- `supabase-add-pet-size-migration.sql`
- `supabase-booking-transaction-migration.sql`
- `supabase-clickwrap-migration.sql`
- `supabase-cron-rpc.sql`
- `supabase-fix-partner-revenue-report.sql`
- `supabase-grant-migration.sql`
- `supabase-indexes-migration.sql`
- `supabase-loyalty-hardening.sql`
- `supabase-loyalty-migration.sql`
- `supabase-migration-20240001-redeem-loyalty-coupon.sql`
- `supabase-migration-20240002-refresh-professional-rating.sql`
- `supabase-migration.sql`
- `supabase-monetary-types-migration.sql`
- `supabase-notifications-migration.sql`
- `supabase-partner-referral-migration.sql`
- `supabase-refresh-tokens-fk-fix.sql`
- `supabase-reschedule-migration.sql`
- `supabase-rls-migration.sql`
- `supabase-security-hardening.sql`
- `supabase-subscriptions-migration.sql`
