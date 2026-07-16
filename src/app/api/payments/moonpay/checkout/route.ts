import { NextRequest, NextResponse } from "next/server";
import { createMoonPayCheckout, totalAmount } from "@/lib/moonpayCommerce";
import { getRentalIntentsRepository } from "@/lib/rentalIntentsRepository";
import { executionProvenanceReady, recordExecutionEventsSafely } from "@/lib/rentalExecutionEvents";

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
  if (!intentId) return errorResponse("intentId is required", 400);

  try {
    const repository = getRentalIntentsRepository();
    const intent = await repository.getById(intentId);
    if (!intent) return errorResponse("Rental intent not found", 404);
    if (intent.paymentMethod !== "card") {
      return errorResponse("MoonPay checkout only supports card rental intents", 400);
    }
    if (intent.paymentStatus === "confirmed") {
      return errorResponse("Rental intent is already funded", 409, { intent });
    }

    const checkout = await createMoonPayCheckout(intent);
    const updatedIntent = await repository.save({
      ...intent,
      provider: "moonpay_commerce",
      providerPaymentId: checkout.providerPaymentId,
      providerCheckoutUrl: checkout.checkoutUrl,
      paymentStatus: "requires_action",
      escrowStatus: "not_funded",
      sessionStatus: "intent",
      updatedAt: new Date().toISOString(),
    });
    const executionTraceStatus = await recordExecutionEventsSafely([
      {
        eventKey: "moonpay-checkout-requested",
        intentId: updatedIntent.id,
        rentalId: updatedIntent.rentalId,
        itemId: updatedIntent.itemId,
        step: "approval_requested",
        actor: "gimi_agent",
        tool: "MoonPay Commerce checkout",
        summary: "Opened provider checkout and is waiting for renter authorization.",
        approvalRequired: true,
        status: "waiting",
        paymentMode: "simulated",
        recordRef: `intent:${updatedIntent.id}`,
      },
    ]);

    return NextResponse.json({
      intent: updatedIntent,
      executionTraceStatus,
      providerPaymentId: checkout.providerPaymentId,
      checkoutUrl: checkout.checkoutUrl ?? null,
      amount: {
        rent: intent.rentAmount,
        deposit: intent.depositAmount,
        platformFeeEstimate: intent.platformFeeEstimate,
        total: totalAmount(intent),
        currency: intent.currency,
      },
      provider: {
        name: "moonpay_commerce",
        raw: checkout.raw,
      },
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to create MoonPay checkout", 400);
  }
}
