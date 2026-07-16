import { NextRequest, NextResponse } from "next/server";
import { getRentalIntentsRepository } from "@/lib/rentalIntentsRepository";
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
  if (action !== "mark_handed_off") return errorResponse("action must be mark_handed_off", 400);

  try {
    const repository = getRentalIntentsRepository();
    const intent = await repository.getById(intentId);
    if (!intent) return errorResponse("Rental intent not found", 404);
    if (intent.ownerWallet !== ownerWallet) return errorResponse("Only the owner wallet can activate this reservation", 403);
    verifyOwnerActionProof({ proof: body.ownerProof, action: "mark_handed_off", intentId, ownerWallet });
    if (intent.paymentMethod !== "card" && intent.paymentMethod !== "base_mcp") {
      return errorResponse("Only provider-funded reservations use this activation path", 400);
    }
    if (intent.paymentStatus !== "confirmed") return errorResponse("Provider payment must be confirmed before handoff", 409, { intent });
    if (intent.escrowStatus !== "provider_authorized" && intent.escrowStatus !== "provider_captured") {
      return errorResponse("Card escrow must be authorized or captured before handoff", 409, { intent });
    }
    if (intent.sessionStatus === "cancelled") return errorResponse("Cancelled reservations cannot be activated", 409, { intent });
    if (intent.sessionStatus === "active") return NextResponse.json({ intent, executionTraceStatus: "recorded", nextAction: "track_return_and_settle_provider_funded_rental" });
    if (intent.sessionStatus !== "reserved") return errorResponse("Reservation must be reserved before handoff", 409, { intent });

    const now = new Date().toISOString();
    const updatedIntent = await repository.save({
      ...intent,
      sessionStatus: "active",
      receiptStatus: intent.paymentMethod === "base_mcp" ? "none" : "pending_onchain",
      activatedAt: now,
      notes:
        intent.paymentMethod === "base_mcp"
          ? "Owner marked physical handoff complete for Base MCP-funded rental."
          : "Owner marked physical handoff complete for card-funded rental.",
      updatedAt: now,
    });
    if (updatedIntent.renterWallet) {
      await getNotificationsRepository().save(
        newNotification({
          wallet: updatedIntent.renterWallet,
          kind: "rental_handoff",
          title: "Rental is ready",
          body: `${updatedIntent.itemName} has been handed off. Return it to the owner pickup point when finished.`,
        })
      );
    }
    const executionTraceStatus = await recordExecutionEventsSafely([
      {
        eventKey: "owner-handoff-confirmed",
        intentId: updatedIntent.id,
        rentalId: updatedIntent.rentalId,
        itemId: updatedIntent.itemId,
        step: "handoff_confirmed",
        actor: "owner",
        tool: "POST /api/rentals/intent/status",
        summary: "Owner confirmed that physical custody was handed to the renter.",
        approvalRequired: true,
        status: "completed",
        paymentMode: updatedIntent.paymentMethod === "base_mcp" ? "onchain_confirmed" : "provider_authorized",
        recordRef: `intent:${updatedIntent.id}`,
      },
    ]);

    return NextResponse.json({
      intent: updatedIntent,
      executionTraceStatus,
      nextAction: "track_return_and_settle_provider_funded_rental",
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to update rental intent", 400);
  }
}
