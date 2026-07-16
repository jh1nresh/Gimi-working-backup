create table if not exists public.rental_execution_events (
  id text primary key,
  intent_id text not null references public.rental_intents(id) on delete cascade,
  rental_id text,
  item_id text not null,
  step text not null check (step in (
    'intent_received', 'inventory_searched', 'offer_selected', 'terms_drafted',
    'approval_requested', 'rental_funded', 'handoff_confirmed',
    'return_confirmed', 'settlement_completed', 'receipt_issued'
  )),
  actor text not null check (actor in ('renter', 'owner', 'gimi_agent', 'payment_provider', 'chain')),
  tool text not null check (char_length(tool) between 1 and 120),
  summary text not null check (char_length(summary) between 1 and 500),
  approval_required boolean not null default false,
  status text not null check (status in ('planned', 'waiting', 'completed', 'failed', 'recovered')),
  environment text not null check (environment in ('local', 'preview', 'devnet', 'testnet', 'mainnet')),
  activity_type text not null check (activity_type in ('seeded_demo', 'internal_test', 'partner_pilot', 'organic_user')),
  payment_mode text not null check (payment_mode in ('simulated', 'provider_authorized', 'onchain_confirmed')),
  record_ref text check (record_ref is null or char_length(record_ref) <= 220),
  created_at timestamptz not null
);

create index if not exists rental_execution_events_intent_created_at_idx
  on public.rental_execution_events (intent_id, created_at asc);

create index if not exists rental_execution_events_activity_environment_idx
  on public.rental_execution_events (activity_type, environment, created_at desc);

alter table public.rental_execution_events enable row level security;
