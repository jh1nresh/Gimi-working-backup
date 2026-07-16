import { NextRequest, NextResponse } from "next/server";
import { isEvmAddress } from "@/lib/baseMcp";
import { getRentalIntentsRepository } from "@/lib/rentalIntentsRepository";
import { getRentalReceiptsRepository } from "@/lib/rentalReceiptsRepository";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  if (!wallet || !isEvmAddress(wallet)) {
    return NextResponse.json({ error: "wallet must be a 0x-prefixed EVM address" }, { status: 400 });
  }
  if (limitParam && (!Number.isFinite(limit) || Number(limit) < 1)) {
    return NextResponse.json({ error: "limit must be a positive number" }, { status: 400 });
  }

  const intentsRepository = getRentalIntentsRepository();
  const receiptsRepository = getRentalReceiptsRepository();
  const rentals = await intentsRepository.listByRenterWallet(wallet, limit);
  const receipts = await receiptsRepository.listRecent({ wallet, limit });

  return NextResponse.json({
    wallet,
    rentals,
    receipts,
    count: {
      rentals: rentals.length,
      receipts: receipts.length,
    },
    supportedNow: ["inventory", "quote", "prepare_deposit_call", "payment_confirmation", "history"],
    next: ["Base transaction indexer", "Base escrow contract"],
  });
}
