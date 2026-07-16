# Tably Owner Listing MVP Spec

## Goal

Let a real owner list an item from the web app, sign an on-chain `initialize_item`
transaction on Solana devnet, persist the off-chain product metadata, and make the
new item rentable through the existing Tably renter agent.

This spec intentionally excludes LI.FI. The focus is the runnable listing path.

## Implementation Status

Implemented in branch `owner-listing-mvp`:

- `POST /api/solana-pay/initialize-item` prepares a real owner-signed
  `initialize_item` devnet transaction.
- `POST /api/listings/publish` verifies the devnet signature and decoded item
  PDA before publishing the listing.
- `GET /api/listings` returns published listings plus renter-ready inventory.
- `ListingAgent` now follows `collect -> review -> prepare -> sign -> publish`.
- `TablyAgent`, ElevenLabs tools, MCP tools, and Solana Pay rental endpoints now
  resolve published listings and demo inventory through the same server-side
  item path.
- Supabase listing storage is available when `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` are configured. The SQL migration lives at
  `supabase/migrations/001_create_listings.sql`.

Still missing for production:

- running the Supabase migration and setting production env vars in Vercel.
- uploaded product images. The current MVP accepts image URLs.
- arbitrary owner/renter USDC ATA creation and balance preflight.

## Initial Audit

Already working:

- The Anchor program has `initialize_item`, `start_rental`, `confirm_return`, and
  `auto_buyout`.
- `start_rental -> confirm_return` was verified on devnet with finalized
  signatures.
- The renter UI can prepare, sign, send, and view rental transaction signatures.
- `confirm_return` and `auto_buyout` transaction builders and API routes exist.
- Demo items are initialized on devnet by `scripts/setup-rentproof-devnet.mjs`.

Missing or fake before this branch:

- `src/components/ListingAgent.tsx` still uses fake mint copy and never calls
  `initialize_item`.
- `src/app/api/list/route.ts` returns an in-memory listing object only. It does
  not persist, build a transaction, verify a signature, or update renter
  inventory.
- `src/app/page.tsx` does not expose an owner listing flow.
- `src/lib/store.ts` is hardcoded demo inventory. Most demo `owner` values are
  display strings, so transaction builders fall back to `DEMO_OWNER_WALLET`.
- There is no durable database or storage for owner-created listings.
- There is no image upload path. Owner photos cannot become real product assets.
- There is no `initialize_item` serialized transaction API.
- There is no publish step that verifies the item PDA exists after signature.
- Arbitrary owner/renter token accounts are not guaranteed to exist for later
  settlement. The current demo works because setup creates demo ATAs.

## Product Decision

The item listing should not be a transferable NFT for the MVP. The current
contract model is better:

- The item is an Anchor `RentalItem` PDA.
- The rental right is a program-owned `RentalToken` PDA created per rental.
- Product metadata and images live off-chain.
- The on-chain item stores hashes, pricing, owner, mint, and current state.

This keeps the physical-world obligation bound to the session instead of making
the listing/rental right tradable.

## User Flow

Owner flow:

1. Owner clicks `List item`.
2. Owner connects one wallet. Crossmint or Solana wallet adapter can be used.
3. Agent asks for:
   - product name
   - category
   - brand/model
   - condition
   - location label
   - included accessories
   - real photo URL for MVP
   - hourly rate
   - minimum fee
   - buyout cap / deposit
   - auto-buyout grace period
4. App creates canonical metadata JSON and `metadataHash`.
5. App calls `POST /api/solana-pay/initialize-item`.
6. Owner signs the returned devnet transaction.
7. App calls `POST /api/listings/publish` with the tx signature and metadata.
8. Server verifies the item PDA exists and stores the listing.
9. Renter agent inventory refreshes and can recommend the item.

Renter flow after listing:

1. Renter asks for an item.
2. Agent searches persisted listings plus seeded demo items.
3. Renter signs `start_rental`.
4. Owner later signs `confirm_return` or `auto_buyout`.

## On-Chain Design

New API builder: `buildInitializeItemTransaction`.

Instruction: `initialize_item`

Accounts:

- `owner`: signer, writable
- `item`: item PDA, writable
- `payment_mint`: demo USDC mint for current devnet MVP
- `system_program`

Arguments:

- `item_id: [u8; 32]`
- `metadata_hash: [u8; 32]`
- `rate_per_second: u64`
- `minimum_fee: u64`
- `buyout_cap: u64`
- `auto_buyout_grace_seconds: i64`

PDA:

```text
item = PDA(["item", owner, sha256(itemId)])
```

The backend must return:

- serialized unsigned transaction
- `requiredSigner = owner`
- `feePayer = owner`
- `itemPda`
- `itemIdHash`
- `metadataHash`
- `paymentMint`
- `cluster`
- `blockhash`
- `lastValidBlockHeight`

## Off-Chain Metadata

Canonical metadata used for hashing:

```json
{
  "schema": "tably.item.v1",
  "itemId": "item_...",
  "name": "Anker Power Bank",
  "brand": "Anker",
  "model": "20K USB-C",
  "category": "Power",
  "condition": 9,
  "description": "High capacity USB-C power bank with cable.",
  "imageUrl": "https://...",
  "locationLabel": "Main hall table B",
  "included": ["USB-C cable"],
  "ownerWallet": "...",
  "createdAt": "2026-05-10T00:00:00.000Z"
}
```

Hashing rule:

- Server canonicalizes the JSON with stable key order.
- `metadata_hash = sha256(canonicalJson)`.
- The same canonical JSON is stored in DB.

## Persistence

MVP should add a real database. Do not keep production listings only in memory.

Recommended minimum schema:

```sql
create table listings (
  id text primary key,
  item_pda text not null unique,
  owner_wallet text not null,
  payment_mint text not null,
  item_id_hash text not null,
  metadata_hash text not null,
  name text not null,
  brand text,
  model text,
  category text not null,
  condition integer not null,
  description text not null,
  image_url text not null,
  location_label text not null,
  rate_per_hour numeric not null,
  minimum_fee numeric not null,
  buyout_cap numeric not null,
  auto_buyout_grace_seconds integer not null,
  status text not null default 'available',
  initialize_signature text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Storage options:

- MVP: owner pastes an image URL.
- Product-ready: Vercel Blob or Supabase Storage upload before
  `initialize_item`.

## API Surface

### `POST /api/solana-pay/initialize-item`

Purpose: prepare owner-signed `initialize_item`.

Request:

```json
{
  "ownerWallet": "...",
  "name": "Anker Power Bank",
  "brand": "Anker",
  "model": "20K USB-C",
  "category": "Power",
  "condition": 9,
  "description": "High capacity USB-C power bank with cable.",
  "imageUrl": "https://...",
  "locationLabel": "Main hall table B",
  "ratePerHour": 2,
  "minimumFee": 3,
  "buyoutCap": 30,
  "autoBuyoutGraceSeconds": 3600
}
```

Response:

```json
{
  "draftId": "item_...",
  "itemPda": "...",
  "metadataHash": "...",
  "transaction": "base64...",
  "transactionMetadata": {
    "cluster": "devnet",
    "rpcUrl": "https://api.devnet.solana.com",
    "requiredSigner": "...",
    "feePayer": "...",
    "blockhash": "...",
    "lastValidBlockHeight": 123
  },
  "listingPreview": {}
}
```

### `POST /api/listings/publish`

Purpose: verify tx and persist listing.

Request:

```json
{
  "draftId": "item_...",
  "initializeSignature": "...",
  "listingPreview": {}
}
```

Server checks:

- transaction exists and is confirmed/finalized on devnet
- `itemPda` account exists
- account owner is `RENTAL_SESSION_PROGRAM_ID`
- metadata hash in request matches preview
- owner wallet in preview matches the item PDA derivation

Response:

```json
{
  "listing": {},
  "explorerUrl": "https://explorer.solana.com/tx/...?cluster=devnet"
}
```

### `GET /api/listings`

Purpose: provide renter inventory.

Returns DB listings with `status = available`. The renter agent should use this
as the primary inventory source and fall back to seeded demo items only when the
DB is empty.

## Frontend Scope

Add an owner listing mode:

- Add a simple `List item` entry point in navbar or command surface.
- Replace fake `ListingAgent` mint behavior with:
  - collect metadata
  - show price/deposit review
  - connect wallet
  - prepare `initialize_item`
  - sign and send
  - publish listing
  - show item PDA and explorer link
- Do not show fake mint addresses.
- Use "item PDA" or "on-chain listing" language, not NFT mint language.

## Inventory Integration

Change inventory source:

1. `GET /api/listings` from DB.
2. Normalize listing rows into `RentalItem` shape.
3. `TablyAgent` fetches listings on load.
4. If no DB listings exist, use `COMMUNITY_ITEMS` as demo fallback.

Important: real listings must use real `ownerWallet`, not display strings.

## Token Account Gap

For arbitrary owners and renters, later settlement can fail if token accounts do
not exist.

Minimum fix:

- `confirm-return` and `auto-buyout` builders should include idempotent ATA
  creation for owner, renter, and platform fee authority when needed.
- `start-rental` should either:
  - require renter already has the payment ATA and enough demo USDC, or
  - include a clear preflight error explaining missing ATA/balance.

For hackathon/devnet:

- keep demo USDC mint
- provide a devnet helper/faucet route only for demo wallets, or document setup
  commands for seeded wallets

## Acceptance Criteria

Listing MVP is complete when:

- Owner can list an item from the UI using a real wallet.
- App prepares an unsigned `initialize_item` transaction.
- Owner signs and sends it on devnet.
- Server verifies the item PDA exists.
- Listing persists outside process memory.
- New item appears in renter agent search without editing `src/lib/store.ts`.
- Renter can start a rental against the newly listed item.
- No fake mint addresses or fake "tokenized" success copy remains.
- README documents the listing flow and required env vars.

## Suggested Implementation Order

1. Add `buildInitializeItemTransaction` to `src/lib/rentproofProgram.ts`.
2. Add `POST /api/solana-pay/initialize-item`.
3. Add DB adapter and `listings` table.
4. Add `POST /api/listings/publish` and `GET /api/listings`.
5. Replace `ListingAgent` fake mint with real prepare/sign/publish flow.
6. Make `TablyAgent` load DB listings with demo fallback.
7. Add README listing docs and smoke commands.
8. Add token-account handling/preflight for non-demo owners and renters.

## Out Of Scope For First Listing MVP

- LI.FI funding.
- Mainnet.
- Full image upload pipeline.
- Dispute resolution.
- Reviews/reputation writes.
- Search ranking beyond simple category/text matching.
- A full indexer for all on-chain item/session events.
