alter table public.rental_intents
  add column if not exists receipt_signature text,
  add column if not exists receipt_issued_at timestamptz;

create index if not exists rental_intents_receipt_signature_idx
  on public.rental_intents (receipt_signature);

alter table public.rental_receipts
  drop constraint if exists rental_receipts_rental_id_fkey,
  drop constraint if exists rental_receipts_item_id_fkey;
