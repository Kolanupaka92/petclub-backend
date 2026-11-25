-- Author: Sai Kolanupaka
-- Columns the API has been writing all along but that never existed, because
-- runStartupMigrations() could not run SQL. Every save that used them failed.
-- Additive and idempotent: nothing is renamed, dropped or rewritten.

ALTER TABLE public.professional_profiles
  ADD COLUMN IF NOT EXISTS certification  text,
  ADD COLUMN IF NOT EXISTS license_number text,
  ADD COLUMN IF NOT EXISTS clinic_name    text,
  ADD COLUMN IF NOT EXISTS pet_types      text[];

ALTER TABLE public.payout_details
  ADD COLUMN IF NOT EXISTS payment_type   text,
  ADD COLUMN IF NOT EXISTS bank_name      text,
  ADD COLUMN IF NOT EXISTS account_number text,
  ADD COLUMN IF NOT EXISTS account_holder text,
  ADD COLUMN IF NOT EXISTS ifsc_code      text,
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.id_documents
  ADD COLUMN IF NOT EXISTS doc_type    text,
  ADD COLUMN IF NOT EXISTS doc_number  text,
  ADD COLUMN IF NOT EXISTS cert_number text;

-- One service record per booking.
ALTER TABLE public.grooming_records ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL;
ALTER TABLE public.training_records ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL;
ALTER TABLE public.vet_records      ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS grooming_records_booking_unique ON public.grooming_records (booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS training_records_booking_unique ON public.training_records (booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vet_records_booking_unique      ON public.vet_records      (booking_id) WHERE booking_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
