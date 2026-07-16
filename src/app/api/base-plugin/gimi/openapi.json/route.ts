import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const basePath = `${origin}/api/base-plugin/gimi`;

  return NextResponse.json({
    openapi: "3.1.0",
    info: {
      title: "Gimi Base MCP Plugin",
      version: "0.1.0",
      description:
        "Agent-callable rental workflow for Base. Search inventory, quote terms, prepare Base USDC calldata, confirm trusted Base MCP payment callbacks, and read rental status.",
    },
    servers: [{ url: basePath }],
    paths: {
      "/inventory": {
        get: {
          operationId: "searchInventory",
          summary: "Search nearby rentable inventory",
          parameters: [
            { name: "query", in: "query", schema: { type: "string" }, description: "Natural-language item query." },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 25 } },
          ],
          responses: {
            "200": { description: "Matching rentable items." },
          },
        },
      },
      "/quote": {
        get: {
          operationId: "quoteRental",
          summary: "Quote rent, deposit, and refund model",
          parameters: [
            { name: "itemId", in: "query", required: true, schema: { type: "string" } },
            { name: "hours", in: "query", schema: { type: "number", minimum: 1 } },
            { name: "chain", in: "query", schema: { type: "string", enum: ["base", "base-sepolia"] } },
          ],
          responses: {
            "200": { description: "Rental quote and Base payment rail metadata." },
            "404": { description: "Item not found." },
          },
        },
      },
      "/prepare-deposit": {
        get: {
          operationId: "prepareBaseDeposit",
          summary: "Prepare user-approved Base USDC deposit calldata",
          description:
            "Returns an ERC-20 USDC transfer call that Base MCP can submit with send_calls after user approval. Gimi does not sign or broadcast.",
          parameters: [
            { name: "itemId", in: "query", required: true, schema: { type: "string" } },
            { name: "hours", in: "query", schema: { type: "number", minimum: 1 } },
            { name: "from", in: "query", schema: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" } },
            {
              name: "escrow",
              in: "query",
              schema: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
              description: "Escrow wallet or contract address. Falls back to BASE_RENTAL_ESCROW_ADDRESS.",
            },
            { name: "chain", in: "query", schema: { type: "string", enum: ["base", "base-sepolia"] } },
          ],
          responses: {
            "200": { description: "Base MCP send_calls payload and calldata." },
            "400": { description: "Missing item id or escrow configuration." },
          },
        },
      },
      "/payment-confirmed": {
        post: {
          operationId: "confirmBasePayment",
          summary: "Persist a trusted Base MCP payment confirmation",
          description:
            "Production callers should set BASE_MCP_CONFIRMATION_SECRET and pass Authorization: Bearer <secret>. Without that env var, this endpoint is caller-attested demo mode.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["itemId", "renterWallet", "txHash"],
                  properties: {
                    itemId: { type: "string" },
                    hours: { type: "number", minimum: 1 },
                    renterWallet: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
                    renterIdentity: { type: "string" },
                    txHash: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
                    chain: { type: "string", enum: ["base", "base-sepolia"], default: "base-sepolia" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Persisted Base MCP rental intent." },
            "401": { description: "Bearer token required when BASE_MCP_CONFIRMATION_SECRET is set." },
          },
        },
      },
      "/status": {
        get: {
          operationId: "getRentalStatus",
          summary: "Read Base MCP-funded rentals and receipts for an EVM wallet",
          parameters: [
            { name: "wallet", in: "query", required: true, schema: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } },
          ],
          responses: {
            "200": { description: "Rental intents and receipts." },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Required only when BASE_MCP_CONFIRMATION_SECRET is configured.",
        },
      },
    },
    "x-gimi": {
      productionGuide: "docs/base-mcp-production.md",
      pluginManifest: `${basePath}`,
      safety: "Read/prepare by default. payment-confirmed requires a trusted caller in production.",
    },
  });
}
