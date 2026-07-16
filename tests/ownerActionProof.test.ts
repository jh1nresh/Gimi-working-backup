import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { buildOwnerActionMessage, verifyOwnerActionProof } from "@/lib/ownerActionProof";

function proof(action: "mark_handed_off" | "confirm_card_return" = "mark_handed_off") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const address = bs58.encode(publicDer.subarray(-32));
  const issuedAt = "2026-07-11T12:00:00.000Z";
  const message = buildOwnerActionMessage({ action, intentId: "intent_1", ownerWallet: address, issuedAt });
  return {
    address,
    message,
    signature: bs58.encode(sign(null, Buffer.from(message), privateKey)),
  };
}

describe("owner action proof", () => {
  const now = new Date("2026-07-11T12:02:00.000Z");

  it("accepts an action-specific owner signature", () => {
    const signed = proof();
    expect(() =>
      verifyOwnerActionProof({ proof: signed, action: "mark_handed_off", intentId: "intent_1", ownerWallet: signed.address, now })
    ).not.toThrow();
  });

  it("rejects reuse for a different action or intent", () => {
    const signed = proof();
    expect(() =>
      verifyOwnerActionProof({ proof: signed, action: "confirm_card_return", intentId: "intent_1", ownerWallet: signed.address, now })
    ).toThrow("does not match");
    expect(() =>
      verifyOwnerActionProof({ proof: signed, action: "mark_handed_off", intentId: "intent_2", ownerWallet: signed.address, now })
    ).toThrow("does not match");
  });

  it("rejects expired and tampered signatures", () => {
    const signed = proof();
    expect(() =>
      verifyOwnerActionProof({
        proof: signed,
        action: "mark_handed_off",
        intentId: "intent_1",
        ownerWallet: signed.address,
        now: new Date("2026-07-11T12:06:00.001Z"),
      })
    ).toThrow("expired");
    expect(() =>
      verifyOwnerActionProof({
        proof: { ...signed, signature: bs58.encode(Buffer.alloc(64, 1)) },
        action: "mark_handed_off",
        intentId: "intent_1",
        ownerWallet: signed.address,
        now,
      })
    ).toThrow("invalid");
  });
});
