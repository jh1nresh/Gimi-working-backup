import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileRentalIntentsRepository, type PersistedRentalIntent } from "@/lib/rentalIntentsRepository";

function intent(): PersistedRentalIntent {
  return {
    id: "intent_1",
    itemId: "power_bank_18",
    itemName: "Power Bank #18",
    ownerWallet: "owner",
    paymentMethod: "card",
    paymentStatus: "requires_action",
    escrowStatus: "not_funded",
    sessionStatus: "intent",
    receiptStatus: "none",
    currency: "USD",
    durationHours: 3,
    rentAmount: 6,
    depositAmount: 30,
    platformFeeEstimate: 0.3,
    settlementStatus: "none",
    expiresAt: "2026-07-12T00:00:00.000Z",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

describe("rental intent conditional writes", () => {
  it("allows only one concurrent provider transition from the same version", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gimi-intents-"));
    const repository = new FileRentalIntentsRepository(path.join(directory, "intents.json"));
    const original = intent();
    await repository.save(original);

    const confirmed = {
      ...original,
      paymentStatus: "confirmed" as const,
      escrowStatus: "provider_captured" as const,
      sessionStatus: "reserved" as const,
      receiptStatus: "pending_onchain" as const,
      updatedAt: "2026-07-11T00:01:00.000Z",
    };
    const failed = {
      ...original,
      paymentStatus: "failed" as const,
      sessionStatus: "cancelled" as const,
      updatedAt: "2026-07-11T00:01:01.000Z",
    };
    const results = await Promise.all([
      repository.compareAndSave(confirmed, original.updatedAt),
      repository.compareAndSave(failed, original.updatedAt),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await repository.getById(original.id);
    expect(stored?.updatedAt).toBe(results.find(Boolean)?.updatedAt);
  });
});
