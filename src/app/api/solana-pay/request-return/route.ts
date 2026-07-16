import { NextRequest, NextResponse } from "next/server";
import { getRentableItem } from "@/lib/rentableItems";
import {
  buildRequestReturnTransaction,
  deriveRentProofAccounts,
  preflightRequestReturn,
} from "@/lib/rentproofProgram";

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
  const preflight = await preflightRequestReturn({
    itemId: item.id,
    ownerWallet: body.ownerWallet ?? item.owner,
    renterWallet: body.renterWallet,
    rentalId,
  });

  if (!preflight.ok) {
    return NextResponse.json(
      {
        error: "Return request preflight failed",
        problems: preflight.problems,
        preflight,
        rentProof,
      },
      { status: 409 }
    );
  }

  const serialized = await buildRequestReturnTransaction({
    itemId: item.id,
    ownerWallet: body.ownerWallet ?? item.owner,
    renterWallet: body.renterWallet,
    rentalId,
  });

  return NextResponse.json({
    rentalId,
    rentProof,
    preflight,
    programStatus: "devnet_program_deployed_unsigned_transaction_serialized",
    transaction: serialized.transactionBase64,
    message: `Request return for ${item.name}. Renter signs to record a return-request timestamp on-chain before owner confirmation.`,
    transactionMetadata: {
      cluster: serialized.cluster,
      rpcUrl: serialized.rpcUrl,
      blockhash: serialized.blockhash,
      lastValidBlockHeight: serialized.lastValidBlockHeight,
      feePayer: serialized.rentProof.accounts.renter,
      requiredSigner: serialized.rentProof.accounts.renter,
    },
    transactionPlan: [
      "request_return",
      "verify_active_session_and_rental_token",
      "record_return_requested_timestamp",
      "emit_return_requested_receipt",
    ],
    instructionArgs: {
      requestReturn: {
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
