# Gimi — Agentic Community Rental MVP

> Current direction: Gimi is a consumer AI rental agent for school, community, and hackathon items. The settlement layer supports refundable escrow, temporary rental session/token state, owner return confirmation, card-funded receipt issuance, and reputation-ready history.
>
> The current implementation keeps all sponsor-facing surfaces in scope: Privy onboarding, Card or Solana checkout, LI.FI funding quotes, Solana Pay-style transaction preparation, Solana escrow/token/receipt path, ElevenLabs voice/chat workflow, Virtuals physical-world agent framing, and MCP read/prepare tools.

---

# Historical PRD — RentChain Tokenized Rental Marketplace

**Hackathon:** Web3 Dev3pack (9-hour sprint)
**Tracks:** Solana, Solana Mobile, Virtuals, 11 Labs, LiFi
**Date:** May 9, 2026

---

## One-liner

AI-agent-guided peer-to-peer rental marketplace where every item is tokenized on Solana — think Redbox meets consignment, powered by agents.

---

## Problem

People have stuff sitting around (golf clubs, cameras, tools, luxury bags) that others need temporarily. Selling feels permanent and undervalues the item. Current rental platforms are clunky, have no trust layer, and pricing is guesswork.

## Solution

**RentChain** — list anything for rent in 60 seconds with an AI agent that handles pricing, tokenizes the item on-chain, and manages the rental lifecycle with Redbox-style dynamic rates.

---

## Core Flow

### 1. Seller Lists (AI-Guided)

```
User: "I want to list something"
Agent: "What are you listing?"
User: "Golf clubs"
Agent: "What brand/model?"
User: "Callaway Rogue, 2022"
Agent: "Condition? (1-10)"
User: "7 — decent, some scuffs"
Agent: "Based on market data, I'd recommend $20/day.
        5-day rental = $100. Want to adjust?"
User: "Looks good"
Agent: → Mints item NFT with metadata + photos
      → Lists on marketplace
      → Sets pricing tiers
```

**The agent does the heavy lifting:**
- Asks smart questions (category → brand → condition → photos)
- Pulls market comps to suggest pricing
- Generates the listing description
- Mints the tokenized listing on Solana

### 2. Item Tokenization (Solana)

Each listed item becomes an on-chain token:
- **Metadata:** item description, condition, photos (stored on Arweave/IPFS)
- **Pricing rules:** base daily rate, overage multiplier
- **Rental state:** available / rented / overdue
- **Owner wallet:** seller's Solana address

### 3. Buyer Rents (Redbox Model)

```
Buyer browses → finds golf clubs at $20/day
Buyer selects rental period: 5 days ($100)
Buyer pays in SOL/USDC → escrow smart contract holds funds
Item token state: available → rented
Timer starts
```

**Dynamic pricing (Redbox-style):**
| Duration | Rate |
|----------|------|
| Days 1-5 (agreed period) | $20/day = $100 |
| Days 6-7 (grace overage) | $30/day (+50%) |
| Days 8+ (late penalty) | $50/day (+150%) |
| 30+ days overdue | Buyer charged full item value |

### 4. Return & Settlement

- Buyer returns item → seller confirms condition
- Smart contract releases escrow to seller
- Both parties rate each other → trust scores update
- Item token state: rented → available

---

## Trust & Verification Layer

This is where **Maiat Protocol** ties in:

### Seller Trust
- **Listing accuracy score:** Do items match descriptions? (rated by renters)
- **Response time:** How fast do they hand off items?
- **History:** Number of successful rentals, disputes, ratings

### Buyer Trust
- **Care score:** Do they return items in same condition?
- **Timeliness:** Do they return on time or go overdue?
- **Payment reliability:** Clean payment history?

### How it works
- New users start with a base trust score
- Each completed rental updates both parties' scores
- Trust scores are on-chain (Maiat) — portable across platforms
- Higher trust = lower deposit requirements
- Low trust = higher deposits or blocked from high-value items

### Full Retail Price Backstop (No Insurance Needed)
- AI agent auto-fetches the **brand-new retail price** during listing (e.g., Callaway Rogue clubs = $1,800 new)
- Renter's escrow deposit = full retail price (scaled by trust score)
  - High trust renter → lower deposit (e.g., 50% retail)
  - New/low trust renter → full retail price held in escrow
- **If renter doesn't return the item:** seller keeps the full retail escrow — they come out ahead
- **If renter ghosts on payment:** Maiat trust score craters → no one will rent to them again
- No insurance companies, no claims process — the smart contract handles everything automatically
- Deposit returned on clean return, partially kept on damage

### Growth Strategy — Neighborhood-First
- Start hyper-local: one neighborhood, general items (tools, sports gear, kitchen, electronics)
- Density matters more than breadth — better to have 50 listings in one zip code than 500 across a city
- Grow block by block → neighborhood → city — year-round demand (not seasonal like campus)
- Word of mouth in tight communities = organic growth engine

---

## Tech Stack

| Layer | Tech | Why |
|-------|------|-----|
| Smart contracts | Solana (Anchor) | Fast, cheap, hackathon track |
| Item tokens | Metaplex Token Metadata | Standard NFT infra |
| Storage | Arweave / IPFS | Decentralized image/metadata storage |
| AI Agent | 11 Labs (voice) + LLM | Conversational listing flow, voice-first mobile |
| Frontend | Next.js + Solana Wallet Adapter | Fast to build, web3-native |
| Mobile | Solana Mobile (Saga/dApp Store) | Hackathon track, snap photos → list |
| Trust | Maiat Protocol | On-chain trust scores |
| Cross-chain | LiFi | Accept payments from any chain |

---

## Hackathon Track Alignment

| Track | How we use it |
|-------|--------------|
| **Solana** | Item tokenization, escrow contracts, on-chain rental state |
| **Solana Mobile** | Camera → AI agent → list in 60 sec from your phone |
| **11 Labs** | Voice-first listing: talk to the agent instead of typing |
| **Virtuals** | AI agent personality that guides the rental flow |
| **LiFi** | Cross-chain payments — rent with ETH, MATIC, etc., settled on Solana |

---

## MVP Scope (9-hour build)

### Must Have (Demo-able)
1. **AI listing agent** — conversational flow that asks questions and generates a listing
2. **Solana token mint** — item becomes an NFT with metadata
3. **Marketplace UI** — browse available items, see prices, rental periods
4. **Rent action** — connect wallet, pay, item state changes to "rented"
5. **Dynamic pricing display** — show Redbox-style rate tiers

### Nice to Have
6. Voice listing via 11 Labs ("Hey, I want to list my golf clubs")
7. Trust score display (Maiat integration)
8. LiFi cross-chain payment widget
9. Return flow + condition verification
10. Mobile-optimized camera upload

### Cut for Hackathon
- Actual physical item logistics
- Dispute resolution system
- Chat between buyer/seller
- Full deposit/escrow smart contract (mock it)

---

## Smart Contract (Simplified)

```rust
// RentChain Program (Anchor)

#[account]
pub struct RentalListing {
    pub owner: Pubkey,           // seller wallet
    pub item_mint: Pubkey,       // NFT mint address
    pub daily_rate: u64,         // lamports per day
    pub overage_multiplier: u8,  // e.g., 150 = 1.5x after agreed period
    pub status: RentalStatus,    // Available, Rented, Overdue
    pub renter: Option<Pubkey>,  // current renter
    pub rental_start: i64,       // unix timestamp
    pub rental_days: u8,         // agreed rental period
    pub deposit: u64,            // security deposit held
}

enum RentalStatus {
    Available,
    Rented,
    Overdue,
    Returned,
}

// Instructions:
// - create_listing(metadata, daily_rate, overage_multiplier)
// - rent_item(rental_days) → transfers payment + deposit to escrow
// - return_item() → seller confirms, releases escrow
// - claim_overdue() → seller claims deposit after 30 days
```

---

## Revenue Model (Post-Hackathon)

- **Platform fee:** 5% of each rental transaction
- **Premium listings:** Featured placement, verified badge
- **Trust-as-a-service:** Charge other platforms to query RentChain trust scores
- **Insurance upsell:** Optional damage protection (partner with DeFi insurance)

---

## Competitive Advantage

1. **AI-first UX** — No forms, no guesswork. Talk to an agent, item is listed.
2. **Tokenized trust** — Portable reputation that follows you across platforms
3. **Redbox pricing** — Simple, familiar model that incentivizes timely returns
4. **Any item** — Not limited to a category. Golf clubs today, camera gear tomorrow, luxury bags next week.
5. **Solana speed** — Rental state changes in <1 second, fees under $0.01

---

## Team Split (Suggested)

- **Person 1:** Smart contract (Anchor) — listing, rent, return
- **Person 2:** Frontend + AI agent integration — listing flow, marketplace UI
- **Shared:** Demo prep, slide deck, recording

---

## Demo Script (2 min)

1. **Open app** → "I have golf clubs I want to rent out"
2. **AI agent conversation** → asks questions, suggests $20/day
3. **Item minted on Solana** → show explorer link
4. **Switch to buyer view** → browse marketplace, see golf clubs
5. **Rent for 5 days** → connect wallet, pay $100 + deposit
6. **Show dynamic pricing** → "If you keep them past day 5, rates go up"
7. **Show trust scores** → "Both parties build reputation with every rental"
8. **Closing:** "RentChain — rent anything, trust everyone, powered by Solana"
