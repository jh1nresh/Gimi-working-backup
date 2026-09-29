#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const renterWallet = process.env.SMOKE_RENTER_WALLET ?? "5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC";
const itemId = process.env.SMOKE_ITEM_ID ?? "power_bank_18";
const hours = Number(process.env.SMOKE_RENTAL_HOURS ?? "3");

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function assertCheckout(checkout) {
  if (!checkout.providerPaymentId) throw new Error("MoonPay checkout response missing providerPaymentId");
  if (!checkout.checkoutUrl) throw new Error("MoonPay checkout response missing checkoutUrl");
  if (!/^https?:\/\//.test(checkout.checkoutUrl)) throw new Error("MoonPay checkoutUrl is not an http(s) URL");
}

try {
  const readiness = await getJson("/api/health/readiness");
  const moonPayCheck = readiness.data.checks?.find((check) => String(check.key).includes("MOONPAY_COMMERCE_CHECKOUT_URL"));
  if (moonPayCheck && !moonPayCheck.configured) {
    throw new Error("MoonPay checkout env is not configured on the target app");
  }

  const created = await post("/api/rentals/intent", {
    itemId,
    hours,
    paymentMethod: "card",
    renterWallet,
  });
  const intentId = created.intent?.id;
  if (!intentId) throw new Error("Rental intent response missing intent.id");

  const checkout = await post("/api/payments/moonpay/checkout", { intentId });
  assertCheckout(checkout);

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        itemId,
        intentId,
        providerPaymentId: checkout.providerPaymentId,
        checkoutUrlHost: new URL(checkout.checkoutUrl).host,
        total: checkout.amount?.total,
        currency: checkout.amount?.currency,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
};
