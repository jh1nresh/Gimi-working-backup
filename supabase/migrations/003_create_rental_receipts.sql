alter table public.rental_sessions
  add column if not exists return_signature text unique,
  add column if not exists auto_buyout_signature text unique,
  add column if not exists settled_at timestamptz;

create table if not exists public.rental_receipts (
  id text primary key,
  rental_id text not null unique references public.rental_sessions(rental_id),
  item_id text not null references public.listings(id),
  session_pda text not null,
  item_pda text not null,
  owner_wallet text not null,
  renter_wallet text not null,
  payment_mint text not null,
  outcome text not null check (outcome in ('returned_ok', 'auto_buyout', 'disputed')),
  settlement_signature text not null unique,
  gross_fee numeric not null,
  platform_fee numeric not null,
  owner_payout numeric not null,
  renter_refund numeric not null,
  rental_token_status text not null check (rental_token_status in ('burned')),
  created_at timestamptz not null
);

create index if not exists rental_receipts_item_id_created_at_idx
  on public.rental_receipts (item_id, created_at desc);

create index if not exists rental_receipts_renter_wallet_created_at_idx
  on public.rental_receipts (renter_wallet, created_at desc);

alter table public.rental_receipts enable row level security;
