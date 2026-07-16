import { createHmac, timingSafeEqual } from "node:crypto";
import { PersistedRentalIntent } from "./rentalIntentsRepository";

export interface MoonPayCheckoutResult {
  providerPaymentId: string;
  checkoutUrl?: string;
  raw: unknown;
}

export interface MoonPayWebhookEvent {
  providerPaymentId: string;
  rentalIntentId?: string;
  status: string;
  raw: unknown;
}

type MoonPayMappedStatus = ReturnType<typeof moonPayStatusToIntent>;
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

export function moonPayConfigured() {
  return Boolean(process.env.MOONPAY_COMMERCE_API_URL && process.env.MOONPAY_COMMERCE_API_KEY);
}

export function moonPayHostedCheckoutUrl(intent: PersistedRentalIntent) {
  const configured = process.env.MOONPAY_COMMERCE_CHECKOUT_URL;
  if (!configured) return undefined;

  const url = new URL(configured);
  url.searchParams.set("client_reference_id", intent.id);
  url.searchParams.set("external_id", intent.id);
  url.searchParams.set("amount", totalAmount(intent).toFixed(2));
  url.searchParams.set("currency", intent.currency);
  return url.toString();
}

export async function createMoonPayCheckout(intent: PersistedRentalIntent): Promise<MoonPayCheckoutResult> {
  const hostedUrl = moonPayHostedCheckoutUrl(intent);
  if (!moonPayConfigured()) {
    if (!hostedUrl) {
      throw new Error("MoonPay Commerce is not configured. Set MOONPAY_COMMERCE_API_URL and MOONPAY_COMMERCE_API_KEY, or MOONPAY_COMMERCE_CHECKOUT_URL.");
    }
    return {
      providerPaymentId: `moonpay_hosted_${intent.id}`,
      checkoutUrl: hostedUrl,
      raw: { mode: "hosted_url" },
    };
  }

  const endpoint = String(process.env.MOONPAY_COMMERCE_API_URL);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.MOONPAY_COMMERCE_API_KEY}`,
    },
    body: JSON.stringify({
      amount: totalAmount(intent),
      currency: intent.currency,
      externalId: intent.id,
      clientReferenceId: intent.id,
      metadata: {
        rentalIntentId: intent.id,
        itemId: intent.itemId,
        renterWallet: intent.renterWallet ?? null,
      },
      description: `Gimi rental: ${intent.itemName}`,
      successUrl: process.env.MOONPAY_COMMERCE_SUCCESS_URL,
      cancelUrl: process.env.MOONPAY_COMMERCE_CANCEL_URL,
      webhookUrl: process.env.MOONPAY_COMMERCE_WEBHOOK_URL,
    }),
  });

  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(providerError(raw) || `MoonPay checkout creation failed with ${response.status}`);
  }

  return {
    providerPaymentId: providerId(raw) || `moonpay_${intent.id}`,
    checkoutUrl: providerCheckoutUrl(raw) ?? hostedUrl,
    raw,
  };
}

export function parseMoonPayWebhook(body: unknown): MoonPayWebhookEvent {
  const record = asRecord(body);
  const data = asRecord(record.data ?? record.object ?? record);
  const metadata = asRecord(data.metadata ?? record.metadata ?? {});
  const providerPaymentId =
    stringValue(data.id) ||
    stringValue(data.chargeId) ||
    stringValue(data.paymentId) ||
    stringValue(record.id) ||
    stringValue(record.chargeId) ||
    stringValue(metadata.providerPaymentId);
  const rentalIntentId =
    stringValue(metadata.rentalIntentId) ||
    stringValue(metadata.intentId) ||
    stringValue(data.externalId) ||
    stringValue(data.clientReferenceId) ||
    stringValue(record.externalId) ||
    stringValue(record.clientReferenceId);
  const status = stringValue(data.status) || stringValue(record.status) || stringValue(data.state) || stringValue(record.type);

  if (!providerPaymentId && !rentalIntentId) throw new Error("MoonPay webhook is missing a provider payment id or rental intent id");
  if (!status) throw new Error("MoonPay webhook is missing a payment status");

  return {
    providerPaymentId: providerPaymentId || rentalIntentId,
    rentalIntentId: rentalIntentId || undefined,
    status,
    raw: body,
  };
}

export function moonPayStatusToIntent(status: string) {
  const normalized = status.toLowerCase();
  if (["paid", "completed", "complete", "confirmed", "succeeded", "success", "charge.completed"].includes(normalized)) {
    return {
      paymentStatus: "confirmed" as const,
      escrowStatus: "provider_captured" as const,
      sessionStatus: "reserved" as const,
      receiptStatus: "pending_onchain" as const,
    };
  }
  if (["authorized", "authorization_succeeded", "charge.authorized"].includes(normalized)) {
    return {
      paymentStatus: "confirmed" as const,
      escrowStatus: "provider_authorized" as const,
      sessionStatus: "reserved" as const,
      receiptStatus: "pending_onchain" as const,
    };
  }
  if (["failed", "canceled", "cancelled", "expired", "charge.failed"].includes(normalized)) {
    return {
      paymentStatus: normalized === "expired" ? ("expired" as const) : ("failed" as const),
      escrowStatus: "not_funded" as const,
      sessionStatus: "cancelled" as const,
      receiptStatus: "none" as const,
    };
  }
  return {
    paymentStatus: "requires_action" as const,
    escrowStatus: "not_funded" as const,
    sessionStatus: "intent" as const,
    receiptStatus: "none" as const,
  };
}

export async function verifyMoonPayWebhook(req: Request, rawBody: string, nowMs = Date.now()) {
  const secret = process.env.MOONPAY_COMMERCE_WEBHOOK_SECRET;
  if (!secret) return { ok: false, mode: "not_configured" as const };

  const authorization = req.headers.get("authorization") ?? "";
  if (authorization === `Bearer ${secret}`) return { ok: true, mode: "bearer" as const };

  const moonPaySignature = req.headers.get("moonpay-signature-v2") ?? req.headers.get("x-moonpay-signature-v2");
  if (moonPaySignature) {
    return {
      ok: verifyTimestampedSignature(rawBody, secret, moonPaySignature, nowMs),
      mode: "moonpay-signature-v2" as const,
    };
  }

  const signature = req.headers.get("x-signature");
  if (!signature) return { ok: false, mode: "missing" as const };

  return {
    ok: verifyHexSignature(rawBody, secret, signature),
    mode: "x-signature" as const,
  };
}

export function moonPayTransitionAllowed(intent: PersistedRentalIntent, next: MoonPayMappedStatus) {
  if (["active", "returned"].includes(intent.sessionStatus) || intent.settlementStatus === "settled") return false;
  if (intent.sessionStatus === "cancelled") return false;
  if (intent.paymentStatus === "confirmed" && next.paymentStatus !== "confirmed") return false;
  if (intent.sessionStatus === "reserved" && next.sessionStatus !== "reserved") return false;
  if (intent.escrowStatus === "provider_captured" && next.escrowStatus !== "provider_captured") return false;
  return !(
    intent.paymentStatus === next.paymentStatus &&
    intent.escrowStatus === next.escrowStatus &&
    intent.sessionStatus === next.sessionStatus &&
    intent.receiptStatus === next.receiptStatus
  );
}

export function totalAmount(intent: PersistedRentalIntent) {
  return Number((intent.rentAmount + intent.depositAmount + intent.platformFeeEstimate).toFixed(2));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function providerId(value: unknown): string {
  const record = asRecord(value);
  const data = asRecord(record.data);
  return stringValue(record.id) || stringValue(record.chargeId) || stringValue(record.paymentId) || stringValue(data.id) || stringValue(data.chargeId);
}

function providerCheckoutUrl(value: unknown): string | undefined {
  const record = asRecord(value);
  const data = asRecord(record.data);
  return (
    stringValue(record.checkoutUrl) ||
    stringValue(record.checkout_url) ||
    stringValue(record.url) ||
    stringValue(data.checkoutUrl) ||
    stringValue(data.checkout_url) ||
    stringValue(data.url) ||
    undefined
  );
}

function providerError(value: unknown): string | undefined {
  const record = asRecord(value);
  const data = asRecord(record.data);
  return stringValue(record.error) || stringValue(record.message) || stringValue(data.error) || stringValue(data.message) || undefined;
}

function verifyTimestampedSignature(rawBody: string, secret: string, header: string, nowMs: number) {
  const fields = new Map(
    header.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, rest.join("=")];
    })
  );
  const timestamp = fields.get("t");
  const signature = fields.get("s");
  if (!timestamp || !signature) return false;
  const timestampValue = Number(timestamp);
  if (!Number.isFinite(timestampValue)) return false;
  const timestampMs = timestampValue < 1_000_000_000_000 ? timestampValue * 1000 : timestampValue;
  if (Math.abs(nowMs - timestampMs) > WEBHOOK_TOLERANCE_MS) return false;
  return verifyHexSignature(`${timestamp}.${rawBody}`, secret, signature);
}

function verifyHexSignature(payload: string, secret: string, signature: string) {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  const received = signature.replace(/^sha256=/i, "");
  if (!/^[0-9a-f]+$/i.test(received)) return false;
  const digestBuffer = Buffer.from(digest, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  if (digestBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(digestBuffer, receivedBuffer);
}
