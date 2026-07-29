-- ══════════════════════════════════════════════════════════════════
--  Pet health documents — source scans for the digital health record
--
--  Phase 1 of the pet passport work. Owners photograph a paper
--  vaccination card or vet report; the image lands here, Claude vision
--  extracts candidate records, and the OWNER CONFIRMS before anything
--  is written to vet_records. We deliberately never auto-write medical
--  data from an OCR guess — a wrong vaccine date is a real-world harm,
--  not just a bad UX.
--
--  The extracted payload is kept alongside the source image so a record
--  can always be traced back to the document it came from.
-- ══════════════════════════════════════════════════════════════════

create table if not exists pet_health_documents (
  id            uuid primary key default gen_random_uuid(),
  pet_id        uuid not null references pets(id)  on delete cascade,
  uploaded_by   uuid not null references users(id) on delete cascade,
  storage_path  text not null,
  doc_kind      text not null default 'vaccination_card',
  -- uploaded → extracted → confirmed, or failed at any point
  status        text not null default 'uploaded',
  extracted     jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  extracted_at  timestamptz,
  confirmed_at  timestamptz,

  constraint pet_health_documents_status_chk
    check (status in ('uploaded', 'extracted', 'confirmed', 'failed')),
  constraint pet_health_documents_kind_chk
    check (doc_kind in ('vaccination_card', 'vet_report', 'other'))
);

create index if not exists pet_health_documents_pet_idx
  on pet_health_documents (pet_id, created_at desc);

-- Provenance: which uploaded document produced this record, if any.
-- Null for records the owner typed in by hand.
alter table vet_records
  add column if not exists source_document_id uuid references pet_health_documents(id) on delete set null;

-- Vaccination-specific fields. vet_records already carries vtype/next_due,
-- but a passport needs the batch/lot and administering vet licence to be
-- meaningful to a boarding facility or an airline desk.
alter table vet_records add column if not exists batch_no    text;
alter table vet_records add column if not exists vet_licence text;

-- Private bucket for the source scans. These are pet medical documents —
-- never public-read; every access goes through a short-lived signed URL.
insert into storage.buckets (id, name, public)
values ('pet-health-docs', 'pet-health-docs', false)
on conflict (id) do nothing;
