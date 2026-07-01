-- Migration: add pet_size column to bookings
-- create_booking_atomic references this column but it was missing from the table.
-- All booking creation calls were returning 500 until this ran.
--
-- Safe: nullable column, no default, no backfill needed for existing rows.
-- Applied: 2026-06-29

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pet_size text;
