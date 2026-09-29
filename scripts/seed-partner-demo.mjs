import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FileRentalExecutionEventsRepository,
  newExecutionEvent,
} from "../src/lib/rentalExecutionEvents.ts";

if (process.env.VERCEL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) {
  throw new Error("The partner demo seed is local-only and refuses durable or deployed storage");
}

const dataDir = path.join(process.cwd(), ".rentproof");
const intentPath = path.join(dataDir, "rental-intents.json");
const receiptPath = path.join(dataDir, "rental-receipts.json");
const eventPath = path.join(dataDir, "rental-execution-events.json");
const ownerWallet = "7Fmr5t2h2SZ55n4w3dkgWTjaXRafDnBLLy1RhdmPJk6b";
const renterWallet = "5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC";
const intentId = "intent_seeded_partner_powerbank";
const rentalId = "rental_seeded_partner_powerbank";
const baseTime = Date.parse("2026-07-11T09:00:00.000Z");

const intent = {
  id: intentId,
  itemId: "power_bank_18",
  itemName: "Power Bank #18",
  ownerWallet,
  renterWallet,
  renterIdentity: "seeded-demo-renter",
  paymentMethod: "card",
  paymentStatus: "confirmed",
  escrowStatus: "provider_captured",
  sessionStatus: "returned",
  receiptStatus: "issued",
  currency: "USD",
  durationHours: 3,
  rentAmount: 6,
  depositAmount: 30,
  platformFeeEstimate: 0.3,
  provider: "seeded_demo",
  providerPaymentId: "seeded_demo_payment",
  rentalId,
  activatedAt: new Date(baseTime + 6 * 60_000).toISOString(),
  returnedAt: new Date(baseTime + 180 * 60_000).toISOString(),
  finalFee: 6,
  ownerPayout: 5.7,
  platformFee: 0.3,
  renterRefund: 24,
  settlementStatus: "settled",
  receiptSignature: `offchain:seeded_demo:${rentalId}`,
  receiptIssuedAt: new Date(baseTime + 185 * 60_000).toISOString(),
  notes: "Seeded demo only. No provider charge or chain transaction occurred.",
  expiresAt: new Date(baseTime + 24 * 60 * 60_000).toISOString(),
  createdAt: new Date(baseTime).toISOString(),
  updatedAt: new Date(baseTime + 185 * 60_000).toISOString(),
};

const receipt = {
  id: `receipt_${rentalId}`,
  rentalId,
  itemId: "power_bank_18",
  sessionPda: `seeded_demo:${intentId}`,
  itemPda: "seeded_demo:power_bank_18",
  ownerWallet,
  renterWallet,
  paymentMint: "USD_CARD",
  outcome: "returned_ok",
  settlementSignature: `offchain:seeded_demo:${rentalId}`,
  grossFee: "6000000",
  platformFee: "300000",
  ownerPayout: "5700000",
  renterRefund: "24000000",
  rentalTokenStatus: "burned",
  createdAt: new Date(baseTime + 185 * 60_000).toISOString(),
};

const steps = [
  ["intent_received", "renter", "chat intent", "Requested a power bank for three hours.", false, "simulated", 0],
  ["inventory_searched", "gimi_agent", "inventory search", "Checked bounded community inventory and availability.", false, "simulated", 1],
  ["offer_selected", "gimi_agent", "offer ranking", "Selected Power Bank #18 for availability, distance, and total cost.", false, "simulated", 2],
  ["terms_drafted", "gimi_agent", "deterministic pricing", "Drafted a 6 USD fee and 30 USD refundable cap.", false, "simulated", 3],
  ["approval_requested", "renter", "demo card approval", "Renter approved the test-only funding step.", true, "simulated", 4],
  ["rental_funded", "payment_provider", "seeded provider", "Recorded simulated funding; no real money moved.", false, "simulated", 5],
  ["handoff_confirmed", "owner", "owner handoff", "Owner confirmed physical handoff.", true, "simulated", 6],
  ["return_confirmed", "owner", "owner return", "Owner confirmed timely return and item condition.", true, "simulated", 180],
  ["settlement_completed", "gimi_agent", "deterministic settlement", "Calculated 5.70 USD owner payout and 24 USD renter refund.", false, "simulated", 183],
  ["receipt_issued", "gimi_agent", "seeded receipt fixture", "Stored a clearly labeled off-chain seeded-demo receipt.", true, "simulated", 185],
];

await mkdir(dataDir, { recursive: true });
await upsertJson(intentPath, intent);
await upsertJson(receiptPath, receipt);
const eventRepository = new FileRentalExecutionEventsRepository(eventPath);
for (const [step, actor, tool, summary, approvalRequired, paymentMode, minute] of steps) {
  await eventRepository.record(newExecutionEvent({
    eventKey: `seed-${step}`,
    intentId,
    rentalId,
    itemId: "power_bank_18",
    step,
    actor,
    tool,
    summary,
    approvalRequired,
    status: "completed",
    environment: "local",
    activityType: "seeded_demo",
    paymentMode,
    recordRef: `intent:${intentId}`,
    createdAt: new Date(baseTime + Number(minute) * 60_000).toISOString(),
  }));
}

console.log(JSON.stringify({
  seeded: true,
  activityType: "seeded_demo",
  paymentMode: "simulated",
  renterWallet,
  ownerWallet,
  intentId,
  note: "No real payment or chain activity was created.",
}, null, 2));

async function upsertJson(filePath, record) {
  const records = await readJson(filePath);
  const next = [record, ...records.filter((entry) => entry.id !== record.id)];
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function readJson(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
};
