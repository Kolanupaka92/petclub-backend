-- PETclub — Subscriptions migration
-- Run in the Supabase SQL Editor.
-- Recurring care plans: the repeat-revenue layer on top of one-off bookings.

-- ── Plans (catalog, admin-managed) ──────────────────────────────────────────
create table if not exists subscription_plans (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  service_type  text not null,            -- grooming | walking | boarding | membership
  interval      text not null default 'monthly',  -- monthly | quarterly | yearly
  price_inr     numeric(10,2) not null,
  price_usd     numeric(10,2) not null,
  discount_pct  int not null default 0,   -- % off pay-as-you-go bookings for members
  perks         jsonb not null default '[]'::jsonb,
  active        boolean not null default true,
  created_at    timestamptz default now()
);

-- ── Customer subscriptions ──────────────────────────────────────────────────
create table if not exists subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references users(id) on delete cascade,
  plan_id             uuid not null references subscription_plans(id),
  status              text not null default 'active',  -- active | canceled | past_due
  started_at          timestamptz not null default now(),
  current_period_end  timestamptz not null default now() + interval '1 month',
  canceled_at         timestamptz,
  -- payment linkage (filled once Stripe/Razorpay recurring goes live)
  provider            text,               -- stripe | razorpay
  provider_sub_id     text,
  created_at          timestamptz default now()
);

create index if not exists idx_subscriptions_customer on subscriptions (customer_id);
create unique index if not exists idx_subscriptions_one_active
  on subscriptions (customer_id, plan_id) where status = 'active';

-- ── RLS (service-role key bypasses; deny anon by default) ───────────────────
alter table subscription_plans enable row level security;
alter table subscriptions      enable row level security;

drop policy if exists "plans are public" on subscription_plans;
create policy "plans are public" on subscription_plans
  for select using (active = true);

-- ── Seed plans ───────────────────────────────────────────────────────────────
-- Founding-member launch: all plans are FREE (price 0) until payments go live.
-- When monetization starts, update price_inr/price_usd here and in the DB.
insert into subscription_plans (name, description, service_type, interval, price_inr, price_usd, discount_pct, perks)
select * from (values
  ('Fresh Coat Monthly',
   'One full grooming session every month, priority scheduling, free nail trims. Free for founding members during our launch period.',
   'grooming', 'monthly', 0.00, 0.00, 10,
   '["1 grooming session/month", "Priority scheduling", "Free nail trims", "10% off extra bookings"]'::jsonb),
  ('Daily Walks Pack',
   '20 GPS-tracked walks per month with your preferred verified walker. Free for founding members during our launch period.',
   'walking', 'monthly', 0.00, 0.00, 15,
   '["20 walks/month", "Same walker guaranteed", "Live GPS every walk", "15% off extra bookings"]'::jsonb),
  ('PETclub+ Membership',
   'Member pricing on every service, free delivery, priority matching, double loyalty credits. Free for founding members during our launch period.',
   'membership', 'monthly', 0.00, 0.00, 10,
   '["10% off all services", "Priority pro matching", "2x loyalty credits", "Free food delivery at launch"]'::jsonb)
) as seed(name, description, service_type, interval, price_inr, price_usd, discount_pct, perks)
where not exists (select 1 from subscription_plans);
