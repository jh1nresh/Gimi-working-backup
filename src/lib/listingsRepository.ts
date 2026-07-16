import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { CanonicalItemMetadata, PersistedListing, PersistedListingStatus } from "./listings";

export interface ListingsRepository {
  storageKind: string;
  listAvailable(): Promise<PersistedListing[]>;
  listByOwner(ownerWallet: string, limit?: number): Promise<PersistedListing[]>;
  save(listing: PersistedListing): Promise<PersistedListing>;
  getById(id: string): Promise<PersistedListing | undefined>;
  updateStatus(id: string, status: PersistedListingStatus): Promise<PersistedListing>;
  updateStatusForOwner(id: string, ownerWallet: string, status: PersistedListingStatus): Promise<PersistedListing>;
}

interface ListingRow {
  id: string;
  item_pda: string;
  owner_wallet: string;
  payment_mint: string;
  item_id_hash: string;
  metadata_hash: string;
  metadata: CanonicalItemMetadata;
  canonical_metadata_json: string;
  name: string;
  brand: string | null;
  model: string | null;
  category: string;
  condition: number;
  description: string;
  image_url: string;
  location_label: string;
  included: string[];
  rate_per_hour: number | string;
  minimum_fee: number | string;
  buyout_cap: number | string;
  auto_buyout_grace_seconds: number;
  status: PersistedListing["status"];
  initialize_signature: string;
  created_at: string;
  updated_at: string;
}

class FileListingsRepository implements ListingsRepository {
  readonly storageKind = process.env.VERCEL ? "file-ephemeral" : "file";

  constructor(private readonly filePath = process.env.LISTINGS_FILE_PATH ?? defaultListingsFilePath()) {}

  async listAvailable() {
    const listings = await this.readAll();
    return listings.filter((listing) => listing.status === "available");
  }

  async getById(id: string) {
    const listings = await this.readAll();
    return listings.find((listing) => listing.id === id);
  }

  async listByOwner(ownerWallet: string, limit = 20) {
    const listings = await this.readAll();
    return listings
      .filter((listing) => listing.ownerWallet === ownerWallet)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, normalizeLimit(limit));
  }

  async save(listing: PersistedListing) {
    const listings = await this.readAll();
    const index = listings.findIndex((entry) => entry.id === listing.id || entry.itemPda === listing.itemPda);
    const next = index >= 0 ? [...listings.slice(0, index), listing, ...listings.slice(index + 1)] : [...listings, listing];
    await this.writeAll(next);
    return listing;
  }

  async updateStatus(id: string, status: PersistedListingStatus) {
    const listings = await this.readAll();
    const index = listings.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("Listing not found");

    const listing = {
      ...listings[index],
      status,
      updatedAt: new Date().toISOString(),
    };
    const next = [...listings.slice(0, index), listing, ...listings.slice(index + 1)];
    await this.writeAll(next);
    return listing;
  }

  async updateStatusForOwner(id: string, ownerWallet: string, status: PersistedListingStatus) {
    const listing = await this.getById(id);
    if (!listing) throw new Error("Listing not found");
    if (listing.ownerWallet !== ownerWallet) throw new Error("Only the owner wallet can update this listing");
    return this.updateStatus(id, status);
  }

  private async readAll() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as PersistedListing[];
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(listings: PersistedListing[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(listings, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

class SupabaseListingsRepository implements ListingsRepository {
  readonly storageKind = "supabase";

  constructor(private readonly client: SupabaseClient) {}

  async listAvailable() {
    const { data, error } = await this.client
      .from("listings")
      .select("*")
      .eq("status", "available")
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Supabase listings read failed: ${error.message}`);
    return (data ?? []).map(rowToListing);
  }

  async getById(id: string) {
    const { data, error } = await this.client
      .from("listings")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(`Supabase listing lookup failed: ${error.message}`);
    return data ? rowToListing(data) : undefined;
  }

  async listByOwner(ownerWallet: string, limit = 20) {
    const { data, error } = await this.client
      .from("listings")
      .select("*")
      .eq("owner_wallet", ownerWallet)
      .order("updated_at", { ascending: false })
      .limit(normalizeLimit(limit));

    if (error) throw new Error(`Supabase owner listings read failed: ${error.message}`);
    return (data ?? []).map(rowToListing);
  }

  async save(listing: PersistedListing) {
    const { data, error } = await this.client
      .from("listings")
      .upsert(listingToRow(listing), { onConflict: "id" })
      .select("*")
      .single();

    if (error) throw new Error(`Supabase listing save failed: ${error.message}`);
    return rowToListing(data);
  }

  async updateStatus(id: string, status: PersistedListingStatus) {
    const { data, error } = await this.client
      .from("listings")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw new Error(`Supabase listing status update failed: ${error.message}`);
    return rowToListing(data);
  }

  async updateStatusForOwner(id: string, ownerWallet: string, status: PersistedListingStatus) {
    const { data, error } = await this.client
      .from("listings")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("owner_wallet", ownerWallet)
      .select("*")
      .single();

    if (error) throw new Error(`Supabase owner listing status update failed: ${error.message}`);
    return rowToListing(data);
  }
}

let repository: ListingsRepository | undefined;

export function getListingsRepository() {
  repository ??= createListingsRepository();
  return repository;
}

function createListingsRepository(): ListingsRepository {
  const config = supabaseConfig();
  if (!config) return new FileListingsRepository();

  return new SupabaseListingsRepository(
    createClient(config.url, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  );
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

function defaultListingsFilePath() {
  if (process.env.VERCEL) return path.join("/tmp", "tably-listings.json");
  return path.join(process.cwd(), ".rentproof", "listings.json");
}

function normalizeLimit(limit: number | undefined) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function listingToRow(listing: PersistedListing): ListingRow {
  return {
    id: listing.id,
    item_pda: listing.itemPda,
    owner_wallet: listing.ownerWallet,
    payment_mint: listing.paymentMint,
    item_id_hash: listing.itemIdHash,
    metadata_hash: listing.metadataHash,
    metadata: listing.metadata,
    canonical_metadata_json: listing.canonicalMetadataJson,
    name: listing.name,
    brand: listing.brand || null,
    model: listing.model || null,
    category: listing.category,
    condition: listing.condition,
    description: listing.description,
    image_url: listing.imageUrl,
    location_label: listing.locationLabel,
    included: listing.included,
    rate_per_hour: listing.ratePerHour,
    minimum_fee: listing.minimumFee,
    buyout_cap: listing.buyoutCap,
    auto_buyout_grace_seconds: listing.autoBuyoutGraceSeconds,
    status: listing.status,
    initialize_signature: listing.initializeSignature,
    created_at: listing.createdAt,
    updated_at: listing.updatedAt,
  };
}

function rowToListing(row: ListingRow): PersistedListing {
  return {
    id: row.id,
    ownerWallet: row.owner_wallet,
    metadata: row.metadata,
    canonicalMetadataJson: row.canonical_metadata_json,
    metadataHash: row.metadata_hash,
    name: row.name,
    brand: row.brand ?? "",
    model: row.model ?? "",
    category: row.category,
    condition: row.condition,
    description: row.description,
    imageUrl: row.image_url,
    locationLabel: row.location_label,
    included: row.included ?? [],
    ratePerHour: Number(row.rate_per_hour),
    minimumFee: Number(row.minimum_fee),
    buyoutCap: Number(row.buyout_cap),
    autoBuyoutGraceSeconds: row.auto_buyout_grace_seconds,
    createdAt: row.created_at,
    itemPda: row.item_pda,
    itemIdHash: row.item_id_hash,
    paymentMint: row.payment_mint,
    status: row.status,
    initializeSignature: row.initialize_signature,
    updatedAt: row.updated_at,
  };
}
