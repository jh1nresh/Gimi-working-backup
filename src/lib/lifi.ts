import { PublicKey } from "@solana/web3.js";

const LIFI_API_BASE = "https://li.quest/v1";
const USDC_DECIMALS = 6;

export const LIFI_CHAIN_IDS = {
  base: "8453",
  solana: "1151111081099710",
} as const;

export const LIFI_USDC_TOKENS = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
} as const;

export interface LifiQuoteInput {
  amount: number;
  sourceChain?: string;
  sourceToken?: string;
  targetChain?: string;
  targetToken?: string;
  fromAddress?: string;
  toAddress?: string;
  requireReal?: boolean;
}

export interface NormalizedLifiQuote {
  mode: "live" | "demo";
  provider: string;
  from: string;
  to: string;
  inputAmount: number;
  estimatedOutput: number;
  estimatedFee: number;
  estimatedTimeSeconds: number;
  status: "quoted" | "demo_quote";
  quoteId?: string;
  tool?: string;
  transactionRequest?: unknown;
  liveError?: string;
}

function normalizeChain(value: string | undefined, fallback: keyof typeof LIFI_CHAIN_IDS): string {
  const normalized = value?.toLowerCase();
  if (!normalized) return LIFI_CHAIN_IDS[fallback];
  if (normalized in LIFI_CHAIN_IDS) return LIFI_CHAIN_IDS[normalized as keyof typeof LIFI_CHAIN_IDS];
  return value ?? LIFI_CHAIN_IDS[fallback];
}

function normalizeToken(value: string | undefined, chain: string) {
  if (value && value.toUpperCase() !== "USDC") return value;
  if (chain === LIFI_CHAIN_IDS.base) return LIFI_USDC_TOKENS.base;
  if (chain === LIFI_CHAIN_IDS.solana) return LIFI_USDC_TOKENS.solana;
  return value ?? "USDC";
}

function toUsdcBaseUnits(amount: number) {
  return Math.max(1, Math.round(amount * 10 ** USDC_DECIMALS)).toString();
}

function isEvmAddress(value: string | undefined) {
  return Boolean(value?.match(/^0x[a-fA-F0-9]{40}$/));
}

function isSolanaAddress(value: string | undefined) {
  if (!value) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function demoQuote(input: LifiQuoteInput, liveError?: string): NormalizedLifiQuote {
  const amount = Number(input.amount || 30);
  return {
    mode: "demo",
    provider: "LI.FI demo route",
    from: `${input.sourceChain ?? "base"}:${input.sourceToken ?? "USDC"}`,
    to: `${input.targetChain ?? "solana"}:${input.targetToken ?? "USDC"}`,
    inputAmount: amount,
    estimatedOutput: Number((amount - 0.08).toFixed(2)),
    estimatedFee: 0.08,
    estimatedTimeSeconds: 52,
    status: "demo_quote",
    liveError,
  };
}

export async function quoteLifiFunding(input: LifiQuoteInput): Promise<NormalizedLifiQuote> {
  const amount = Number(input.amount || 30);
  const fromChain = normalizeChain(input.sourceChain, "base");
  const toChain = normalizeChain(input.targetChain, "solana");
  const fromToken = normalizeToken(input.sourceToken, fromChain);
  const toToken = normalizeToken(input.targetToken, toChain);

  if (!isEvmAddress(input.fromAddress) || !isSolanaAddress(input.toAddress)) {
    const liveError = "Real LI.FI quote requires a valid EVM source address and Solana destination address.";
    if (input.requireReal) throw new Error(liveError);
    return demoQuote(input, liveError);
  }

  const fromAddress = input.fromAddress as string;
  const toAddress = input.toAddress as string;

  const params = new URLSearchParams({
    fromChain,
    toChain,
    fromToken,
    toToken,
    fromAmount: toUsdcBaseUnits(amount),
    fromAddress,
    toAddress,
    integrator: process.env.LIFI_INTEGRATOR ?? "tably-rentproof",
  });

  const headers: HeadersInit = {};
  if (process.env.LIFI_API_KEY) {
    headers["x-lifi-api-key"] = process.env.LIFI_API_KEY;
  }

  const response = await fetch(`${LIFI_API_BASE}/quote?${params.toString()}`, {
    headers,
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    const message = await response.text();
    if (input.requireReal) {
      throw new Error(`LI.FI quote failed: ${response.status} ${message}`);
    }
    return demoQuote(input, `LI.FI quote failed: ${response.status} ${message}`);
  }

  const quote = await response.json();
  const toAmount = Number(quote.estimate?.toAmount ?? 0) / 10 ** Number(quote.action?.toToken?.decimals ?? USDC_DECIMALS);
  const fromAmountUsd = Number(quote.estimate?.fromAmountUSD ?? amount);
  const toAmountUsd = Number(quote.estimate?.toAmountUSD ?? toAmount);

  return {
    mode: "live",
    provider: quote.toolDetails?.name ?? quote.tool ?? "LI.FI",
    from: `${quote.action?.fromToken?.chainId ?? fromChain}:${quote.action?.fromToken?.symbol ?? "USDC"}`,
    to: `${quote.action?.toToken?.chainId ?? toChain}:${quote.action?.toToken?.symbol ?? "USDC"}`,
    inputAmount: amount,
    estimatedOutput: Number(toAmount.toFixed(6)),
    estimatedFee: Number(Math.max(0, fromAmountUsd - toAmountUsd).toFixed(6)),
    estimatedTimeSeconds: Number(quote.estimate?.executionDuration ?? 0),
    status: "quoted",
    quoteId: quote.id,
    tool: quote.tool,
    transactionRequest: quote.transactionRequest,
  };
}
