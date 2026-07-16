import { describe, expect, it } from "vitest";
import { assertCardReceiptMessage } from "@/lib/cardReceipt";
import { MEMO_PROGRAM_ID } from "@/lib/rentproofProgram";

const owner = "Owner1111111111111111111111111111111111111";
const memo = "gimi-card-receipt:v1|intent=intent_1";

describe("card receipt verification", () => {
  it("requires the owner signer and exact memo", () => {
    expect(() =>
      assertCardReceiptMessage({
        accountKeys: [owner, MEMO_PROGRAM_ID.toBase58()],
        numRequiredSignatures: 1,
        instructions: [{ programIdIndex: 1, data: Buffer.from(memo) }],
        ownerWallet: owner,
        expectedMemo: memo,
      })
    ).not.toThrow();
  });

  it("rejects an owner present only as a non-signer", () => {
    expect(() =>
      assertCardReceiptMessage({
        accountKeys: ["OtherSigner11111111111111111111111111111111", owner, MEMO_PROGRAM_ID.toBase58()],
        numRequiredSignatures: 1,
        instructions: [{ programIdIndex: 2, data: Buffer.from(memo) }],
        ownerWallet: owner,
        expectedMemo: memo,
      })
    ).toThrow("not signed");
  });

  it("rejects a memo for another settlement", () => {
    expect(() =>
      assertCardReceiptMessage({
        accountKeys: [owner, MEMO_PROGRAM_ID.toBase58()],
        numRequiredSignatures: 1,
        instructions: [{ programIdIndex: 1, data: Buffer.from("different memo") }],
        ownerWallet: owner,
        expectedMemo: memo,
      })
    ).toThrow("does not match");
  });
});
