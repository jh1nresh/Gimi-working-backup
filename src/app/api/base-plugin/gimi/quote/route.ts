import { NextRequest, NextResponse } from "next/server";
import { buildBaseRentalQuote, normalizeBaseChain, baseChainConfig } from "@/lib/baseMcp";
import { getRentableItem } from "@/lib/rentableItems";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const itemId = searchParams.get("itemId")?.trim();

  if (!itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }

  const item = await getRentableItem(itemId);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const chain = normalizeBaseChain(searchParams.get("chain"));
  const chainConfig = baseChainConfig(chain);
  const quote = buildBaseRentalQuote(item, searchParams.get("hours"));

  return NextResponse.json({
    quote,
    item: {
      itemId: item.id,
      name: item.name,
      ownerName: item.ownerName,
      pickup: item.locationLabel,
      ownerScore: item.ownerScore,
      status: item.status,
    },
    paymentRail: {
      chain,
      chainId: chainConfig.chainId,
      token: {
        symbol: "USDC",
        address: chainConfig.usdcAddress,
        decimals: 6,
      },
      nextAction: "Call /api/base-plugin/gimi/prepare-deposit and submit the returned call through Base MCP send_calls.",
    },
  });
}
