import { NextRequest, NextResponse } from "next/server";
import { quoteLifiFunding } from "@/lib/lifi";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const amount = Number(body.amount ?? 30);

  try {
    const route = await quoteLifiFunding({
      amount,
      sourceChain: body.sourceChain,
      sourceToken: body.sourceToken,
      targetChain: body.targetChain,
      targetToken: body.targetToken,
      fromAddress: body.fromAddress ?? body.sourceAddress,
      toAddress: body.toAddress ?? body.targetAddress ?? body.renterWallet,
      requireReal: Boolean(body.requireReal),
    });

    return NextResponse.json({ route });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "LI.FI quote failed",
      },
      { status: 502 }
    );
  }
}
