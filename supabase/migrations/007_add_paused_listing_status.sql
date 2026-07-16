alter table public.listings
  drop constraint if exists listings_status_check;

alter table public.listings
  add constraint listings_status_check
  check (status in ('available', 'paused', 'rented', 'return_requested', 'buyout', 'disputed'));
