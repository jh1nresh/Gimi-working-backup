import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getRentalIntentsRepository } from "@/lib/rentalIntentsRepository";
import { getRentalReceiptsRepository } from "@/lib/rentalReceiptsRepository";
import { getNotificationsRepository, newNotification } from "@/lib/notificationsRepository";
import { SOLANA_RPC_URL, assertConfirmedSignature } from "@/lib/rentproofProgram";
import { getStripeRedbox } from "@/lib/stripeRedbox";
import { executionProvenanceReady, recordExecutionEventsSafely } from "@/lib/rentalExecutionEvents";
import { assertCardReceiptMessage, buildCardReceiptMemo } from "@/lib/cardReceipt";

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const CARD_PAYMENT_MINT = "USD_CARD";

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

function moneyToBaseUnits(value: number | undefined) {
  return String(Math.round(Number(value || 0) * 1_000_000));
}

async function assertReceiptTransaction(connection: Connection, signature: string, ownerWallet: string, expectedMemo: string) {
  const transaction = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!transaction) throw new Error("Receipt transaction details were not found on devnet");

  const message = transaction.transaction.message;
  assertCardReceiptMessage({
    accountKeys: message.staticAccountKeys.map((key) => key.toBase58()),
    numRequiredSignatures: message.header.numRequiredSignatures,
    instructions: message.compiledInstructions,
    ownerWallet,
    expectedMemo,
  });
}

export async function POST(req: NextRequest) {
  if (!executionProvenanceReady()) return errorResponse("Execution provenance is not configured", 503);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const intentId = typeof body.intentId === "string" ? body.intentId.trim() : "";
  const ownerWallet = typeof body.ownerWallet === "string" ? body.ownerWallet.trim() : "";
  const signature = typeof body.receiptSignature === "string" ? body.receiptSignature.trim() : "";

  if (!intentId) return errorResponse("intentId is required", 400);
  if (!ownerWallet || ownerWallet.length > 140) return errorResponse("ownerWallet is required", 400);
  if (!SIGNATURE_PATTERN.test(signature)) return errorResponse("receiptSignature must be a Solana transaction signature", 400);

  try {
    new PublicKey(ownerWallet);
  } catch {
    return errorResponse("ownerWallet must be a Solana address", 400);
  }

  try {
    const intentsRepository = getRentalIntentsRepository();
    const receiptsRepository = getRentalReceiptsRepository();
    const intent = await intentsRepository.getById(intentId);
    if (!intent) return errorResponse("Rental intent not found", 404);
    if (intent.ownerWallet !== ownerWallet) return errorResponse("Only the owner wallet can issue this receipt", 403);
    if (intent.paymentMethod !== "card") return errorResponse("Only card reservations use card receipt issuance", 400);
    if (intent.paymentStatus !== "confirmed") return errorResponse("Card payment must be confirmed before receipt issuance", 409, { intent });
    if (intent.sessionStatus !== "returned") return errorResponse("Card rental must be returned before receipt issuance", 409, { intent });

    const connection = new Connection(SOLANA_RPC_URL, "confirmed");
    await assertConfirmedSignature(connection, signature);
    const expectedMemo = buildCardReceiptMemo({
      intentId: intent.id,
      rentalId: intent.rentalId || intent.id,
      itemId: intent.itemId,
      ownerWallet: intent.ownerWallet,
      renterWallet: intent.renterWallet || `card:${intent.renterIdentity || intent.id}`,
      finalFee: intent.finalFee ?? 0,
      ownerPayout: intent.ownerPayout ?? 0,
      platformFee: intent.platformFee ?? 0,
      renterRefund: intent.renterRefund ?? 0,
      currency: intent.currency,
      returnedAt: intent.returnedAt || "",
    });
    await assertReceiptTransaction(connection, signature, ownerWallet, expectedMemo);

    let providerSettlement = null;
    if (intent.provider === "stripe_redbox") {
      if (!intent.providerPaymentId) return errorResponse("Stripe authorization id is missing", 409, { intent });
      const redbox = getStripeRedbox();
      if (!redbox) return errorResponse("Stripe TEST payments are not configured", 503);
      providerSettlement = await redbox.settleAuthorization({
        paymentIntentId: intent.providerPaymentId,
        intentId: intent.id,
        finalAmount: intent.finalFee ?? 0,
      });
    }

    const now = new Date().toISOString();
    const rentalId = intent.rentalId || intent.id;
    const renterWallet = intent.renterWallet || `card:${intent.renterIdentity || intent.id}`;
    const receipt = await receiptsRepository.save({
      id: `receipt_${rentalId}`,
      rentalId,
      itemId: intent.itemId,
      sessionPda: `card:${intent.id}`,
      itemPda: `card:${intent.itemId}`,
      ownerWallet: intent.ownerWallet,
      renterWallet,
      paymentMint: CARD_PAYMENT_MINT,
      outcome: "returned_ok",
      settlementSignature: signature,
      grossFee: moneyToBaseUnits(intent.finalFee),
      platformFee: moneyToBaseUnits(intent.platformFee),
      ownerPayout: moneyToBaseUnits(intent.ownerPayout),
      renterRefund: moneyToBaseUnits(intent.renterRefund),
      rentalTokenStatus: "burned",
      createdAt: now,
    });
    const updatedIntent = await intentsRepository.save({
      ...intent,
      receiptStatus: "issued",
      receiptSignature: signature,
      receiptIssuedAt: now,
      escrowStatus: intent.provider === "stripe_redbox" ? "provider_captured" : intent.escrowStatus,
      settlementStatus: intent.provider === "stripe_redbox" ? "settled" : intent.settlementStatus,
      notes:
        intent.provider === "stripe_redbox"
          ? "Owner-signed Solana receipt verified. Stripe captured the final rental fee and released the unused authorization."
          : "Card-funded return has a Solana memo receipt. Provider payout/refund reconciliation remains on the payment provider rail.",
      updatedAt: now,
    });
    const notification = {
      kind: "receipt_issued" as const,
      title: "Solana receipt issued",
      body: `${updatedIntent.itemName} now has an on-chain receipt.`,
      href: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    };
    await getNotificationsRepository().save(
      newNotification({
        wallet: updatedIntent.ownerWallet,
        ...notification,
      })
    );
    if (updatedIntent.renterWallet) {
      await getNotificationsRepository().save(
        newNotification({
          wallet: updatedIntent.renterWallet,
          ...notification,
        })
      );
    }
    const providerSettlementCompleted = updatedIntent.provider === "stripe_redbox";
    const executionTraceStatus = await recordExecutionEventsSafely([
      {
        eventKey: "provider-settlement-completed",
        intentId: updatedIntent.id,
        rentalId: updatedIntent.rentalId,
        itemId: updatedIntent.itemId,
        step: "settlement_completed",
        actor: "payment_provider",
        tool: updatedIntent.provider === "stripe_redbox" ? "Stripe partial capture" : "provider reconciliation",
        summary: providerSettlementCompleted
          ? `Settlement finalized with ${updatedIntent.ownerPayout ?? 0} ${updatedIntent.currency} owner payout and ${updatedIntent.renterRefund ?? 0} ${updatedIntent.currency} refund.`
          : "On-chain receipt verified; payment provider payout and refund reconciliation remain pending.",
        approvalRequired: false,
        status: providerSettlementCompleted ? "completed" : "waiting",
        paymentMode: "provider_authorized",
        recordRef: `intent:${updatedIntent.id}`,
      },
      {
        eventKey: "solana-receipt-issued",
        intentId: updatedIntent.id,
        rentalId: updatedIntent.rentalId,
        itemId: updatedIntent.itemId,
        step: "receipt_issued",
        actor: "chain",
        tool: "Solana Memo receipt",
        summary: "Verified owner-signed Solana receipt and persisted the settlement record.",
        approvalRequired: true,
        status: "completed",
        paymentMode: "onchain_confirmed",
        recordRef: signature,
      },
    ]);

    return NextResponse.json({
      intent: updatedIntent,
      executionTraceStatus,
      receipt,
      providerSettlement,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to issue card receipt", 400);
  }
}
