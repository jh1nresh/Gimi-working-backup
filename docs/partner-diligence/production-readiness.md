# Production-readiness truth table

Commercial baseline at this revision: **0 verified commercial MAU, 0 verified
commercial rentals, and no claimed production Solana volume**. Seeded demo,
internal test, and devnet events are reported separately.

| Surface | Status | Evidence / remaining work |
|---|---|---|
| Web product shell | Demo-ready | Builds and supports renter/operator flows; browser verification required per PR |
| Privy email/wallet login | Integrated | Client login works; pilot requires verified server binding for every protected owner route |
| Supabase persistence | Configurable | Repositories and migrations exist; production requires all migrations and service-role isolation |
| Execution timeline | Seeded-demo ready | Append-only event ledger, provenance labels, UI timeline, and funnel separation; authenticated pilot disclosure remains required |
| Stripe card rail | Test-only | Rejects live keys; manual authorization and capture path must not accept real value yet |
| MoonPay rail | Adapter / configuration-dependent | Checkout and webhook adapter exist; production provider contract and reconciliation remain unverified |
| Solana rental program | Devnet | Escrow lifecycle and tests exist; mainnet deployment, mint policy, and operational authority are pending |
| Solana receipt | Devnet / test proof | Owner-signed receipt verification exists for card settlement |
| Base MCP | Demo integration | Quote/call preparation and confirmation records exist; production escrow verification depends on partner path |
| LI.FI | Quote integration | Live quote preparation exists; not first-pilot execution rail |
| ElevenLabs | Optional integration | Conversation token/tools exist; not first-pilot critical path |
| Metrics | Instrumented demo | Funnel counts separate activity/environment; deployed transaction routes fail closed without an explicit activity label; MAU and retention need authenticated pilot identity data |
| Operator authorization | Partial | Provider-funded handoff and return use action-specific owner signatures; listing and remaining operator routes still need an authorization review |
| Reconciliation / alerts | Incomplete | No production retry queue, divergence monitor, alerting, or rollback runbook |
| Legal / policy | Not configured | Pilot terms, prohibited items, privacy, liability, and dispute policy are operator/jurisdiction dependent |

## Status labels

- `production-ready`: independently verified for real users/value.
- `test-only`: connected to a provider or chain test environment only.
- `demo fallback`: local or seeded behavior that never implies real activity.
- `not configured`: code path exists but required environment/service is absent.

No integration should be promoted to production-ready from a successful UI
demo alone.
