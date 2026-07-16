import { NextRequest, NextResponse } from "next/server";

// POST /api/list — create a community rental offer.
export async function POST(req: NextRequest) {
  const body = await req.json();

  const { name, brand, model, condition, description, category, ratePerHour, buyoutCap, locationLabel } = body;

  if (!name || !brand || !category) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const listing = {
    id: crypto.randomUUID(),
    name,
    brand,
    model: model || "",
    condition: condition || 7,
    description: description || "",
    category,
    ratePerHour: ratePerHour || 1,
    minimumFee: 2,
    buyoutCap: buyoutCap || 20,
    expectedHours: 3,
    status: "available",
    imageUrl: "https://images.unsplash.com/photo-1560472355-536de3962603?w=400&h=300&fit=crop",
    ownerScore: 80,
    returnedOkCount: 0,
    autoBuyoutCount: 0,
    disputeCount: 0,
    ownerName: "New owner",
    locationLabel: locationLabel || "Community desk",
    createdAt: Date.now(),
    itemAccount: `item_${crypto.randomUUID().substring(0, 8)}`,
  };

  return NextResponse.json({ listing, message: "Item listed successfully" });
}
