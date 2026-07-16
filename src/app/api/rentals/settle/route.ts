import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { getListingsRepository } from "@/lib/listingsRepository";
import { getRentableItem } from "@/lib/rentableItems";
import { getRentalReceiptsRepository } from "@/lib/rentalReceiptsRepository";
import { getRentalSessionsRepository, RentalSessionStatus } from "@/lib/rentalSessionsRepository";
import {
  RENTAL_ITEM_STATUS_AVAILABLE,
  RENTAL_ITEM_STATUS_BUYOUT,
  RENTAL_SESSION_PROGRAM_ID,
  RENTAL_SESSION_STATUS_BUYOUT,
  RENTAL_SESSION_STATUS_RETURNED,
  SOLANA_RPC_URL,
  assertConfirmedSignature,
  decodeRentalItemAccount,
  decodeRentalSessionAccount,
  deriveRentProofAccounts,
} from "@/lib/rentproofProgram";

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

type SettlementKind = "return" | "buyout";

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

function settlementKind(value: unknown): SettlementKind | undefined {
  if (value === "return" || value === "confirm_return" || value === "returned") return "return";
  if (value === "buyout" || value === "auto_buyout") return "buyout";
  return undefined;
}

function settlementSignature(body: Record<string, unknown>, kind: SettlementKind) {
  const candidates =
    kind === "return"
      ? [body.settlementSignature, body.returnSignature, body.confirmReturnSignature]
      : [body.settlementSignature, body.autoBuyoutSignature, body.buyoutSignature];
  return candidates.find((value): value is string => typeof value === "string")?.trim() ?? "";
}

async function assertSettlementTransactionTouchesAccounts(
  connection: Connection,
  signature: string,
  rentProof: ReturnType<typeof deriveRentProofAccounts>
) {
  const transaction = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!transaction) throw new Error("Settlement transaction details were not found on devnet");

  const accountKeys = new Set(transaction.transaction.message.staticAccountKeys.map((key) => key.toBase58()));
  const requiredAccounts = [
    RENTAL_SESSION_PROGRAM_ID.toBase58(),
    rentProof.accounts.item,
    rentProof.accounts.session,
    rentProof.accounts.rentalToken,
    rentProof.accounts.escrowTokenAccount,
    rentProof.accounts.owner,
    rentProof.accounts.renter,
  ];
  const missingAccounts = requiredAccounts.filter((account) => !accountKeys.has(account));

  if (missingAccounts.length) {
    throw new Error("Settlement signature does not include the expected rental program accounts");
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  const rentalId = typeof body.rentalId === "string" ? body.rentalId : typeof body.draftId === "string" ? body.draftId : "";
  const kind = settlementKind(body.kind);

  if (!itemId) return errorResponse("itemId is required", 400);
  if (!rentalId) return errorResponse("rentalId is required", 400);
  if (!kind) return errorResponse("kind must be return or buyout", 400);

  const signature = settlementSignature(body, kind);
  if (!SIGNATURE_PATTERN.test(signature)) {
    return errorResponse("settlementSignature must be a Solana transaction signature", 400);
  }

  try {
    const [item, existingSession] = await Promise.all([
      getRentableItem(itemId),
      getRentalSessionsRepository().getByRentalId(rentalId),
    ]);

    if (!item) return errorResponse("Item not found", 404);
    if (!existingSession) {
      return errorResponse("Rental start must be recorded before settlement can be synced", 409);
    }
    if (existingSession.itemId !== itemId) {
      return errorResponse("Recorded rental session does not match itemId", 400);
    }

    const rentProof = deriveRentProofAccounts({
      itemId,
      ownerWallet: existingSession.ownerWallet,
      renterWallet: existingSession.renterWallet,
      rentalId,
    });
    const connection = new Connection(SOLANA_RPC_URL, "confirmed");

    await assertConfirmedSignature(connection, signature);
    await assertSettlementTransactionTouchesAccounts(connection, signature, rentProof);

    const [itemAccountInfo, sessionAccountInfo] = await Promise.all([
      connection.getAccountInfo(new PublicKey(rentProof.accounts.item), "confirmed"),
      connection.getAccountInfo(new PublicKey(rentProof.accounts.session), "confirmed"),
    ]);

    if (!itemAccountInfo) return errorResponse("Item PDA account was not found", 409, { rentProof });
    if (!itemAccountInfo.owner.equals(RENTAL_SESSION_PROGRAM_ID)) {
      return errorResponse("Item PDA is not owned by the Gimi rental program", 400, { rentProof });
    }
    if (!sessionAccountInfo) return errorResponse("Rental session PDA account was not found", 409, { rentProof });
    if (!sessionAccountInfo.owner.equals(RENTAL_SESSION_PROGRAM_ID)) {
      return errorResponse("Rental session PDA is not owned by the Gimi rental program", 400, { rentProof });
    }

    const itemAccount = decodeRentalItemAccount(itemAccountInfo.data);
    const sessionAccount = decodeRentalSessionAccount(sessionAccountInfo.data);
    const expectedSessionStatus = kind === "return" ? RENTAL_SESSION_STATUS_RETURNED : RENTAL_SESSION_STATUS_BUYOUT;
    const expectedItemStatus = kind === "return" ? RENTAL_ITEM_STATUS_AVAILABLE : RENTAL_ITEM_STATUS_BUYOUT;

    if (
      itemAccount.status !== expectedItemStatus ||
      itemAccount.activeSession !== SystemProgram.programId.toBase58() ||
      itemAccount.owner !== rentProof.accounts.owner ||
      itemAccount.paymentMint !== rentProof.accounts.paymentMint
    ) {
      return errorResponse("On-chain item account does not reflect the requested settlement", 400, { rentProof });
    }

    if (
      sessionAccount.status !== expectedSessionStatus ||
      sessionAccount.item !== rentProof.accounts.item ||
      sessionAccount.renter !== rentProof.accounts.renter ||
      sessionAccount.owner !== rentProof.accounts.owner ||
      sessionAccount.paymentMint !== rentProof.accounts.paymentMint ||
      sessionAccount.rentalIdHash !== rentProof.rentalIdHash
    ) {
      return errorResponse("On-chain rental session does not match the requested settlement", 400, { rentProof });
    }

    const now = new Date().toISOString();
    const sessionStatus: RentalSessionStatus = kind === "return" ? "returned" : "buyout";
    const session = await getRentalSessionsRepository().save({
      ...existingSession,
      returnedTs: Number(sessionAccount.returnedTs),
      finalFee: sessionAccount.finalFee.toString(),
      ownerPayout: sessionAccount.ownerPayout.toString(),
      platformFee: sessionAccount.platformFee.toString(),
      renterRefund: sessionAccount.renterRefund.toString(),
      returnSignature: kind === "return" ? signature : existingSession.returnSignature,
      autoBuyoutSignature: kind === "buyout" ? signature : existingSession.autoBuyoutSignature,
      settledAt: now,
      status: sessionStatus,
      updatedAt: now,
    });

    const listing = await getListingsRepository().getById(itemId);
    const updatedListing = listing
      ? await getListingsRepository().updateStatus(itemId, kind === "return" ? "available" : "buyout")
      : undefined;

    const receipt = await getRentalReceiptsRepository().save({
      id: `receipt_${rentalId}`,
      rentalId,
      itemId,
      sessionPda: rentProof.accounts.session,
      itemPda: rentProof.accounts.item,
      ownerWallet: rentProof.accounts.owner,
      renterWallet: rentProof.accounts.renter,
      paymentMint: rentProof.accounts.paymentMint,
      outcome: kind === "return" ? "returned_ok" : "auto_buyout",
      settlementSignature: signature,
      grossFee: sessionAccount.finalFee.toString(),
      platformFee: sessionAccount.platformFee.toString(),
      ownerPayout: sessionAccount.ownerPayout.toString(),
      renterRefund: sessionAccount.renterRefund.toString(),
      rentalTokenStatus: "burned",
      createdAt: now,
    });

    return NextResponse.json({
      rentalSession: session,
      session,
      receipt,
      listing: updatedListing,
      rentProof,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to sync rental settlement", 400);
  }
}
