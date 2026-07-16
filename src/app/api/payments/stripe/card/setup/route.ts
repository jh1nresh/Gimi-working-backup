import { NextResponse } from "next/server";
import { requirePrivyAuth } from "@/lib/privyServerAuth";
import { getStripeRedbox } from "@/lib/stripeRedbox";

export async function POST(request: Request) {
  try {
    const auth = await requirePrivyAuth(request);
    const redbox = getStripeRedbox();
    if (!redbox) return NextResponse.json({ error: "payment_not_configured" }, { status: 503 });
    return NextResponse.json(await redbox.createCardSetup(auth.userId));
  } catch (error) {
    const code = error instanceof Error ? error.message : "card_setup_failed";
    if (["auth_required", "invalid_auth_token"].includes(code)) {
      return NextResponse.json({ error: code }, { status: 401 });
    }
    if (code === "auth_not_configured") return NextResponse.json({ error: code }, { status: 503 });
    console.error("Stripe card setup failed", error);
    return NextResponse.json({ error: "card_setup_failed" }, { status: 500 });
  }
}
