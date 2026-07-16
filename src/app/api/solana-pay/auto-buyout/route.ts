import { NextRequest, NextResponse } from "next/server";
import { getRentableItem } from "@/lib/rentableItems";
import { buildSettleRentalTransaction, deriveRentProofAccounts, preflightSettleRental } from "@/lib/rentproofProgram";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const item = await getRentableItem(body.itemId ?? "power_bank_18");

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (!body.renterWallet) {
    return NextResponse.json({ error: "Missing renter wallet" }, { status: 400 });
  }
  if (!body.rentalId && !body.draftId) {
    return NextResponse.json({ error: "Missing rental id" }, { status: 400 });
  }

  const rentalId = body.rentalId ?? body.draftId;
  const rentProof = deriveRentProofAccounts({
    itemId: item.id,
    ownerWallet: body.ownerWallet ?? item.owner,
    renterWallet: body.renterWallet,
    rentalId,
  });
  const preflight = await preflightSettleRental({
    itemId: item.id,
    ownerWallet: body.ownerWallet ?? item.owner,
    renterWallet: body.renterWallet,
    rentalId,
  });

  if (!preflight.ok) {
    return NextResponse.json(
      {
        error: "Settlement preflight failed",
        problems: preflight.problems,
        preflight,
        rentProof,
      },
      { status: 409 }
    );
  }

  const serialized = await buildSettleRentalTransaction({
    kind: "auto_buyout",
    itemId: item.id,
    ownerWallet: body.ownerWallet ?? item.owner,
    renterWallet: body.renterWallet,
    payerWallet: body.payerWallet ?? body.ownerWallet ?? item.owner,
    rentalId,
  });

  return NextResponse.json({
    rentalId,
    rentProof,
    preflight,
    programStatus: "devnet_program_deployed_unsigned_transaction_serialized",
    transaction: serialized.transactionBase64,
    message: `Auto-buyout ${item.name}. Any keeper wallet can sign after due time plus grace to claim escrow for the owner and close rental-token state.`,
    transactionMetadata: {
      cluster: serialized.cluster,
      rpcUrl: serialized.rpcUrl,
      blockhash: serialized.blockhash,
      lastValidBlockHeight: serialized.lastValidBlockHeight,
      feePayer: serialized.feePayer,
      requiredSigner: serialized.requiredSigner,
    },
    transactionPlan: [
      "auto_buyout",
      "preflight_session_and_token_accounts",
      "idempotently_create_missing_destination_atas",
      "verify_due_time_plus_grace",
      "pay_owner_and_platform",
      "close_escrow_and_rental_token",
      "emit_rental_bought_out_receipt",
    ],
    instructionArgs: {
      autoBuyout: {
        rentalIdHash: rentProof.rentalIdHash,
      },
    },
    item: {
      id: item.id,
      name: item.name,
      renterWallet: body.renterWallet,
    },
  });
}
