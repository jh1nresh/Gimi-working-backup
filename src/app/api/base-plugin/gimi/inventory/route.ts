import { NextRequest, NextResponse } from "next/server";
import { getRentableItems } from "@/lib/rentableItems";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const query = searchParams.get("query")?.trim().toLowerCase() ?? "";
  const limit = normalizeLimit(searchParams.get("limit"));
  const items = await getRentableItems();
  const matches = query
    ? items.filter((item) =>
        [item.name, item.brand, item.model, item.category, item.description, item.locationLabel]
          .join(" ")
          .toLowerCase()
          .includes(query)
      )
    : items;

  return NextResponse.json({
    query,
    count: matches.length,
    inventory: matches.slice(0, limit).map((item) => ({
      itemId: item.id,
      name: item.name,
      brand: item.brand,
      model: item.model,
      category: item.category,
      status: item.status,
      ratePerHourUsdc: item.ratePerHour,
      minimumFeeUsdc: item.minimumFee,
      depositUsdc: item.buyoutCap,
      expectedHours: item.expectedHours,
      ownerName: item.ownerName,
      ownerScore: item.ownerScore,
      pickup: item.locationLabel,
      imageUrl: item.imageUrl,
    })),
  });
}

function normalizeLimit(value: string | null) {
  const limit = Number(value ?? 8);
  if (!Number.isFinite(limit)) return 8;
  return Math.min(25, Math.max(1, Math.floor(limit)));
}
