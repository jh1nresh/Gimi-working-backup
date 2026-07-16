import { NextResponse } from "next/server";
import { requirePrivyAuth } from "@/lib/privyServerAuth";
import { getStripeRedbox, stripeTestConfigured } from "@/lib/stripeRedbox";

export async function GET(request: Request) {
  try {
    const auth = await requirePrivyAuth(request);
    if (!stripeTestConfigured()) return NextResponse.json({ configured: false, linked: false });
    const card = await getStripeRedbox()!.cardStatus(auth.userId);
    return NextResponse.json({ configured: true, linked: Boolean(card), card });
  } catch (error) {
    return authError(error);
  }
}

function authError(error: unknown) {
  const code = error instanceof Error ? error.message : "invalid_auth_token";
  if (["auth_required", "invalid_auth_token"].includes(code)) {
    return NextResponse.json({ error: code }, { status: 401 });
  }
  if (code === "auth_not_configured") return NextResponse.json({ error: code }, { status: 503 });
  console.error("Stripe card status failed", error);
  return NextResponse.json({ error: "card_status_failed" }, { status: 500 });
}
