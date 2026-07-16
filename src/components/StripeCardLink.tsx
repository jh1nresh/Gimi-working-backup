"use client";

import { useEffect, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const stripePromise = publishableKey?.startsWith("pk_test_") ? loadStripe(publishableKey) : null;

interface StripeCardLinkProps {
  accessToken: string;
  onLinked: (card: { brand: string; last4: string }) => void;
  onCancel: () => void;
}

export function StripeCardLink({ accessToken, onLinked, onCancel }: StripeCardLinkProps) {
  const [clientSecret, setClientSecret] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    fetch("/api/payments/stripe/card/setup", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    })
      .then(async (response) => ({ response, data: await response.json() }))
      .then(({ response, data }) => {
        if (!active) return;
        if (!response.ok) throw new Error(data.error || "Could not start card setup");
        setClientSecret(data.clientSecret);
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "Could not start card setup"));
    return () => {
      active = false;
    };
  }, [accessToken]);

  if (!stripePromise) {
    return <CardPanel error="Stripe TEST publishable key is not configured" onCancel={onCancel} />;
  }
  if (error) return <CardPanel error={error} onCancel={onCancel} />;
  if (!clientSecret) return <CardPanel loading onCancel={onCancel} />;

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: {
          theme: "night",
          variables: { colorPrimary: "#c7ff00", borderRadius: "12px" },
        },
      }}
    >
      <CardForm accessToken={accessToken} onLinked={onLinked} onCancel={onCancel} />
    </Elements>
  );
}

function CardForm({ accessToken, onLinked, onCancel }: StripeCardLinkProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(undefined);

    const result = await stripe.confirmSetup({ elements, redirect: "if_required" });
    if (result.error || !result.setupIntent) {
      setError(result.error?.message || "Card setup failed");
      setSubmitting(false);
      return;
    }

    const response = await fetch("/api/payments/stripe/card/confirm", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ setupIntentId: result.setupIntent.id }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Card setup failed");
      setSubmitting(false);
      return;
    }
    onLinked(data.card);
  }

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/65 p-4 backdrop-blur-md">
      <form onSubmit={submit} className="w-full max-w-md rounded-3xl border border-white/12 bg-[#10131d] p-6 text-white shadow-2xl">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-[#c7ff00]">Stripe test mode</p>
        <h2 className="mt-2 text-2xl font-black">Link a rental card</h2>
        <p className="mb-5 mt-2 text-sm leading-6 text-white/55">
          Gimi authorizes the refundable buyout cap and captures only the final rental fee after return.
        </p>
        <PaymentElement options={{ wallets: { applePay: "never", googlePay: "never", link: "never" } }} />
        {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={onCancel} className="rounded-xl border border-white/12 px-4 py-3 text-sm font-bold text-white/65">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!stripe || submitting}
            className="flex-1 rounded-xl bg-[#c7ff00] px-4 py-3 text-sm font-black text-black disabled:opacity-50"
          >
            {submitting ? "Linking..." : "Link card"}
          </button>
        </div>
      </form>
    </div>
  );
}

function CardPanel({ loading, error, onCancel }: { loading?: boolean; error?: string; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/65 p-4 backdrop-blur-md">
      <div className="w-full max-w-sm rounded-3xl border border-white/12 bg-[#10131d] p-6 text-white shadow-2xl">
        <p className="text-sm text-white/65">{loading ? "Preparing secure card setup..." : error}</p>
        {!loading ? (
          <button type="button" onClick={onCancel} className="mt-5 rounded-xl border border-white/12 px-4 py-3 text-sm font-bold">
            Back
          </button>
        ) : null}
      </div>
    </div>
  );
}
