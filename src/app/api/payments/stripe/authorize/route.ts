import { NextResponse } from "next/server";
import { requirePrivyAuth } from "@/lib/privyServerAuth";
import { getRentableItem } from "@/lib/rentableItems";
import { getRentalIntentsRepository, newRentalIntentId } from "@/lib/rentalIntentsRepository";
import { getStripeRedbox } from "@/lib/stripeRedbox";
import { executionProvenanceReady, initialIntentExecutionEvents, recordExecutionEventsSafely } from "@/lib/rentalExecutionEvents";

const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export async function POST(request: Request) {
  try {
    if (!executionProvenanceReady()) return NextResponse.json({ error: "execution_provenance_not_configured" }, { status: 503 });
    const auth = await requirePrivyAuth(request);
    const body = await request.json().catch(() => null);
    const itemId = typeof body?.itemId === "string" ? body.itemId.trim() : "";
    const renterWallet = typeof body?.renterWallet === "string" ? body.renterWallet.trim() : "";
    const hours = normalizedHours(body?.hours);
    if (!itemId || itemId.length > 96 || hours === null) {
      return NextResponse.json({ error: "invalid_rental_terms" }, { status: 400 });
    }
    if (renterWallet && !WALLET_PATTERN.test(renterWallet)) {
      return NextResponse.json({ error: "invalid_renter_wallet" }, { status: 400 });
    }

    const redbox = getStripeRedbox();
    if (!redbox) return NextResponse.json({ error: "payment_not_configured" }, { status: 503 });
    const item = await getRentableItem(itemId);
    if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    if (item.status !== "available") return NextResponse.json({ error: "item_unavailable" }, { status: 409 });

    const now = new Date();
    const intentId = newRentalIntentId();
    const rentAmount = money(Math.max(item.minimumFee, item.ratePerHour * hours));
    const depositAmount = money(item.buyoutCap);
    const authorization = await redbox.authorizeRental({
      userId: auth.userId,
      intentId,
      itemId: item.id,
      amount: depositAmount,
    });

    try {
      const intent = await getRentalIntentsRepository().save({
        id: intentId,
        itemId: item.id,
        itemName: item.name,
        ownerWallet: item.owner,
        renterWallet: renterWallet || undefined,
        renterIdentity: auth.userId,
        paymentMethod: "card",
        paymentStatus: "confirmed",
        escrowStatus: "provider_authorized",
        sessionStatus: "reserved",
        receiptStatus: "pending_onchain",
        currency: "USD",
        durationHours: hours,
        rentAmount,
        depositAmount,
        platformFeeEstimate: money(rentAmount * 0.05),
        provider: "stripe_redbox",
        providerPaymentId: authorization.paymentIntentId,
        rentalId: `stripe_${item.id}_${crypto.randomUUID()}`,
        notes: "Stripe TEST mode authorized the refundable buyout cap. Capture happens only after owner-signed return receipt.",
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      const executionTraceStatus = await recordExecutionEventsSafely([
        ...initialIntentExecutionEvents(intent, {
          sourceTool: "POST /api/payments/stripe/authorize",
          approvalTool: "Stripe manual-capture authorization",
          approvalStatus: "completed",
          approvalPaymentMode: "provider_authorized",
          approvalSummary: `Renter approved a refundable ${intent.depositAmount} USD authorization.`,
        }),
        {
          eventKey: "stripe-funded",
          intentId: intent.id,
          rentalId: intent.rentalId,
          itemId: intent.itemId,
          step: "rental_funded",
          actor: "payment_provider",
          tool: "Stripe PaymentIntent",
          summary: "Provider authorization succeeded; capture remains blocked until return and receipt approval.",
          approvalRequired: false,
          status: "completed",
          paymentMode: "provider_authorized",
          recordRef: `intent:${intent.id}`,
        },
      ]);
      return NextResponse.json({ intent, authorization, executionTraceStatus });
    } catch (error) {
      await redbox.cancelAuthorization(authorization.paymentIntentId).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "stripe_authorization_failed";
    if (["auth_required", "invalid_auth_token"].includes(code)) {
      return NextResponse.json({ error: code }, { status: 401 });
    }
    if (["auth_not_configured", "payment_not_configured"].includes(code)) {
      return NextResponse.json({ error: code }, { status: 503 });
    }
    if (code === "card_not_linked") return NextResponse.json({ error: code }, { status: 402 });
    console.error("Stripe rental authorization failed", error);
    return NextResponse.json({ error: "stripe_authorization_failed" }, { status: 500 });
  }
}

function normalizedHours(value: unknown) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 7) return null;
  return Number(hours.toFixed(2));
}

function money(value: number) {
  return Number(value.toFixed(2));
}
