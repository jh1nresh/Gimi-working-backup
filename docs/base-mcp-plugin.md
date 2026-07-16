# Gimi Base MCP Plugin

Gimi's Base MCP integration is a read/prepare plugin surface for agentic rental checkout. It lets an agent search inventory, quote rent plus deposit, and prepare a Base USDC call that a user can approve through Base MCP `send_calls` or a compatible wallet.

The plugin does not sign, broadcast, or custody funds.

## Plugin Surface

```text
GET /api/base-plugin/gimi
GET /api/base-plugin/gimi/inventory?query=wireless+mic
GET /api/base-plugin/gimi/quote?itemId=mic_11&hours=2
GET /api/base-plugin/gimi/prepare-deposit?itemId=mic_11&hours=2&from=0xUser&escrow=0xEscrow
POST /api/base-plugin/gimi/payment-confirmed
GET /api/base-plugin/gimi/status?wallet=0xUser
GET /api/base-plugin/gimi/openapi.json
```

For production setup, see [base-mcp-production.md](base-mcp-production.md).

## Base MCP Skill Prompt

```text
You are the Gimi rental agent for Base.

Use Gimi endpoints to help users rent nearby community inventory:
- Search inventory with /api/base-plugin/gimi/inventory.
- Quote rent and deposit with /api/base-plugin/gimi/quote.
- Prepare a Base USDC deposit call with /api/base-plugin/gimi/prepare-deposit.
- After the user approves the Base payment, call /api/base-plugin/gimi/payment-confirmed with itemId, hours, renterWallet, txHash, and chain.
- The owner must mark physical handoff, then confirm return. Gimi records payout/refund amounts and an off-chain receipt tied to the Base tx hash.
- Never sign or broadcast yourself. Ask the user to approve the returned call with Base MCP send_calls.
- Explain pickup, duration, deposit, estimated refund, and return expectations before payment.
```

## Prepare Deposit Output

`prepare-deposit` returns:

```json
{
  "baseMcp": {
    "executor": "send_calls",
    "userApprovalRequired": true,
    "calls": [
      {
        "chainId": 84532,
        "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "value": "0x0",
        "data": "0xa9059cbb..."
      }
    ]
  }
}
```

The first implementation uses ERC-20 USDC `transfer(escrow, amount)` calldata. The production version should replace this with a Base escrow contract call that records the rental id, due time, return confirmation, platform fee, owner payout, renter refund, and receipt issuance.

## Confirm Payment Output

After Base MCP returns a confirmed transaction hash, `payment-confirmed` creates a durable `rental_intent`:

```json
{
  "intent": {
    "paymentMethod": "base_mcp",
    "paymentStatus": "confirmed",
    "escrowStatus": "provider_captured",
    "sessionStatus": "reserved",
    "provider": "base_mcp",
    "providerPaymentId": "base:84532:0x..."
  },
  "nextAction": "owner_mark_handed_off"
}
```

Set `BASE_MCP_CONFIRMATION_SECRET` in production and call this endpoint with
`Authorization: Bearer <secret>` from a trusted agent/backend. Without that env
var, the endpoint remains caller-attested for local demos and should not be used
as a payment source of truth.

Production callback:

```bash
curl -s -X POST https://YOUR_GIMI_DOMAIN/api/base-plugin/gimi/payment-confirmed \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $BASE_MCP_CONFIRMATION_SECRET" \
  -d '{"itemId":"mic_11","hours":2,"renterWallet":"0x000000000000000000000000000000000000dEaD","txHash":"0x1111111111111111111111111111111111111111111111111111111111111111","chain":"base-sepolia"}'
```

The existing owner flow can then mark handoff and confirm return. For Base MCP-funded rentals, return settlement writes an off-chain receipt to Gimi history immediately, using the Base transaction as the settlement reference.

## Environment

```bash
BASE_MCP_CHAIN=base-sepolia
BASE_RENTAL_ESCROW_ADDRESS=0x...
BASE_MCP_CONFIRMATION_SECRET=...
BASE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
BASE_SEPOLIA_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

Only `BASE_RENTAL_ESCROW_ADDRESS` is required for `prepare-deposit` unless the caller supplies `escrow` as a query parameter.
