create table if not exists public.listings (
  id text primary key,
  item_pda text not null unique,
  owner_wallet text not null,
  payment_mint text not null,
  item_id_hash text not null,
  metadata_hash text not null,
  metadata jsonb not null,
  canonical_metadata_json text not null,
  name text not null,
  brand text,
  model text,
  category text not null,
  condition integer not null check (condition between 1 and 10),
  description text not null,
  image_url text not null,
  location_label text not null,
  included text[] not null default '{}',
  rate_per_hour numeric not null check (rate_per_hour > 0),
  minimum_fee numeric not null check (minimum_fee > 0),
  buyout_cap numeric not null check (buyout_cap >= minimum_fee),
  auto_buyout_grace_seconds integer not null check (auto_buyout_grace_seconds >= 0),
  status text not null default 'available' check (status in ('available')),
  initialize_signature text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists listings_status_created_at_idx
  on public.listings (status, created_at desc);

create index if not exists listings_owner_wallet_idx
  on public.listings (owner_wallet);

alter table public.listings enable row level security;

drop policy if exists "Published listings are readable" on public.listings;
create policy "Published listings are readable"
  on public.listings
  for select
  using (status = 'available');
