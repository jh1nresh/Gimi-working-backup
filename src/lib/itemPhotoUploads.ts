import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

export interface StoredItemPhoto {
  fileName: string;
  contentType: string;
  size: number;
  imageUrl: string;
}

export function itemPhotoUploadDir() {
  if (process.env.VERCEL) return path.join("/tmp", "gimi-item-photos");
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".rentproof", "item-photos");
}

export async function saveItemPhoto(input: {
  bytes: Uint8Array;
  contentType: string;
  origin: string;
}): Promise<StoredItemPhoto> {
  const extension = ALLOWED_CONTENT_TYPES.get(input.contentType);
  if (!extension) throw new Error("Photo must be JPEG, PNG, WebP, or GIF");
  if (input.bytes.byteLength <= 0) throw new Error("Photo file is empty");
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("Photo must be smaller than 5 MB");

  const fileName = `${randomUUID()}.${extension}`;
  const uploadDir = itemPhotoUploadDir();
  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, fileName), input.bytes);

  return {
    fileName,
    contentType: input.contentType,
    size: input.bytes.byteLength,
    imageUrl: `${input.origin}/api/uploads/item-photo?file=${encodeURIComponent(fileName)}`,
  };
}

export async function readItemPhoto(fileName: string) {
  if (!/^[a-f0-9-]{36}\.(jpg|png|webp|gif)$/.test(fileName)) {
    throw new Error("Invalid photo file");
  }

  const extension = fileName.split(".").pop() ?? "";
  const contentType = [...ALLOWED_CONTENT_TYPES.entries()].find(([, ext]) => ext === extension)?.[0];
  if (!contentType) throw new Error("Unsupported photo type");

  return {
    bytes: await readFile(path.join(itemPhotoUploadDir(), fileName)),
    contentType,
  };
}
