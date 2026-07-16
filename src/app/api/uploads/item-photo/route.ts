import { NextRequest, NextResponse } from "next/server";
import { readItemPhoto, saveItemPhoto } from "@/lib/itemPhotoUploads";

const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const fileName = req.nextUrl.searchParams.get("file") ?? "";
  try {
    const photo = await readItemPhoto(fileName);
    return new NextResponse(photo.bytes, {
      headers: {
        "content-type": photo.contentType,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Photo not found", 404);
  }
}

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse("Expected multipart form data", 400);
  }

  const ownerWallet = String(formData.get("ownerWallet") ?? "").trim();
  const file = formData.get("photo");
  if (!WALLET_PATTERN.test(ownerWallet)) return errorResponse("ownerWallet must be a Solana-style address", 400);
  if (!(file instanceof File)) return errorResponse("photo file is required", 400);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const origin = new URL(req.url).origin;
    const photo = await saveItemPhoto({
      bytes,
      contentType: file.type,
      origin,
    });

    return NextResponse.json({
      photo,
      storage: process.env.VERCEL ? "tmp-ephemeral" : "file",
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to upload item photo", 400);
  }
}
