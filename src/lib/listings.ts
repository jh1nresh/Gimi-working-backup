import { createHash, randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { RentalItem } from "./types";

export const ITEM_METADATA_SCHEMA = "tably.item.v1";
export const DEFAULT_EXPECTED_HOURS = 3;

export interface CanonicalItemMetadata {
  schema: typeof ITEM_METADATA_SCHEMA;
  itemId: string;
  name: string;
  brand: string;
  model: string;
  category: string;
  condition: number;
  description: string;
  imageUrl: string;
  locationLabel: string;
  included: string[];
  ownerWallet: string;
  createdAt: string;
}

export interface ListingDraft {
  id: string;
  ownerWallet: string;
  metadata: CanonicalItemMetadata;
  canonicalMetadataJson: string;
  metadataHash: string;
  name: string;
  brand: string;
  model: string;
  category: string;
  condition: number;
  description: string;
  imageUrl: string;
  locationLabel: string;
  included: string[];
  ratePerHour: number;
  minimumFee: number;
  buyoutCap: number;
  autoBuyoutGraceSeconds: number;
  createdAt: string;
}

export interface ListingPreview extends ListingDraft {
  itemPda: string;
  itemIdHash: string;
  paymentMint: string;
  status: "available";
}

export type PersistedListingStatus = "available" | "paused" | "rented" | "return_requested" | "buyout" | "disputed";

export interface PersistedListing extends Omit<ListingPreview, "status"> {
  status: PersistedListingStatus;
  initializeSignature: string;
  updatedAt: string;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string, options: { min?: number; max?: number } = {}) {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  const min = options.min ?? 1;
  if (trimmed.length < min) throw new Error(`${field} is required`);
  if (options.max && trimmed.length > options.max) throw new Error(`${field} is too long`);
  return trimmed;
}

function optionalStringField(record: Record<string, unknown>, field: string, max = 80) {
  const value = record[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} is too long`);
  return trimmed;
}

function numberField(record: Record<string, unknown>, field: string, options: { min: number; max?: number; integer?: boolean }) {
  const value = Number(record[field]);
  if (!Number.isFinite(value)) throw new Error(`${field} must be a number`);
  if (options.integer && !Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  if (value < options.min) throw new Error(`${field} must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max) throw new Error(`${field} must be at most ${options.max}`);
  return value;
}

function optionalIncluded(record: Record<string, unknown>) {
  const value = record.included;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("included must be an array");
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`included[${index}] must be a string`);
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 80) throw new Error(`included[${index}] is invalid`);
    return trimmed;
  });
}

function publicKeyString(value: string, field: string) {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new Error(`${field} must be a valid Solana public key`);
  }
}

function httpUrlString(value: string, field: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${field} must be an http(s) URL`);
  }
  return parsed.toString();
}

function hex32String(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${field} must be a 32-byte hex string`);
  }
  return value.toLowerCase();
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function metadataFromRecord(record: Record<string, unknown>, id: string, ownerWallet: string, createdAt: string) {
  const condition = numberField(record, "condition", { min: 1, max: 10, integer: true });
  const imageUrl = httpUrlString(stringField(record, "imageUrl", { max: 400 }), "imageUrl");

  return {
    schema: ITEM_METADATA_SCHEMA,
    itemId: id,
    name: stringField(record, "name", { max: 100 }),
    brand: optionalStringField(record, "brand"),
    model: optionalStringField(record, "model"),
    category: stringField(record, "category", { max: 80 }),
    condition,
    description: stringField(record, "description", { max: 1000 }),
    imageUrl,
    locationLabel: stringField(record, "locationLabel", { max: 140 }),
    included: optionalIncluded(record),
    ownerWallet,
    createdAt,
  } satisfies CanonicalItemMetadata;
}

function listingFieldsFromMetadata(metadata: CanonicalItemMetadata) {
  return {
    name: metadata.name,
    brand: metadata.brand,
    model: metadata.model,
    category: metadata.category,
    condition: metadata.condition,
    description: metadata.description,
    imageUrl: metadata.imageUrl,
    locationLabel: metadata.locationLabel,
    included: metadata.included,
    createdAt: metadata.createdAt,
  };
}

export function createListingDraft(input: unknown, now = new Date()) {
  const record = asRecord(input, "request body");
  const ownerWallet = publicKeyString(stringField(record, "ownerWallet"), "ownerWallet");
  const id = `item_${randomUUID()}`;
  const createdAt = now.toISOString();
  const metadata = metadataFromRecord(record, id, ownerWallet, createdAt);
  const ratePerHour = numberField(record, "ratePerHour", { min: 0.000001, max: 1_000_000 });
  const minimumFee = numberField(record, "minimumFee", { min: 0.000001, max: 1_000_000 });
  const buyoutCap = numberField(record, "buyoutCap", { min: minimumFee, max: 100_000_000 });
  const autoBuyoutGraceSeconds = numberField(record, "autoBuyoutGraceSeconds", {
    min: 0,
    max: 60 * 60 * 24 * 30,
    integer: true,
  });
  const canonicalMetadataJson = stableStringify(metadata);

  return {
    id,
    ownerWallet,
    metadata,
    canonicalMetadataJson,
    metadataHash: sha256Hex(canonicalMetadataJson),
    ...listingFieldsFromMetadata(metadata),
    ratePerHour,
    minimumFee,
    buyoutCap,
    autoBuyoutGraceSeconds,
  } satisfies ListingDraft;
}

export function createListingPreview(input: ListingDraft, chain: { itemPda: string; itemIdHash: string; paymentMint: string }) {
  return {
    ...input,
    itemPda: publicKeyString(chain.itemPda, "itemPda"),
    itemIdHash: hex32String(chain.itemIdHash, "itemIdHash"),
    paymentMint: publicKeyString(chain.paymentMint, "paymentMint"),
    status: "available",
  } satisfies ListingPreview;
}

export function normalizeListingPreview(input: unknown) {
  const record = asRecord(input, "listingPreview");
  const id = stringField(record, "id", { max: 120 });
  const ownerWallet = publicKeyString(stringField(record, "ownerWallet"), "ownerWallet");
  const createdAt = stringField(record, "createdAt", { max: 40 });
  const metadataRecord = asRecord(record.metadata, "listingPreview.metadata");
  const metadata = metadataFromRecord(metadataRecord, id, ownerWallet, createdAt);
  const canonicalMetadataJson = stableStringify(metadata);
  const metadataHash = sha256Hex(canonicalMetadataJson);
  const providedMetadataHash = hex32String(record.metadataHash, "metadataHash");

  if (providedMetadataHash !== metadataHash) {
    throw new Error("metadataHash does not match canonical metadata");
  }
  if (record.canonicalMetadataJson !== canonicalMetadataJson) {
    throw new Error("canonicalMetadataJson does not match canonical metadata");
  }

  const ratePerHour = numberField(record, "ratePerHour", { min: 0.000001, max: 1_000_000 });
  const minimumFee = numberField(record, "minimumFee", { min: 0.000001, max: 1_000_000 });
  const buyoutCap = numberField(record, "buyoutCap", { min: minimumFee, max: 100_000_000 });
  const autoBuyoutGraceSeconds = numberField(record, "autoBuyoutGraceSeconds", {
    min: 0,
    max: 60 * 60 * 24 * 30,
    integer: true,
  });

  return {
    id,
    ownerWallet,
    metadata,
    canonicalMetadataJson,
    metadataHash,
    ...listingFieldsFromMetadata(metadata),
    ratePerHour,
    minimumFee,
    buyoutCap,
    autoBuyoutGraceSeconds,
    itemPda: publicKeyString(stringField(record, "itemPda"), "itemPda"),
    itemIdHash: hex32String(record.itemIdHash, "itemIdHash"),
    paymentMint: publicKeyString(stringField(record, "paymentMint"), "paymentMint"),
    status: "available",
  } satisfies ListingPreview;
}

export function persistedListingFromPreview(preview: ListingPreview, initializeSignature: string, now = new Date()) {
  return {
    ...preview,
    initializeSignature,
    updatedAt: now.toISOString(),
  } satisfies PersistedListing;
}

export function listingToRentalItem(listing: PersistedListing): RentalItem {
  return {
    id: listing.id,
    name: listing.name,
    brand: listing.brand,
    model: listing.model,
    condition: listing.condition,
    description: listing.description,
    imageUrl: listing.imageUrl,
    ratePerHour: listing.ratePerHour,
    minimumFee: listing.minimumFee,
    buyoutCap: listing.buyoutCap,
    expectedHours: DEFAULT_EXPECTED_HOURS,
    status: listing.status,
    owner: listing.ownerWallet,
    ownerName: `${listing.ownerWallet.slice(0, 4)}...${listing.ownerWallet.slice(-4)}`,
    locationLabel: listing.locationLabel,
    category: listing.category,
    ownerScore: 80,
    returnedOkCount: 0,
    autoBuyoutCount: 0,
    disputeCount: 0,
    createdAt: Date.parse(listing.createdAt),
  };
}
