import { NextRequest, NextResponse } from "next/server";
import { createListingDraft, createListingPreview } from "@/lib/listings";
import { buildInitializeItemTransaction } from "@/lib/rentproofProgram";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const draft = createListingDraft(body);
    const serialized = await buildInitializeItemTransaction({
      ownerWallet: draft.ownerWallet,
      itemId: draft.id,
      metadataHash: draft.metadataHash,
      ratePerHour: draft.ratePerHour,
      minimumFee: draft.minimumFee,
      buyoutCap: draft.buyoutCap,
      autoBuyoutGraceSeconds: draft.autoBuyoutGraceSeconds,
    });
    const listingPreview = createListingPreview(draft, {
      itemPda: serialized.itemPda,
      itemIdHash: serialized.itemIdHash,
      paymentMint: serialized.paymentMint,
    });

    return NextResponse.json({
      draftId: draft.id,
      itemPda: serialized.itemPda,
      metadataHash: serialized.metadataHash,
      transaction: serialized.transactionBase64,
      transactionMetadata: {
        cluster: serialized.cluster,
        rpcUrl: serialized.rpcUrl,
        requiredSigner: serialized.requiredSigner,
        feePayer: serialized.feePayer,
        blockhash: serialized.blockhash,
        lastValidBlockHeight: serialized.lastValidBlockHeight,
      },
      listingPreview,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to prepare initialize_item transaction" },
      { status: 400 }
    );
  }
}
