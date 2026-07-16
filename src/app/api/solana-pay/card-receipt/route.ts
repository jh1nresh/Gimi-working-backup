import { NextRequest, NextResponse } from "next/server";
import { getRentableItem } from "@/lib/rentableItems";
import { getRentalIntentsRepository } from "@/lib/rentalIntentsRepository";
import { buildMemoReceiptTransaction } from "@/lib/rentproofProgram";
import { buildCardReceiptMemo } from "@/lib/cardReceipt";

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

  const intentId = typeof body.intentId === "string" ? body.intentId.trim() : "";
  const ownerWallet = typeof body.ownerWallet === "string" ? body.ownerWallet.trim() : "";

  if (!intentId) return errorResponse("intentId is required", 400);
  if (!ownerWallet || ownerWallet.length > 140) return errorResponse("ownerWallet is required", 400);

  try {
    const repository = getRentalIntentsRepository();
    const intent = await repository.getById(intentId);
    if (!intent) return errorResponse("Rental intent not found", 404);
    if (intent.ownerWallet !== ownerWallet) return errorResponse("Only the owner wallet can issue this receipt", 403);
    if (intent.paymentMethod !== "card") return errorResponse("Only card reservations use card receipt issuance", 400);
    if (intent.paymentStatus !== "confirmed") return errorResponse("Card payment must be confirmed before receipt issuance", 409, { intent });
    if (intent.sessionStatus !== "returned") return errorResponse("Card rental must be returned before receipt issuance", 409, { intent });
    if (intent.receiptStatus === "issued") return errorResponse("Solana receipt is already issued", 409, { intent });
    if (!intent.returnedAt) return errorResponse("Card return settlement timestamp is missing", 409, { intent });

    const rentalId = intent.rentalId || intent.id;
    const renterWallet = intent.renterWallet || `card:${intent.renterIdentity || intent.id}`;
    const memo = buildCardReceiptMemo({
      intentId: intent.id,
      rentalId,
      itemId: intent.itemId,
      ownerWallet: intent.ownerWallet,
      renterWallet,
      finalFee: intent.finalFee ?? 0,
      ownerPayout: intent.ownerPayout ?? 0,
      platformFee: intent.platformFee ?? 0,
      renterRefund: intent.renterRefund ?? 0,
      currency: intent.currency,
      returnedAt: intent.returnedAt,
    });
    const serialized = await buildMemoReceiptTransaction({ ownerWallet, receiptMemo: memo });
    const item = await getRentableItem(intent.itemId);

    return NextResponse.json({
      intentId: intent.id,
      rentalId,
      programStatus: "devnet_memo_receipt_unsigned_transaction_serialized",
      transaction: serialized.transactionBase64,
      message: `Issue a Solana memo receipt for returned card-funded rental ${item?.name || intent.itemName}.`,
      receiptMemo: memo,
      transactionMetadata: {
        cluster: serialized.cluster,
        rpcUrl: serialized.rpcUrl,
        blockhash: serialized.blockhash,
        lastValidBlockHeight: serialized.lastValidBlockHeight,
        feePayer: serialized.feePayer,
        requiredSigner: serialized.requiredSigner,
        memoProgram: serialized.memoProgram,
      },
      transactionPlan: [
        "owner_signs_memo_receipt",
        "write_card_return_settlement_summary_on_solana",
        "sync_signature_to_rental_receipts",
        "mark_card_intent_receipt_issued",
      ],
      item: {
        id: intent.itemId,
        name: item?.name || intent.itemName,
      },
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to prepare card receipt transaction", 400);
  }
}
