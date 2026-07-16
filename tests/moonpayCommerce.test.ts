import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { moonPayStatusToIntent, moonPayTransitionAllowed, verifyMoonPayWebhook } from "@/lib/moonpayCommerce";
import type { PersistedRentalIntent } from "@/lib/rentalIntentsRepository";

const originalSecret = process.env.MOONPAY_COMMERCE_WEBHOOK_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.MOONPAY_COMMERCE_WEBHOOK_SECRET;
  else process.env.MOONPAY_COMMERCE_WEBHOOK_SECRET = originalSecret;
});

describe("MoonPay webhook verification", () => {
  it("fails closed when the webhook secret is not configured", async () => {
    delete process.env.MOONPAY_COMMERCE_WEBHOOK_SECRET;
    const result = await verifyMoonPayWebhook(new Request("https://gimi.test/webhook", { method: "POST" }), "{}");
    expect(result).toEqual({ ok: false, mode: "not_configured" });
  });

  it("accepts the configured bearer secret", async () => {
    process.env.MOONPAY_COMMERCE_WEBHOOK_SECRET = "test-secret";
    const request = new Request("https://gimi.test/webhook", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    });
    await expect(verifyMoonPayWebhook(request, "{}")).resolves.toEqual({ ok: true, mode: "bearer" });
  });

  it("rejects stale timestamped signatures", async () => {
    process.env.MOONPAY_COMMERCE_WEBHOOK_SECRET = "test-secret";
    const rawBody = "{}";
    const timestamp = "1783771200";
    const signature = createHmac("sha256", "test-secret").update(`${timestamp}.${rawBody}`).digest("hex");
    const request = new Request("https://gimi.test/webhook", {
      method: "POST",
      headers: { "moonpay-signature-v2": `t=${timestamp},s=${signature}` },
    });
    await expect(verifyMoonPayWebhook(request, rawBody, 1_783_771_200_000)).resolves.toMatchObject({ ok: true });
    await expect(verifyMoonPayWebhook(request, rawBody, 1_783_771_500_001)).resolves.toMatchObject({ ok: false });
  });

  it("prevents duplicate and regressive provider transitions", () => {
    const intent = {
      paymentStatus: "confirmed",
      escrowStatus: "provider_captured",
      sessionStatus: "reserved",
      receiptStatus: "pending_onchain",
      settlementStatus: "pending_provider",
    } as PersistedRentalIntent;
    expect(moonPayTransitionAllowed(intent, moonPayStatusToIntent("completed"))).toBe(false);
    expect(moonPayTransitionAllowed(intent, moonPayStatusToIntent("failed"))).toBe(false);
    expect(moonPayTransitionAllowed({ ...intent, sessionStatus: "active" }, moonPayStatusToIntent("completed"))).toBe(false);
  });
});
