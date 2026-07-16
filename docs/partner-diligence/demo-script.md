# Five-minute partner demo

## Preparation

```bash
npm run demo:seed
npm run dev
```

Open `http://localhost:3000/?demo=partner`, then click **My rentals**. The query
parameter selects only the local seeded-demo wallet session. State clearly that
the fixture is simulated and creates no payment or chain transaction.

## Walkthrough

### 0:00-0:45 — Customer job

“A bounded community operator has useful equipment, but every request requires
manual discovery, terms, deposits, handoff coordination, return confirmation,
and records. Gimi coordinates that lifecycle while humans retain approval over
money and physical custody.”

### 0:45-1:45 — Agent recommendation

Ask for a power bank for three hours. Show the recommended item, duration,
stored price, refundable cap, pickup location, and alternatives. Explain that
the model can parse/rank, while deterministic code owns eligibility and money.

### 1:45-2:30 — Approval boundary

Open checkout. Point to Card versus Solana, then stop before any real approval.
Explain that the migrated Stripe rail is TEST-only and Solana is devnet. No
agent autonomously approves money.

### 2:30-3:45 — Inspectable execution

Open the profile and seeded Power Bank rental. Show:

- `local`, `seeded demo`, and `simulated` badges;
- funnel summary stating zero verified commercial intents;
- expanded Agent activity timeline;
- renter, owner, provider, agent, and chain actors;
- human-approved handoff, return, and receipt steps.

### 3:45-4:30 — Settlement proof

Show fee, owner payout, renter refund, and receipt history. Clarify that the
seeded receipt is off-chain and labeled; a live devnet walkthrough uses the
owner-signed Solana receipt path.

### 4:30-5:00 — Product truth and next pilot

Open `production-readiness.md`. State the baseline honestly: zero commercial
MAU and rentals. Propose one venue, 5-20 power items, 10-30 invited users, one
payment rail, and two weeks. Success is four completed receipted loops plus a
measurable operator task removed.
