export type EnvReadinessLevel = "required" | "recommended" | "optional";

export interface EnvReadinessCheck {
  key: string;
  level: EnvReadinessLevel;
  configured: boolean;
  purpose: string;
}

export function getEnvReadiness() {
  const provenanceLevel: EnvReadinessLevel = process.env.VERCEL ? "required" : "recommended";
  const stripeTestConfigured =
    process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") === true &&
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.startsWith("pk_test_") === true &&
    hasEnv("PRIVY_JWT_VERIFICATION_KEY");
  const moonPayConfigured =
    hasEnv("MOONPAY_COMMERCE_CHECKOUT_URL") ||
    (hasEnv("MOONPAY_COMMERCE_API_URL") && hasEnv("MOONPAY_COMMERCE_API_KEY"));
  const checks: EnvReadinessCheck[] = [
    {
      key: "NEXT_PUBLIC_PRIVY_APP_ID",
      level: "required",
      configured: hasEnv("NEXT_PUBLIC_PRIVY_APP_ID"),
      purpose: "Wallet login and Privy transaction modal.",
    },
    {
      key: "SUPABASE_URL",
      level: "required",
      configured: hasEnv("SUPABASE_URL") || hasEnv("NEXT_PUBLIC_SUPABASE_URL"),
      purpose: "Durable listings, rental sessions, intents, receipts, and notifications.",
    },
    {
      key: "SUPABASE_SERVICE_ROLE_KEY",
      level: "required",
      configured: hasEnv("SUPABASE_SERVICE_ROLE_KEY") || hasEnv("SUPABASE_SERVICE_KEY"),
      purpose: "Server-side Supabase writes. Must not be public.",
    },
    {
      key: "GIMI_ENVIRONMENT + GIMI_ACTIVITY_TYPE",
      level: provenanceLevel,
      configured: hasEnv("GIMI_ENVIRONMENT") && hasEnv("GIMI_ACTIVITY_TYPE"),
      purpose: "Keep demo, test, pilot, and organic activity separated in execution evidence.",
    },
    {
      key: "Stripe TEST rail or MoonPay Commerce",
      level: "recommended",
      configured: stripeTestConfigured || moonPayConfigured,
      purpose: "Card-funded rental authorization with Stripe TEST mode or MoonPay fallback.",
    },
    {
      key: "Card settlement verification",
      level: "recommended",
      configured: stripeTestConfigured || (moonPayConfigured && hasEnv("MOONPAY_COMMERCE_WEBHOOK_SECRET")),
      purpose: "Privy JWT verification for Stripe, or signed MoonPay payment webhooks.",
    },
    {
      key: "ELEVENLABS_AGENT_ID + ELEVENLABS_API_KEY",
      level: "recommended",
      configured: hasEnv("ELEVENLABS_AGENT_ID") && hasEnv("ELEVENLABS_API_KEY"),
      purpose: "Voice/chat agent conversation token.",
    },
    {
      key: "LIFI_INTEGRATOR",
      level: "optional",
      configured: hasEnv("LIFI_INTEGRATOR"),
      purpose: "LI.FI quote attribution.",
    },
    {
      key: "SOLANA_RPC_URL",
      level: "optional",
      configured: hasEnv("SOLANA_RPC_URL"),
      purpose: "Custom Solana devnet RPC; defaults to public devnet RPC.",
    },
  ];
  const missingRequired = checks.filter((check) => check.level === "required" && !check.configured);
  const missingRecommended = checks.filter((check) => check.level === "recommended" && !check.configured);

  return {
    ok: missingRequired.length === 0,
    productionReady: missingRequired.length === 0 && missingRecommended.length === 0,
    checks,
    missingRequired: missingRequired.map((check) => check.key),
    missingRecommended: missingRecommended.map((check) => check.key),
  };
}

function hasEnv(key: string) {
  return Boolean(process.env[key]?.trim());
}
