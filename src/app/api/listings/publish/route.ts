import { NextRequest, NextResponse } from "next/server";
import { PublicKey, Connection } from "@solana/web3.js";
import {
  normalizeListingPreview,
  persistedListingFromPreview,
} from "@/lib/listings";
import { getListingsRepository } from "@/lib/listingsRepository";
import {
  RENTAL_ITEM_STATUS_AVAILABLE,
  RENTAL_SESSION_PROGRAM_ID,
  SOLANA_CLUSTER,
  SOLANA_RPC_URL,
  decodeRentalItemAccount,
  deriveItemPda,
  ratePerSecondBaseUnits,
  usdcBaseUnits,
} from "@/lib/rentproofProgram";

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function assertConfirmedInitializeSignature(connection: Connection, signature: string) {
  const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = value[0];

  if (!status) throw new Error("initializeSignature was not found on devnet");
  if (status.err) throw new Error("initializeSignature failed on-chain");
  if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized" && status.confirmations !== null) {
    throw new Error("initializeSignature is not confirmed yet");
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  try {
    const draftId = typeof body.draftId === "string" ? body.draftId : "";
    const initializeSignature = typeof body.initializeSignature === "string" ? body.initializeSignature.trim() : "";

    if (!draftId) return errorResponse("draftId is required", 400);
    if (!SIGNATURE_PATTERN.test(initializeSignature)) {
      return errorResponse("initializeSignature must be a Solana transaction signature", 400);
    }

    const listingPreview = normalizeListingPreview(body.listingPreview);
    if (listingPreview.id !== draftId) {
      return errorResponse("draftId does not match listingPreview.id", 400);
    }

    const owner = new PublicKey(listingPreview.ownerWallet);
    const expectedItemPda = deriveItemPda(owner, Buffer.from(listingPreview.itemIdHash, "hex")).toBase58();
    if (expectedItemPda !== listingPreview.itemPda) {
      return errorResponse("listingPreview itemPda does not match owner and itemIdHash", 400);
    }

    const connection = new Connection(SOLANA_RPC_URL, "confirmed");
    await assertConfirmedInitializeSignature(connection, initializeSignature);

    const accountInfo = await connection.getAccountInfo(new PublicKey(listingPreview.itemPda), "confirmed");
    if (!accountInfo) {
      return errorResponse("Item PDA account was not found yet; retry after confirmation", 409);
    }
    if (!accountInfo.owner.equals(RENTAL_SESSION_PROGRAM_ID)) {
      return errorResponse("Item PDA is not owned by the RentProof program", 400);
    }

    const account = decodeRentalItemAccount(accountInfo.data);
    const expectedRatePerSecond = BigInt(ratePerSecondBaseUnits(listingPreview.ratePerHour));
    const expectedMinimumFee = BigInt(usdcBaseUnits(listingPreview.minimumFee));
    const expectedBuyoutCap = BigInt(usdcBaseUnits(listingPreview.buyoutCap));
    const expectedGraceSeconds = BigInt(listingPreview.autoBuyoutGraceSeconds);

    if (
      account.owner !== listingPreview.ownerWallet ||
      account.paymentMint !== listingPreview.paymentMint ||
      account.itemIdHash !== listingPreview.itemIdHash ||
      account.metadataHash !== listingPreview.metadataHash ||
      account.ratePerSecond !== expectedRatePerSecond ||
      account.minimumFee !== expectedMinimumFee ||
      account.buyoutCap !== expectedBuyoutCap ||
      account.autoBuyoutGraceSeconds !== expectedGraceSeconds ||
      account.status !== RENTAL_ITEM_STATUS_AVAILABLE
    ) {
      return errorResponse("On-chain item account does not match listingPreview", 400);
    }

    const listing = persistedListingFromPreview(listingPreview, initializeSignature);
    const repository = getListingsRepository();
    await repository.save(listing);

    return NextResponse.json({
      listing,
      explorerUrl: `https://explorer.solana.com/tx/${initializeSignature}?cluster=${SOLANA_CLUSTER}`,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to publish listing", 400);
  }
}
