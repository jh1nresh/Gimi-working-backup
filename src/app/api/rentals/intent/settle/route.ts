import { NextRequest, NextResponse } from "next/server";
import { getRentalIntentsRepository } from "@/lib/rentalIntentsRepository";
import { getRentalReceiptsRepository } from "@/lib/rentalReceiptsRepository";
import { getNotificationsRepository, newNotification } from "@/lib/notificationsRepository";
import { executionProvenanceReady, recordExecutionEventsSafely } from "@/lib/rentalExecutionEvents";
import { verifyOwnerActionProof } from "@/lib/ownerActionProof";

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
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
  const action = typeof body.action === "string" ? body.action.trim() : "";

  if (!intentId) return errorResponse("intentId is required", 400);
  if (!ownerWallet || ownerWallet.length > 140) return errorResponse("ownerWallet is required", 400);
  if (action !== "confirm_card_return" && action !== "confirm_provider_return") {
    return errorResponse("action must be confirm_card_return or confirm_provider_return", 400);
  }

  try {
    const repository = getRentalIntentsRepository();
    const intent = await repository.getById(intentId);
    if (!intent) return errorResponse("Rental intent not found", 404);
    if (intent.ownerWallet !== ownerWallet) return errorResponse("Only the owner wallet can settle this reservation", 403);
    verifyOwnerActionProof({ proof: body.ownerProof, action, intentId, ownerWallet });
    const isProviderFunded = intent.paymentMethod === "card" || intent.paymentMethod === "base_mcp";
    if (!isProviderFunded) return errorResponse("Only provider-funded reservations use this settlement path", 400);
    if (intent.paymentStatus !== "confirmed") return errorResponse("Provider payment must be confirmed before settlement", 409, { intent });
    if (intent.sessionStatus !== "active") return errorResponse("Provider-funded rental must be active before return settlement", 409, { intent });

    const now = new Date().toISOString();
    const fee = money(Math.min(intent.depositAmount, Math.max(intent.rentAmount, meteredFee(intent, now))));
    const platformFee = money(Math.min(fee, intent.platformFeeEstimate || fee * 0.05));
    const ownerPayout = money(Math.max(0, fee - platformFee));
    const renterRefund = money(Math.max(0, intent.depositAmount - fee));

    let updatedIntent = await repository.save({
      ...intent,
      sessionStatus: "returned",
      receiptStatus: intent.paymentMethod === "base_mcp" ? "issued" : "pending_onchain",
      returnedAt: now,
      finalFee: fee,
      ownerPayout,
      platformFee,
      renterRefund,
      settlementStatus: intent.paymentMethod === "base_mcp" ? "settled" : "pending_provider",
      notes:
        intent.paymentMethod === "base_mcp"
          ? "Owner confirmed Base MCP return. Gimi recorded the off-chain payout/refund receipt against the Base payment transaction."
          : intent.provider === "stripe_redbox"
            ? "Owner confirmed return. Owner-signed Solana receipt will capture the final Stripe amount and release unused authorization."
            : "Owner confirmed card-funded return. Provider refund/payout and Solana receipt issuance are pending.",
      updatedAt: now,
    });
    let receipt = null;
    if (updatedIntent.paymentMethod === "base_mcp") {
      const rentalId = updatedIntent.rentalId || updatedIntent.id;
      const receiptSignature = updatedIntent.providerPaymentId || `offchain:base_mcp:${updatedIntent.id}`;
      receipt = await getRentalReceiptsRepository().save({
        id: `receipt_${rentalId}`,
        rentalId,
        itemId: updatedIntent.itemId,
        sessionPda: `base_mcp:${updatedIntent.id}`,
        itemPda: `base_mcp:${updatedIntent.itemId}`,
        ownerWallet: updatedIntent.ownerWallet,
        renterWallet: updatedIntent.renterWallet || `base_mcp:${updatedIntent.renterIdentity || updatedIntent.id}`,
        paymentMint: "BASE_USDC",
        outcome: "returned_ok",
        settlementSignature: receiptSignature,
        grossFee: moneyToBaseUnits(updatedIntent.finalFee),
        platformFee: moneyToBaseUnits(updatedIntent.platformFee),
        ownerPayout: moneyToBaseUnits(updatedIntent.ownerPayout),
        renterRefund: moneyToBaseUnits(updatedIntent.renterRefund),
        rentalTokenStatus: "burned",
        createdAt: now,
      });
      updatedIntent = await repository.save({
        ...updatedIntent,
        receiptSignature,
        receiptIssuedAt: now,
        updatedAt: now,
      });
    }
    if (updatedIntent.renterWallet) {
      await getNotificationsRepository().save(
        newNotification({
          wallet: updatedIntent.renterWallet,
          kind: "rental_returned",
          title: "Return confirmed",
          body: `${updatedIntent.itemName} return was recorded. Estimated refund: ${renterRefund} ${updatedIntent.currency}.`,
        })
      );
    }
    await getNotificationsRepository().save(
      newNotification({
        wallet: updatedIntent.ownerWallet,
        kind: updatedIntent.paymentMethod === "base_mcp" ? "receipt_issued" : "rental_returned",
        title: updatedIntent.paymentMethod === "base_mcp" ? "Base rental receipt saved" : "Card rental settled",
        body: `${updatedIntent.itemName} return ledger is recorded. Host payout: ${ownerPayout} ${updatedIntent.currency}.`,
      })
    );
    const paymentMode = updatedIntent.paymentMethod === "base_mcp" ? "onchain_confirmed" : "provider_authorized";
    const executionTraceStatus = await recordExecutionEventsSafely([
      {
        eventKey: "owner-return-confirmed",
        intentId: updatedIntent.id,
        rentalId: updatedIntent.rentalId,
        itemId: updatedIntent.itemId,
        step: "return_confirmed",
        actor: "owner",
        tool: "POST /api/rentals/intent/settle",
        summary: "Owner confirmed the physical return and condition outcome.",
        approvalRequired: true,
        status: "completed",
        paymentMode,
        recordRef: `intent:${updatedIntent.id}`,
      },
      {
        eventKey: "settlement-calculated",
        intentId: updatedIntent.id,
        rentalId: updatedIntent.rentalId,
        itemId: updatedIntent.itemId,
        step: "settlement_completed",
        actor: updatedIntent.paymentMethod === "base_mcp" ? "chain" : "gimi_agent",
        tool: "deterministic settlement",
        summary: `Calculated ${fee} ${updatedIntent.currency} fee, ${ownerPayout} owner payout, and ${renterRefund} renter refund.`,
        approvalRequired: false,
        status: updatedIntent.paymentMethod === "base_mcp" ? "completed" : "waiting",
        paymentMode,
        recordRef: `intent:${updatedIntent.id}`,
      },
    ]);

    return NextResponse.json({
      intent: updatedIntent,
      executionTraceStatus,
      settlement: {
        finalFee: fee,
        ownerPayout,
        platformFee,
        renterRefund,
        settlementStatus: updatedIntent.settlementStatus,
      },
      receipt,
      nextAction:
        updatedIntent.paymentMethod === "base_mcp"
          ? "base_mcp_receipt_available_in_history"
          : updatedIntent.provider === "stripe_redbox"
            ? "owner_sign_solana_receipt_to_capture_stripe_authorization"
            : "provider_refund_payout_then_issue_solana_receipt",
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to settle card rental", 400);
  }
}

function meteredFee(intent: { activatedAt?: string; rentAmount: number; durationHours: number }, nowIso: string) {
  if (!intent.activatedAt) return intent.rentAmount;
  const elapsedMs = Math.max(0, Date.parse(nowIso) - Date.parse(intent.activatedAt));
  const elapsedHours = elapsedMs / 3_600_000;
  const plannedHours = Math.max(1, Number(intent.durationHours || 1));
  const hourlyRate = intent.rentAmount / plannedHours;
  return hourlyRate * Math.min(plannedHours, Math.max(elapsedHours, 1 / 60));
}

function money(value: number) {
  return Number(value.toFixed(2));
}

function moneyToBaseUnits(value: number | undefined) {
  return String(Math.round(Number(value || 0) * 1_000_000));
}
