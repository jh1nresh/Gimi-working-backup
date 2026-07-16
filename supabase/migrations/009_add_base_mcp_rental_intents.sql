alter table public.rental_intents
  drop constraint if exists rental_intents_payment_method_check;

alter table public.rental_intents
  add constraint rental_intents_payment_method_check
  check (payment_method in ('card', 'solana_wallet', 'base_mcp'));
