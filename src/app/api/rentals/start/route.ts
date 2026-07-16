import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getRentableItem } from "@/lib/rentableItems";
import { getListingsRepository } from "@/lib/listingsRepository";
import { getRentalIntentsRepository } from "@/lib/rentalIntentsRepository";
import { getRentalSessionsRepository } from "@/lib/rentalSessionsRepository";
import {
  RENTAL_ITEM_STATUS_RENTED,
  RENTAL_SESSION_PROGRAM_ID,
  RENTAL_SESSION_STATUS_ACTIVE,
  SOLANA_RPC_URL,
  assertConfirmedSignature,
  decodeRentalItemAccount,
  decodeRentalSessionAccount,
  deriveRentProofAccounts,
  usdcBaseUnits,
} from "@/lib/rentproofProgram";

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
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
  const renterWallet = typeof body.renterWallet === "string" ? body.renterWallet : "";
  const intentId = typeof body.intentId === "string" ? body.intentId.trim() : "";
  const startSignature =
    typeof body.startSignature === "string"
      ? body.startSignature.trim()
      : typeof body.startRentalSignature === "string"
        ? body.startRentalSignature.trim()
        : "";

  if (!itemId) return errorResponse("itemId is required", 400);
  if (!rentalId) return errorResponse("rentalId is required", 400);
  if (!renterWallet) return errorResponse("renterWallet is required", 400);
  if (!SIGNATURE_PATTERN.test(startSignature)) {
    return errorResponse("startSignature must be a Solana transaction signature", 400);
  }

  try {
    const item = await getRentableItem(itemId);
    if (!item) return errorResponse("Item not found", 404);

    const rentProof = deriveRentProofAccounts({
      itemId,
      ownerWallet: item.owner,
      renterWallet,
      rentalId,
    });
    const connection = new Connection(SOLANA_RPC_URL, "confirmed");

    await assertConfirmedSignature(connection, startSignature);

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
    const expectedEscrowAmount = BigInt(usdcBaseUnits(item.buyoutCap));

    if (
      itemAccount.status !== RENTAL_ITEM_STATUS_RENTED ||
      itemAccount.activeSession !== rentProof.accounts.session ||
      itemAccount.owner !== rentProof.accounts.owner ||
      itemAccount.paymentMint !== rentProof.accounts.paymentMint
    ) {
      return errorResponse("On-chain item account does not reflect an active rental", 400, { rentProof });
    }

    if (
      sessionAccount.status !== RENTAL_SESSION_STATUS_ACTIVE ||
      sessionAccount.item !== rentProof.accounts.item ||
      sessionAccount.renter !== rentProof.accounts.renter ||
      sessionAccount.owner !== rentProof.accounts.owner ||
      sessionAccount.paymentMint !== rentProof.accounts.paymentMint ||
      sessionAccount.rentalIdHash !== rentProof.rentalIdHash ||
      sessionAccount.escrowAmount !== expectedEscrowAmount
    ) {
      return errorResponse("On-chain rental session does not match the request", 400, { rentProof });
    }

    const now = new Date().toISOString();
    const session = await getRentalSessionsRepository().save({
      rentalId,
      rentalIdHash: rentProof.rentalIdHash,
      itemId,
      itemPda: rentProof.accounts.item,
      sessionPda: rentProof.accounts.session,
      rentalTokenPda: rentProof.accounts.rentalToken,
      escrowTokenAccount: rentProof.accounts.escrowTokenAccount,
      ownerWallet: rentProof.accounts.owner,
      renterWallet: rentProof.accounts.renter,
      paymentMint: rentProof.accounts.paymentMint,
      startSignature,
      startTs: Number(sessionAccount.startTs),
      dueTs: Number(sessionAccount.dueTs),
      escrowAmount: sessionAccount.escrowAmount.toString(),
      expectedFeeAtStart: sessionAccount.expectedFeeAtStart.toString(),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const listing = await getListingsRepository().getById(itemId);
    const updatedListing = listing ? await getListingsRepository().updateStatus(itemId, "rented") : undefined;
    const intent = intentId ? await syncRentalIntent(intentId, session.rentalId) : undefined;

    return NextResponse.json({
      rentalSession: session,
      session,
      intent,
      listing: updatedListing,
      rentProof,
      explorerUrl: `https://explorer.solana.com/tx/${startSignature}?cluster=devnet`,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to record rental start", 400);
  }
}

async function syncRentalIntent(intentId: string, rentalId: string) {
  const repository = getRentalIntentsRepository();
  const intent = await repository.getById(intentId);
  if (!intent) return undefined;

  return repository.save({
    ...intent,
    rentalId,
    paymentStatus: "confirmed",
    escrowStatus: "onchain_locked",
    sessionStatus: "active",
    receiptStatus: "pending_onchain",
    updatedAt: new Date().toISOString(),
  });
}
