import { NextResponse } from "next/server";
import { requirePrivyAuth } from "@/lib/privyServerAuth";
import { getStripeRedbox } from "@/lib/stripeRedbox";

export async function POST(request: Request) {
  try {
    const auth = await requirePrivyAuth(request);
    const body = await request.json().catch(() => null);
    const setupIntentId = typeof body?.setupIntentId === "string" ? body.setupIntentId.trim() : "";
    if (!/^seti_[A-Za-z0-9_]+$/.test(setupIntentId)) {
      return NextResponse.json({ error: "invalid_setup_intent" }, { status: 400 });
    }

    const redbox = getStripeRedbox();
    if (!redbox) return NextResponse.json({ error: "payment_not_configured" }, { status: 503 });
    const card = await redbox.confirmCardSetup(auth.userId, setupIntentId);
    return NextResponse.json({ card });
  } catch (error) {
    const code = error instanceof Error ? error.message : "card_confirm_failed";
    if (["auth_required", "invalid_auth_token"].includes(code)) {
      return NextResponse.json({ error: code }, { status: 401 });
    }
    if (code === "auth_not_configured") return NextResponse.json({ error: code }, { status: 503 });
    console.error("Stripe card confirmation failed", error);
    return NextResponse.json({ error: "card_confirm_failed" }, { status: 500 });
  }
}
