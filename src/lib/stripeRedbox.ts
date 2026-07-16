import Stripe from "stripe";

const PRIVY_USER_METADATA_KEY = "privy_user_id";

export interface LinkedStripeCard {
  brand: string;
  last4: string;
}

export interface StripeAuthorization {
  paymentIntentId: string;
  status: string;
  authorizedAmount: number;
  card: LinkedStripeCard;
}

export function stripeTestConfigured() {
  return process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") === true;
}

export function assertStripeTestKey(key: string) {
  if (!key.startsWith("sk_test_")) {
    throw new Error("STRIPE_SECRET_KEY must be a Stripe TEST key");
  }
}

export function getStripeRedbox() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  assertStripeTestKey(key);
  return createStripeRedbox(new Stripe(key));
}

export function createStripeRedbox(stripe: Stripe) {
  async function findCustomer(userId: string) {
    const result = await stripe.customers.search({
      query: `metadata['${PRIVY_USER_METADATA_KEY}']:'${stripeSearchValue(userId)}'`,
      limit: 1,
    });
    return result.data[0];
  }

  async function ensureCustomer(userId: string) {
    return (
      (await findCustomer(userId)) ??
      stripe.customers.create({ metadata: { [PRIVY_USER_METADATA_KEY]: userId } })
    );
  }

  async function linkedCard(userId: string): Promise<(LinkedStripeCard & { customerId: string; paymentMethodId: string }) | null> {
    const customer = await findCustomer(userId);
    if (!customer) return null;
    const paymentMethods = await stripe.paymentMethods.list({ customer: customer.id, type: "card", limit: 10 });
    const preferred = customer.invoice_settings?.default_payment_method;
    const paymentMethod = paymentMethods.data.find((entry) => entry.id === preferred) ?? paymentMethods.data[0];
    if (!paymentMethod?.card) return null;
    return {
      customerId: customer.id,
      paymentMethodId: paymentMethod.id,
      brand: paymentMethod.card.brand,
      last4: paymentMethod.card.last4,
    };
  }

  return {
    async cardStatus(userId: string): Promise<LinkedStripeCard | null> {
      const card = await linkedCard(userId);
      return card ? { brand: card.brand, last4: card.last4 } : null;
    },

    async createCardSetup(userId: string) {
      const customer = await ensureCustomer(userId);
      const setupIntent = await stripe.setupIntents.create({
        customer: customer.id,
        usage: "off_session",
        payment_method_types: ["card"],
        metadata: { [PRIVY_USER_METADATA_KEY]: userId },
      });
      if (!setupIntent.client_secret) throw new Error("Stripe SetupIntent did not return a client secret");
      return { clientSecret: setupIntent.client_secret };
    },

    async confirmCardSetup(userId: string, setupIntentId: string) {
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
      if (setupIntent.status !== "succeeded") throw new Error("Stripe card setup is not complete");
      const customerId = idOf(setupIntent.customer);
      const paymentMethodId = idOf(setupIntent.payment_method);
      if (!customerId || !paymentMethodId) throw new Error("Stripe card setup is missing customer data");

      const customer = await stripe.customers.retrieve(customerId);
      if (customer.deleted || customer.metadata[PRIVY_USER_METADATA_KEY] !== userId) {
        throw new Error("Stripe card setup does not belong to this user");
      }

      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
      const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
      return {
        brand: paymentMethod.card?.brand ?? "card",
        last4: paymentMethod.card?.last4 ?? "unknown",
      };
    },

    async authorizeRental(input: {
      userId: string;
      intentId: string;
      itemId: string;
      amount: number;
      currency?: string;
    }): Promise<StripeAuthorization> {
      const card = await linkedCard(input.userId);
      if (!card) throw new Error("card_not_linked");
      const amount = cents(input.amount);
      if (amount === 0) throw new Error("Stripe authorization amount must be positive");
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: input.currency ?? "usd",
        customer: card.customerId,
        payment_method: card.paymentMethodId,
        capture_method: "manual",
        confirm: true,
        off_session: true,
        description: `Gimi refundable rental authorization: ${input.itemId}`,
        metadata: {
          rental_intent_id: input.intentId,
          item_id: input.itemId,
          [PRIVY_USER_METADATA_KEY]: input.userId,
        },
      });
      if (paymentIntent.status !== "requires_capture") {
        await stripe.paymentIntents.cancel(paymentIntent.id).catch(() => undefined);
        throw new Error(`Stripe authorization incomplete: ${paymentIntent.status}`);
      }
      return {
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status,
        authorizedAmount: amount / 100,
        card: { brand: card.brand, last4: card.last4 },
      };
    },

    async settleAuthorization(input: { paymentIntentId: string; intentId: string; finalAmount: number }) {
      const paymentIntent = await stripe.paymentIntents.retrieve(input.paymentIntentId);
      if (paymentIntent.metadata.rental_intent_id !== input.intentId) {
        throw new Error("Stripe authorization does not match the rental intent");
      }
      if (paymentIntent.status === "succeeded") {
        return { paymentIntentId: paymentIntent.id, status: paymentIntent.status, capturedAmount: paymentIntent.amount_received / 100 };
      }
      if (paymentIntent.status !== "requires_capture") {
        throw new Error(`Stripe authorization cannot be captured from status ${paymentIntent.status}`);
      }

      const amountToCapture = cents(input.finalAmount);
      if (amountToCapture > paymentIntent.amount_capturable) {
        throw new Error("Final rental amount exceeds the authorized deposit");
      }
      if (amountToCapture === 0) {
        const cancelled = await stripe.paymentIntents.cancel(paymentIntent.id);
        return { paymentIntentId: cancelled.id, status: cancelled.status, capturedAmount: 0 };
      }

      const captured = await stripe.paymentIntents.capture(paymentIntent.id, { amount_to_capture: amountToCapture });
      return { paymentIntentId: captured.id, status: captured.status, capturedAmount: captured.amount_received / 100 };
    },

    async cancelAuthorization(paymentIntentId: string) {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (paymentIntent.status !== "requires_capture") return;
      await stripe.paymentIntents.cancel(paymentIntentId);
    },
  };
}

export type StripeRedbox = ReturnType<typeof createStripeRedbox>;

function idOf(value: string | { id: string } | null) {
  return typeof value === "string" ? value : value?.id;
}

function cents(amount: number) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Stripe amount must be a non-negative number");
  return Math.round(amount * 100);
}

function stripeSearchValue(value: string) {
  if (!/^did:privy:[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Privy user id");
  return value;
}
