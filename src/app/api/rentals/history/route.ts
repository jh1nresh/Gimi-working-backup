import { NextRequest, NextResponse } from "next/server";
import { getRentableItem } from "@/lib/rentableItems";
import { getRentalIntentsRepository, PersistedRentalIntent } from "@/lib/rentalIntentsRepository";
import { getRentalReceiptsRepository, PersistedRentalReceipt } from "@/lib/rentalReceiptsRepository";
import { getRentalSessionsRepository, PersistedRentalSession } from "@/lib/rentalSessionsRepository";
import { USDC_DECIMALS } from "@/lib/rentproofProgram";
import {
  buildFunnelSummary,
  executionTimelineDisclosureAllowed,
  getRentalExecutionEventsRepository,
  PersistedRentalExecutionEvent,
} from "@/lib/rentalExecutionEvents";

const SOLANA_WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const EVM_WALLET_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const RENTAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

function explorerUrl(signature: string) {
  const baseMatch = signature.match(/^base:(8453|84532):(0x[a-fA-F0-9]{64})$/);
  if (baseMatch) {
    const host = baseMatch[1] === "8453" ? "basescan.org" : "sepolia.basescan.org";
    return `https://${host}/tx/${baseMatch[2]}`;
  }
  if (signature.startsWith("offchain:")) return undefined;
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function shortWallet(value: string) {
  if (value.length < 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function normalizeUsdcAmount(rawAmount: string) {
  const raw = BigInt(rawAmount);
  const divisor = BigInt(10) ** BigInt(USDC_DECIMALS);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  const fractionText = fraction.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const uiAmount = fractionText ? `${whole.toString()}.${fractionText}` : whole.toString();

  return {
    raw: rawAmount,
    uiAmount,
    decimals: USDC_DECIMALS,
    symbol: "USDC",
  };
}

function normalizeReceiptAmount(rawAmount: string, paymentMint: string) {
  const amount = normalizeUsdcAmount(rawAmount);
  if (paymentMint === "USD_CARD") {
    return {
      ...amount,
      symbol: "USD",
    };
  }
  return amount;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get("wallet")?.trim() ?? "";
  const rentalId = searchParams.get("rentalId")?.trim() ?? "";
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const discloseTimeline = executionTimelineDisclosureAllowed(searchParams.get("timeline"));

  if (wallet && !SOLANA_WALLET_PATTERN.test(wallet) && !EVM_WALLET_PATTERN.test(wallet)) {
    return errorResponse("wallet must be a Solana or EVM address", 400);
  }
  if (rentalId && !RENTAL_ID_PATTERN.test(rentalId)) {
    return errorResponse("rentalId contains unsupported characters", 400);
  }
  if (limitParam && (!Number.isFinite(limit) || Number(limit) < 1)) {
    return errorResponse("limit must be a positive number", 400);
  }

  try {
    const repository = getRentalReceiptsRepository();
    const sessionsRepository = getRentalSessionsRepository();
    const intentsRepository = getRentalIntentsRepository();
    const executionEventsRepository = getRentalExecutionEventsRepository();
    const activeSessions = wallet ? await sessionsRepository.listByWallet(wallet, { status: "active", limit }) : [];
    const paymentIntents = wallet ? await intentsRepository.listByRenterWallet(wallet, limit) : [];
    const ownerPaymentIntents = wallet ? await intentsRepository.listByOwnerWallet(wallet, limit) : [];
    const receipts = await repository.listRecent({
      wallet: wallet || undefined,
      rentalId: rentalId || undefined,
      limit,
    });
    const records = await Promise.all(receipts.map(enrichReceipt));
    const activeRentals = await Promise.all(activeSessions.map(enrichSession));
    const visibleIntents = [...new Map([...paymentIntents, ...ownerPaymentIntents].map((intent) => [intent.id, intent])).values()];
    let executionEvents: PersistedRentalExecutionEvent[] = [];
    let executionTraceStatus: "recorded" | "unavailable" = "recorded";
    try {
      executionEvents = await executionEventsRepository.listByIntentIds(visibleIntents.map((intent) => intent.id));
    } catch (error) {
      executionTraceStatus = "unavailable";
      console.error("Rental execution timeline read failed", error);
    }
    const eventsByIntent = groupEventsByIntent(executionEvents);
    const providerReservations = await Promise.all(
      paymentIntents
        .filter((intent) => intent.paymentMethod !== "solana_wallet" && intent.sessionStatus !== "cancelled")
        .map((intent) => enrichIntent(intent, eventsByIntent.get(intent.id) ?? [], discloseTimeline))
    );
    const ownerProviderReservations = await Promise.all(
      ownerPaymentIntents
        .filter((intent) => intent.paymentMethod !== "solana_wallet" && intent.sessionStatus !== "cancelled")
        .map((intent) => enrichIntent(intent, eventsByIntent.get(intent.id) ?? [], discloseTimeline))
    );

    return NextResponse.json({
      activeRentals,
      cardReservations: providerReservations,
      ownerCardReservations: ownerProviderReservations,
      providerReservations,
      ownerProviderReservations,
      receipts: records,
      activeCount: activeRentals.length,
      cardReservationCount: providerReservations.length,
      ownerCardReservationCount: ownerProviderReservations.length,
      providerReservationCount: providerReservations.length,
      ownerProviderReservationCount: ownerProviderReservations.length,
      count: records.length,
      funnel: executionTraceStatus === "recorded" ? buildFunnelSummary(executionEvents) : null,
      executionTraceStatus,
      storage: {
        intents: intentsRepository.storageKind,
        sessions: sessionsRepository.storageKind,
        receipts: repository.storageKind,
        executionEvents: executionEventsRepository.storageKind,
      },
      filters: {
        wallet: wallet || null,
        rentalId: rentalId || null,
      },
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to load rental history", 500);
  }
}

async function enrichIntent(intent: PersistedRentalIntent, events: PersistedRentalExecutionEvent[], discloseTimeline: boolean) {
  const item = await getRentableItem(intent.itemId);

  return {
    id: intent.id,
    rentalId: intent.rentalId,
    itemId: intent.itemId,
    item: item
      ? {
          id: item.id,
          name: item.name,
          imageUrl: item.imageUrl,
          category: item.category,
          locationLabel: item.locationLabel,
          ownerName: item.ownerName,
          ownerScore: item.ownerScore,
          ratePerHour: item.ratePerHour,
          minimumFee: item.minimumFee,
          buyoutCap: item.buyoutCap,
        }
      : {
          id: intent.itemId,
          name: intent.itemName,
        },
    paymentMethod: intent.paymentMethod,
    paymentStatus: intent.paymentStatus,
    escrowStatus: intent.escrowStatus,
    sessionStatus: intent.sessionStatus,
    receiptStatus: intent.receiptStatus,
    receiptSignature: intent.receiptSignature,
    receiptExplorerUrl: intent.receiptSignature ? explorerUrl(intent.receiptSignature) : undefined,
    receiptIssuedAt: intent.receiptIssuedAt,
    settlementStatus: intent.settlementStatus,
    provider: intent.provider,
    provenance: events.length
      ? {
          environment: events[events.length - 1].environment,
          activityType: events[events.length - 1].activityType,
          paymentMode: events[events.length - 1].paymentMode,
        }
      : undefined,
    timeline: discloseTimeline ? events.filter((event) => event.activityType === "seeded_demo") : [],
    durationHours: intent.durationHours,
    activatedAt: intent.activatedAt,
    returnedAt: intent.returnedAt,
    renterWallet: intent.renterWallet,
    ownerWallet: intent.ownerWallet,
    ownerWalletShort: shortWallet(intent.ownerWallet),
    amounts: {
      rent: { uiAmount: String(intent.rentAmount), symbol: intent.currency },
      deposit: { uiAmount: String(intent.depositAmount), symbol: intent.currency },
      platformFeeEstimate: { uiAmount: String(intent.platformFeeEstimate), symbol: intent.currency },
      total: { uiAmount: String(intent.rentAmount + intent.depositAmount + intent.platformFeeEstimate), symbol: intent.currency },
      finalFee: { uiAmount: String(intent.finalFee ?? 0), symbol: intent.currency },
      ownerPayout: { uiAmount: String(intent.ownerPayout ?? 0), symbol: intent.currency },
      platformFee: { uiAmount: String(intent.platformFee ?? 0), symbol: intent.currency },
      renterRefund: { uiAmount: String(intent.renterRefund ?? 0), symbol: intent.currency },
    },
    expiresAt: intent.expiresAt,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

function groupEventsByIntent(events: PersistedRentalExecutionEvent[]) {
  const grouped = new Map<string, PersistedRentalExecutionEvent[]>();
  for (const event of events) grouped.set(event.intentId, [...(grouped.get(event.intentId) ?? []), event]);
  return grouped;
}

async function enrichSession(session: PersistedRentalSession) {
  const item = await getRentableItem(session.itemId);

  return {
    rentalId: session.rentalId,
    itemId: session.itemId,
    item: item
      ? {
          id: item.id,
          name: item.name,
          imageUrl: item.imageUrl,
          category: item.category,
          locationLabel: item.locationLabel,
          ownerName: item.ownerName,
          ownerScore: item.ownerScore,
          ratePerHour: item.ratePerHour,
          minimumFee: item.minimumFee,
          buyoutCap: item.buyoutCap,
        }
      : null,
    status: session.status,
    startSignature: session.startSignature,
    explorerUrl: explorerUrl(session.startSignature),
    startTs: session.startTs,
    dueTs: session.dueTs,
    ownerWallet: session.ownerWallet,
    renterWallet: session.renterWallet,
    ownerWalletShort: shortWallet(session.ownerWallet),
    renterWalletShort: shortWallet(session.renterWallet),
    paymentMint: session.paymentMint,
    sessionPda: session.sessionPda,
    rentalTokenPda: session.rentalTokenPda,
    escrowTokenAccount: session.escrowTokenAccount,
    amounts: {
      escrow: normalizeUsdcAmount(session.escrowAmount),
      expectedFeeAtStart: normalizeUsdcAmount(session.expectedFeeAtStart),
    },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

async function enrichReceipt(receipt: PersistedRentalReceipt) {
  const item = await getRentableItem(receipt.itemId);

  return {
    id: receipt.id,
    rentalId: receipt.rentalId,
    itemId: receipt.itemId,
    item: item
      ? {
          id: item.id,
          name: item.name,
          imageUrl: item.imageUrl,
          category: item.category,
          locationLabel: item.locationLabel,
          ownerScore: item.ownerScore,
          status: item.status,
        }
      : null,
    outcome: receipt.outcome,
    settlementSignature: receipt.settlementSignature,
    explorerUrl: explorerUrl(receipt.settlementSignature),
    grossFee: receipt.grossFee,
    platformFee: receipt.platformFee,
    ownerPayout: receipt.ownerPayout,
    renterRefund: receipt.renterRefund,
    amounts: {
      grossFee: normalizeReceiptAmount(receipt.grossFee, receipt.paymentMint),
      platformFee: normalizeReceiptAmount(receipt.platformFee, receipt.paymentMint),
      ownerPayout: normalizeReceiptAmount(receipt.ownerPayout, receipt.paymentMint),
      renterRefund: normalizeReceiptAmount(receipt.renterRefund, receipt.paymentMint),
    },
    ownerWallet: receipt.ownerWallet,
    renterWallet: receipt.renterWallet,
    ownerWalletShort: shortWallet(receipt.ownerWallet),
    renterWalletShort: shortWallet(receipt.renterWallet),
    paymentMint: receipt.paymentMint,
    rentalTokenStatus: receipt.rentalTokenStatus,
    createdAt: receipt.createdAt,
  };
}
