import bs58 from "bs58";
import { MEMO_PROGRAM_ID } from "./rentproofProgram";

export interface CardReceiptMemoInput {
  intentId: string;
  rentalId: string;
  itemId: string;
  ownerWallet: string;
  renterWallet: string;
  finalFee: number;
  ownerPayout: number;
  platformFee: number;
  renterRefund: number;
  currency: string;
  returnedAt: string;
}

export function buildCardReceiptMemo(input: CardReceiptMemoInput) {
  return [
    "gimi-card-receipt:v1",
    `intent=${input.intentId}`,
    `rental=${input.rentalId}`,
    `item=${input.itemId}`,
    `owner=${input.ownerWallet}`,
    `renter=${input.renterWallet}`,
    `fee=${input.finalFee}`,
    `ownerPayout=${input.ownerPayout}`,
    `platformFee=${input.platformFee}`,
    `refund=${input.renterRefund}`,
    `currency=${input.currency}`,
    `returnedAt=${input.returnedAt}`,
  ].join("|");
}

export function assertCardReceiptMessage(input: {
  accountKeys: string[];
  numRequiredSignatures: number;
  instructions: Array<{ programIdIndex: number; data: Uint8Array | string }>;
  ownerWallet: string;
  expectedMemo: string;
}) {
  const signerKeys = input.accountKeys.slice(0, input.numRequiredSignatures);
  if (!signerKeys.includes(input.ownerWallet)) throw new Error("Receipt transaction was not signed by the owner wallet");

  const memoProgram = MEMO_PROGRAM_ID.toBase58();
  const hasExpectedMemo = input.instructions.some((instruction) => {
    if (input.accountKeys[instruction.programIdIndex] !== memoProgram) return false;
    const bytes = typeof instruction.data === "string" ? bs58.decode(instruction.data) : instruction.data;
    return Buffer.from(bytes).toString("utf8") === input.expectedMemo;
  });
  if (!hasExpectedMemo) throw new Error("Receipt transaction memo does not match this rental settlement");
}
