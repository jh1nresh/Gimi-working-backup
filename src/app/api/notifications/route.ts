import { NextRequest, NextResponse } from "next/server";
import { getNotificationsRepository } from "@/lib/notificationsRepository";

const SOLANA_WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const EVM_WALLET_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? "";
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  if (!SOLANA_WALLET_PATTERN.test(wallet) && !EVM_WALLET_PATTERN.test(wallet)) {
    return errorResponse("wallet must be a Solana or EVM address", 400);
  }
  if (limitParam && (!Number.isFinite(limit) || Number(limit) < 1)) {
    return errorResponse("limit must be a positive number", 400);
  }

  try {
    const repository = getNotificationsRepository();
    const notifications = await repository.listByWallet(wallet, limit);
    return NextResponse.json({
      notifications,
      count: notifications.length,
      storage: repository.storageKind,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to load notifications", 500);
  }
}
