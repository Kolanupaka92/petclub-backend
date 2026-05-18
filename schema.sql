-- PETclub India — Supabase Schema
-- Run this in the Supabase SQL Editor

-- Users
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text,
  email text,
  role text default 'customer',
  is_active boolean default true,
  created_at timestamptz default now()
);

-- Customer profiles
create table if not exists customer_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade unique,
  city text, area text, address text, pincode text,
  created_at timestamptz default now()
);

-- Pets
create table if not exists pets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references users(id) on delete cascade,
  name text not null,
  species text default 'dog',
  breed text, age text, dob date, weight text, gender text, color text, chip text,
  created_at timestamptz default now()
);

-- Grooming records
create table if not exists grooming_records (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid references pets(id) on delete cascade,
  service text, "by" text, cost text, date date, notes text, rating int,
  created_at timestamptz default now()
);

-- Training records
create table if not exists training_records (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid references pets(id) on delete cascade,
  session text, "by" text, cost text, date date, notes text, rating int,
  created_at timestamptz default now()
);

-- Food orders
create table if not exists food_orders (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid references pets(id) on delete cascade,
  product text, brand text, ftype text, qty text, cost text, date date, notes text,
  created_at timestamptz default now()
);

-- Vet records
create table if not exists vet_records (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid references pets(id) on delete cascade,
  detail text, vet text, clinic text, vtype text, next_due date,
  cost text, date date, notes text,
  created_at timestamptz default now()
);

-- Professional profiles
create table if not exists professional_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade unique,
  sub_role text, city text, area text, address text,
  services text[], experience text, bio text,
  service_areas text, langs text,
  price_basic text, price_full text, price_custom text,
  verification_status text default 'pending',
  is_available boolean default true,
  rating numeric(3,1) default 0,
  total_reviews int default 0,
  created_at timestamptz default now()
);

-- ID documents
create table if not exists id_documents (
  id uuid primary key default gen_random_uuid(),
  prof_id uuid references professional_profiles(id) on delete cascade unique,
  id_type text, id_num text, doc_front text, doc_back text, doc_selfie text,
  created_at timestamptz default now()
);

-- Payout details
create table if not exists payout_details (
  id uuid primary key default gen_random_uuid(),
  prof_id uuid references professional_profiles(id) on delete cascade unique,
  payout_type text, upi_id text,
  account_name text, account_num text, ifsc text,
  created_at timestamptz default now()
);

-- Bookings
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references users(id),
  professional_id uuid references professional_profiles(id),
  pet_id uuid references pets(id),
  service_type text, service_name text,
  scheduled_at timestamptz, amount numeric(10,2),
  status text default 'upcoming',
  payment_status text default 'pending',
  address text, notes text,
  created_at timestamptz default now()
);

-- Reviews
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  reviewer_id uuid references users(id),
  reviewee_id uuid references users(id),
  booking_id uuid references bookings(id),
  rating int, comment text,
  created_at timestamptz default now()
);

-- Admin logs
create table if not exists admin_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references users(id),
  action text, target_id uuid, target_type text, notes text,
  created_at timestamptz default now()
);

-- Website leads (contact form)
create table if not exists website_leads (
  id uuid primary key default gen_random_uuid(),
  name text, phone text, email text, city text,
  pet_type text, service_interest text, pet_name text, message text,
  created_at timestamptz default now()
);

-- Enable Row Level Security (RLS) — service key bypasses these
alter table users enable row level security;
alter table pets enable row level security;
alter table grooming_records enable row level security;
alter table training_records enable row level security;
alter table food_orders enable row level security;
alter table vet_records enable row level security;
alter table professional_profiles enable row level security;
alter table bookings enable row level security;
