import { NextResponse } from "next/server";

const tools = [
  "gimi.search_inventory",
  "gimi.quote_rental",
  "gimi.prepare_base_deposit",
  "gimi.confirm_base_payment",
  "gimi.get_rental_status",
];

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  return NextResponse.json({
    name: "Gimi Base MCP Plugin",
    description:
      "Agent-callable community rental workflow for Base. The plugin searches inventory, quotes rental terms, and prepares user-approved Base USDC escrow calls.",
    mode: "read_prepare_only",
    safety: "Gimi never signs transactions, custodies keys, or broadcasts Base calls. Wallet approval is required through Base MCP or the user's wallet.",
    tools,
    endpoints: {
      inventory: `${origin}/api/base-plugin/gimi/inventory?query=wireless%20mic`,
      quote: `${origin}/api/base-plugin/gimi/quote?itemId=mic_11&hours=2`,
      prepareDeposit: `${origin}/api/base-plugin/gimi/prepare-deposit?itemId=mic_11&hours=2&from=0xUSER&escrow=0xESCROW`,
      paymentConfirmed: `${origin}/api/base-plugin/gimi/payment-confirmed`,
      status: `${origin}/api/base-plugin/gimi/status?wallet=0xUSER`,
      openapi: `${origin}/api/base-plugin/gimi/openapi.json`,
    },
    baseMcp: {
      chainIds: [8453, 84532],
      defaultChain: process.env.BASE_MCP_CHAIN ?? "base-sepolia",
      transactionExecutor: "Base MCP send_calls",
      userApprovalRequired: true,
    },
    production: {
      confirmationAuth:
        "Set BASE_MCP_CONFIRMATION_SECRET and call paymentConfirmed with Authorization: Bearer <secret> from a trusted backend or agent action.",
      confirmationExample: {
        method: "POST",
        url: `${origin}/api/base-plugin/gimi/payment-confirmed`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer $BASE_MCP_CONFIRMATION_SECRET",
        },
        body: {
          itemId: "mic_11",
          hours: 2,
          renterWallet: "0x000000000000000000000000000000000000dEaD",
          txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
          chain: "base-sepolia",
        },
      },
      docs: "docs/base-mcp-production.md",
    },
  });
}
