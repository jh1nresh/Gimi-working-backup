# Security boundaries and known risks

## Custody and signing

- Gimi does not add a server-held Solana renter or owner key.
- Users sign wallet transactions in Privy/external wallets.
- The Anchor escrow program controls on-chain settlement destinations.
- Stripe integration is deliberately TEST-only and rejects live secret keys.
- Provider capture follows owner-confirmed return and an owner-signed Solana
  receipt in the migrated test path.

## Secrets

- Supabase service role, Stripe secret, MoonPay secret, and ElevenLabs key are
  server-only.
- Execution-event summaries redact bearer tokens, payment keys, control
  characters, and private-key blocks.
- Provider payment IDs are not returned by rental history; public chain receipt
  references may be returned.

## Authorization gaps before pilot

- Provider-funded handoff and return routes verify an action-specific, five-minute
  owner wallet signature before changing state. Listing management and remaining
  operator routes still require a complete authorization review before a real pilot.
- Wallet-address history is currently address-scoped, not authenticated. Exact
  agent timelines are therefore omitted from normal history responses and exposed
  only for explicitly configured seeded-demo activity.
- Base confirmation authorization and transaction verification depend on its
  configured integration mode.
- Supabase RLS is enabled, but service-role repositories bypass row policies by
  design; server route authorization remains mandatory.

These are explicit blockers for a real-value operator pilot, not hidden demo
limitations.

## Replay and divergence

- Execution events use deterministic IDs and do not duplicate on replay.
- MoonPay timestamped signatures enforce a five-minute window, and provider
  transitions cannot regress a funded or active rental to an earlier state.
- Payment/provider state idempotency must also be verified independently;
  telemetry idempotency does not make money movement idempotent.
- A production pilot needs reconciliation for provider, database, and chain
  disagreement plus alerts and a manual recovery runbook.

## Remaining security receipt

Before real value, independently review reachable paths for:

1. owner and operator authorization;
2. Privy user-to-wallet binding;
3. Stripe/MoonPay replay and idempotency;
4. webhook signatures, with missing MoonPay webhook configuration failing closed;
5. Supabase service-role isolation;
6. Anchor authorities, arithmetic, timestamps, and settlement liveness;
7. upload type/size/access validation;
8. dependency advisories by reachability;
9. incident freeze, dispute, refund, and rollback procedures.
