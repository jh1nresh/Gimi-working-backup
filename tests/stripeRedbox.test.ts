import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { assertStripeTestKey, createStripeRedbox } from "@/lib/stripeRedbox";

function stripeFixture() {
  const createPaymentIntent = vi.fn().mockResolvedValue({ id: "pi_1", status: "requires_capture" });
  const retrievePaymentIntent = vi.fn().mockResolvedValue({
    id: "pi_1",
    status: "requires_capture",
    amount_capturable: 7000,
    metadata: { rental_intent_id: "intent_1" },
  });
  const capturePaymentIntent = vi.fn().mockResolvedValue({ id: "pi_1", status: "succeeded", amount_received: 600 });
  const cancelPaymentIntent = vi.fn().mockResolvedValue({ id: "pi_1", status: "canceled" });
  const stripe = {
    customers: {
      search: vi.fn().mockResolvedValue({
        data: [{ id: "cus_1", deleted: false, invoice_settings: { default_payment_method: "pm_1" } }],
      }),
    },
    paymentMethods: {
      list: vi.fn().mockResolvedValue({ data: [{ id: "pm_1", card: { brand: "visa", last4: "4242" } }] }),
    },
    paymentIntents: {
      create: createPaymentIntent,
      retrieve: retrievePaymentIntent,
      capture: capturePaymentIntent,
      cancel: cancelPaymentIntent,
    },
  } as unknown as Stripe;
  return { stripe, createPaymentIntent, retrievePaymentIntent, capturePaymentIntent, cancelPaymentIntent };
}

describe("Stripe Redbox", () => {
  it("rejects live secret keys", () => {
    expect(() => assertStripeTestKey("sk_live_example")).toThrow("TEST key");
    expect(() => assertStripeTestKey("sk_test_example")).not.toThrow();
  });

  it("authorizes the refundable cap with manual capture and intent metadata", async () => {
    const fixture = stripeFixture();
    const redbox = createStripeRedbox(fixture.stripe);
    const result = await redbox.authorizeRental({
      userId: "did:privy:user_1",
      intentId: "intent_1",
      itemId: "camera_1",
      amount: 70,
    });

    expect(fixture.createPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({
      amount: 7000,
      capture_method: "manual",
      confirm: true,
      off_session: true,
      metadata: expect.objectContaining({ rental_intent_id: "intent_1", item_id: "camera_1" }),
    }));
    expect(result).toMatchObject({ paymentIntentId: "pi_1", authorizedAmount: 70, card: { last4: "4242" } });
  });

  it("captures only the final rental fee", async () => {
    const fixture = stripeFixture();
    const redbox = createStripeRedbox(fixture.stripe);
    await expect(redbox.settleAuthorization({ paymentIntentId: "pi_1", intentId: "intent_1", finalAmount: 6 }))
      .resolves.toMatchObject({ capturedAmount: 6, status: "succeeded" });
    expect(fixture.capturePaymentIntent).toHaveBeenCalledWith("pi_1", { amount_to_capture: 600 });
  });

  it("does not accept an incomplete authorization", async () => {
    const fixture = stripeFixture();
    fixture.createPaymentIntent.mockResolvedValue({ id: "pi_1", status: "requires_action" });
    const redbox = createStripeRedbox(fixture.stripe);
    await expect(redbox.authorizeRental({
      userId: "did:privy:user_1",
      intentId: "intent_1",
      itemId: "camera_1",
      amount: 70,
    })).rejects.toThrow("authorization incomplete");
    expect(fixture.cancelPaymentIntent).toHaveBeenCalledWith("pi_1");
  });

  it("rejects an authorization from another rental intent", async () => {
    const fixture = stripeFixture();
    const redbox = createStripeRedbox(fixture.stripe);
    await expect(redbox.settleAuthorization({ paymentIntentId: "pi_1", intentId: "intent_2", finalAmount: 6 }))
      .rejects.toThrow("does not match");
    expect(fixture.capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("cancels the hold when the final fee is zero", async () => {
    const fixture = stripeFixture();
    const redbox = createStripeRedbox(fixture.stripe);
    await expect(redbox.settleAuthorization({ paymentIntentId: "pi_1", intentId: "intent_1", finalAmount: 0 }))
      .resolves.toMatchObject({ capturedAmount: 0, status: "canceled" });
    expect(fixture.cancelPaymentIntent).toHaveBeenCalledWith("pi_1");
  });
});
