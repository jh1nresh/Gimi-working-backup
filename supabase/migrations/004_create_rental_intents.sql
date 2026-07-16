create table if not exists public.rental_intents (
  id text primary key,
  item_id text not null,
  item_name text not null,
  owner_wallet text not null,
  renter_wallet text,
  renter_identity text,
  payment_method text not null check (payment_method in ('card', 'solana_wallet')),
  payment_status text not null check (payment_status in ('created', 'requires_action', 'confirmed', 'failed', 'expired')),
  escrow_status text not null check (escrow_status in ('not_funded', 'provider_authorized', 'provider_captured', 'onchain_locked')),
  session_status text not null check (session_status in ('intent', 'reserved', 'active', 'cancelled')),
  receipt_status text not null check (receipt_status in ('none', 'pending_onchain', 'issued')),
  currency text not null default 'USD',
  duration_hours numeric not null,
  rent_amount numeric not null,
  deposit_amount numeric not null,
  platform_fee_estimate numeric not null,
  provider text,
  provider_checkout_url text,
  provider_payment_id text,
  rental_id text,
  notes text,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists rental_intents_item_id_created_at_idx
  on public.rental_intents (item_id, created_at desc);

create index if not exists rental_intents_renter_wallet_created_at_idx
  on public.rental_intents (renter_wallet, created_at desc);

create index if not exists rental_intents_payment_status_idx
  on public.rental_intents (payment_status, created_at desc);

alter table public.rental_intents enable row level security;
