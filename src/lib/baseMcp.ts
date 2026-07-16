import { RentalItem } from "./types";

export type BaseMcpChain = "base" | "base-sepolia";

interface BaseChainConfig {
  chainId: number;
  label: string;
  usdcAddress: string;
}

const BASE_CHAINS: Record<BaseMcpChain, BaseChainConfig> = {
  base: {
    chainId: 8453,
    label: "Base",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  "base-sepolia": {
    chainId: 84532,
    label: "Base Sepolia",
    usdcAddress: process.env.BASE_SEPOLIA_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};

const ERC20_TRANSFER_SELECTOR = "a9059cbb";
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export interface BaseRentalQuote {
  itemId: string;
  itemName: string;
  hours: number;
  rentAmountUsdc: number;
  depositAmountUsdc: number;
  totalAuthorizedUsdc: number;
  platformFeeEstimateUsdc: number;
  refundModel: string;
}

export interface BaseDepositCall {
  chainId: number;
  chain: BaseMcpChain;
  chainLabel: string;
  to: string;
  value: "0x0";
  data: string;
  from?: string;
  token: {
    symbol: "USDC";
    address: string;
    decimals: 6;
  };
  amount: {
    usdc: number;
    atomic: string;
  };
  description: string;
}

export function normalizeBaseChain(value: unknown): BaseMcpChain {
  if (value === "base-sepolia" || value === "base") return value;
  if (process.env.BASE_MCP_CHAIN === "base" || process.env.BASE_MCP_CHAIN === "base-sepolia") {
    return process.env.BASE_MCP_CHAIN;
  }
  return "base-sepolia";
}

export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS_PATTERN.test(value);
}

export function isBaseTransactionHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

export function requireEvmAddress(value: unknown, label: string) {
  if (!isEvmAddress(value)) {
    throw new Error(`${label} must be a 0x-prefixed EVM address`);
  }
  return value;
}

export function baseChainConfig(chain: BaseMcpChain): BaseChainConfig {
  const config = BASE_CHAINS[chain];
  const envToken = chain === "base" ? process.env.BASE_USDC_ADDRESS : process.env.BASE_SEPOLIA_USDC_ADDRESS;
  if (!envToken) return config;
  return { ...config, usdcAddress: requireEvmAddress(envToken, `${chain} USDC address`) };
}

export function configuredBaseEscrowAddress(input?: unknown) {
  const address = input ?? process.env.BASE_RENTAL_ESCROW_ADDRESS ?? process.env.BASE_MCP_ESCROW_ADDRESS;
  return requireEvmAddress(address, "Base escrow address");
}

export function buildBaseRentalQuote(item: RentalItem, hoursInput?: unknown): BaseRentalQuote {
  const hours = normalizeHours(hoursInput, item.expectedHours);
  const rentAmountUsdc = money(Math.max(item.minimumFee, item.ratePerHour * hours));
  const depositAmountUsdc = money(item.buyoutCap);
  return {
    itemId: item.id,
    itemName: item.name,
    hours,
    rentAmountUsdc,
    depositAmountUsdc,
    totalAuthorizedUsdc: money(rentAmountUsdc + depositAmountUsdc),
    platformFeeEstimateUsdc: money(rentAmountUsdc * 0.05),
    refundModel:
      "Escrow locks rent plus deposit. Accrued rent becomes host-earned only after return confirmation; the remainder is refunded.",
  };
}

export function buildBaseDepositCall(input: {
  item: RentalItem;
  hours?: unknown;
  from?: unknown;
  escrowAddress?: unknown;
  chain?: unknown;
}): { quote: BaseRentalQuote; call: BaseDepositCall } {
  const chain = normalizeBaseChain(input.chain);
  const chainConfig = baseChainConfig(chain);
  const escrowAddress = configuredBaseEscrowAddress(input.escrowAddress);
  const quote = buildBaseRentalQuote(input.item, input.hours);
  const atomicAmount = usdcAtomicAmount(quote.totalAuthorizedUsdc);

  return {
    quote,
    call: {
      chainId: chainConfig.chainId,
      chain,
      chainLabel: chainConfig.label,
      to: chainConfig.usdcAddress,
      value: "0x0",
      data: encodeErc20Transfer(escrowAddress, atomicAmount),
      from: isEvmAddress(input.from) ? input.from : undefined,
      token: {
        symbol: "USDC",
        address: chainConfig.usdcAddress,
        decimals: 6,
      },
      amount: {
        usdc: quote.totalAuthorizedUsdc,
        atomic: atomicAmount.toString(),
      },
      description: `Authorize ${quote.totalAuthorizedUsdc} USDC for ${input.item.name} rental escrow.`,
    },
  };
}

function normalizeHours(value: unknown, fallback: number) {
  const hours = Number(value ?? fallback);
  if (!Number.isFinite(hours)) return fallback;
  return Math.min(24 * 7, Math.max(1, hours));
}

function money(value: number) {
  return Number(value.toFixed(2));
}

export function baseExplorerUrl(chain: BaseMcpChain, txHash: string) {
  const host = chain === "base" ? "basescan.org" : "sepolia.basescan.org";
  return `https://${host}/tx/${txHash}`;
}

function usdcAtomicAmount(amount: number) {
  return BigInt(Math.round(amount * 1_000_000));
}

function encodeErc20Transfer(to: string, amount: bigint) {
  const paddedAddress = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const paddedAmount = amount.toString(16).padStart(64, "0");
  return `0x${ERC20_TRANSFER_SELECTOR}${paddedAddress}${paddedAmount}`;
}
