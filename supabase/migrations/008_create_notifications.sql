create table if not exists public.notifications (
  id text primary key,
  wallet text not null,
  kind text not null check (kind in ('rental_handoff', 'rental_returned', 'receipt_issued', 'listing_status')),
  title text not null,
  body text not null,
  href text,
  read_at timestamptz,
  created_at timestamptz not null
);

create index if not exists notifications_wallet_created_at_idx
  on public.notifications (wallet, created_at desc);

alter table public.notifications enable row level security;
