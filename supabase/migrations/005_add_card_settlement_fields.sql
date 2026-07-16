alter table public.rental_intents
  drop constraint if exists rental_intents_session_status_check;

alter table public.rental_intents
  add constraint rental_intents_session_status_check
  check (session_status in ('intent', 'reserved', 'active', 'returned', 'cancelled'));

alter table public.rental_intents
  add column if not exists activated_at timestamptz,
  add column if not exists returned_at timestamptz,
  add column if not exists final_fee numeric not null default 0,
  add column if not exists owner_payout numeric not null default 0,
  add column if not exists platform_fee numeric not null default 0,
  add column if not exists renter_refund numeric not null default 0,
  add column if not exists settlement_status text not null default 'none'
    check (settlement_status in ('none', 'pending_provider', 'settled', 'failed'));
