alter table public.listings
  drop constraint if exists listings_status_check;

alter table public.listings
  add constraint listings_status_check
  check (status in ('available', 'rented', 'return_requested', 'buyout', 'disputed'));

create table if not exists public.rental_sessions (
  session_pda text primary key,
  item_id text not null references public.listings(id),
  item_pda text not null,
  rental_token_pda text not null,
  escrow_token_account text not null,
  owner_wallet text not null,
  renter_wallet text not null,
  payment_mint text not null,
  rental_id text not null unique,
  rental_id_hash text not null,
  start_signature text not null unique,
  status text not null check (status in ('active', 'returned', 'buyout', 'disputed')),
  start_ts numeric not null,
  due_ts numeric not null,
  returned_ts numeric not null default 0,
  escrow_amount numeric not null,
  expected_fee_at_start numeric not null,
  final_fee numeric not null default 0,
  owner_payout numeric not null default 0,
  platform_fee numeric not null default 0,
  renter_refund numeric not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists rental_sessions_item_id_idx
  on public.rental_sessions (item_id);

create index if not exists rental_sessions_renter_wallet_idx
  on public.rental_sessions (renter_wallet);

create index if not exists rental_sessions_status_created_at_idx
  on public.rental_sessions (status, created_at desc);

alter table public.rental_sessions enable row level security;
