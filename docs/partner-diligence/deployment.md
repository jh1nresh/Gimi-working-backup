# Deployment and smoke checks

## Services

- Next.js 16 runtime, currently deployable to Vercel.
- Supabase Postgres and service-role server credentials.
- Privy application and JWT verification public key.
- One chosen pilot payment rail.
- Solana RPC and deployed program only when the pilot uses on-chain actions.

## Required provenance

Set these deliberately for every environment:

```bash
GIMI_ENVIRONMENT=local
GIMI_ACTIVITY_TYPE=seeded_demo
```

Allowed values are documented in `.env.example`. Production Vercel defaults to
`devnet` unless explicitly changed, preventing an unlabeled mainnet claim.

## Database

Apply all migrations in numeric order, including:

```text
supabase/migrations/010_create_rental_execution_events.sql
```

The execution event table has row-level security enabled and is accessed by
server repositories using the service role. Never expose that key to clients.

## Verification

```bash
npm install
npm run verify:prod-ready
npm run test:anchor
```

Local seeded walkthrough:

```bash
npm run demo:seed
npm run dev
```

Open `http://localhost:3000/?demo=partner` to inspect the seeded evidence.

The seed command refuses Vercel or Supabase environments and prints the demo
renter wallet. It writes only local `.rentproof` fixtures labeled
`seeded_demo` and `simulated`.

## Pre-deploy smoke

1. `/api/health/readiness` contains no secret values.
2. Login modal opens on the same page.
3. Profile timeline displays environment/activity/payment labels.
4. Demo and pilot counts remain separate.
5. Unauthenticated payment APIs reject missing bearer tokens.
6. No live Stripe key is accepted.
7. One approved flow reaches a receipt or an explicit receipt-failure state.

Deployment, credential changes, database migrations, and real-value tests need
explicit owner approval.
