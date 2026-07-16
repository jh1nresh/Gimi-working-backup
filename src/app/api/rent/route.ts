import { NextRequest, NextResponse } from "next/server";
import { deriveRentProofAccounts } from "@/lib/rentproofProgram";
import { startRental } from "@/lib/store";

// POST /api/rent — starts a RentProof rental session for the demo surface.
export async function POST(req: NextRequest) {
  const body = await req.json();

  const { itemId, renterWallet, hours } = body;

  if (!itemId || !renterWallet || !hours) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const item = startRental(itemId, renterWallet, hours);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const rental = {
    id: `session_${itemId}`,
    itemId,
    renter: renterWallet,
    hours,
    rentalStart: Date.now(),
    status: "active",
    escrowAmount: item.buyoutCap,
    rentalTokenMint: `rent_${crypto.randomUUID().substring(0, 8)}`,
    txSignature: `devnet_mock_${crypto.randomUUID().substring(0, 12)}`,
    rentProof: deriveRentProofAccounts({
      itemId,
      ownerWallet: item.owner,
      renterWallet,
      rentalId: `session_${itemId}`,
    }),
  };

  return NextResponse.json({ rental, message: "Item rented successfully" });
}
