import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type RentalReceiptOutcome = "returned_ok" | "auto_buyout" | "disputed";

export interface PersistedRentalReceipt {
  id: string;
  rentalId: string;
  itemId: string;
  sessionPda: string;
  itemPda: string;
  ownerWallet: string;
  renterWallet: string;
  paymentMint: string;
  outcome: RentalReceiptOutcome;
  settlementSignature: string;
  grossFee: string;
  platformFee: string;
  ownerPayout: string;
  renterRefund: string;
  rentalTokenStatus: "burned";
  createdAt: string;
}

export interface RentalReceiptsRepository {
  storageKind: string;
  save(receipt: PersistedRentalReceipt): Promise<PersistedRentalReceipt>;
  getByRentalId(rentalId: string): Promise<PersistedRentalReceipt | undefined>;
  listRecent(filters?: RentalReceiptListFilters): Promise<PersistedRentalReceipt[]>;
}

export interface RentalReceiptListFilters {
  wallet?: string;
  rentalId?: string;
  limit?: number;
}

interface RentalReceiptRow {
  id: string;
  rental_id: string;
  item_id: string;
  session_pda: string;
  item_pda: string;
  owner_wallet: string;
  renter_wallet: string;
  payment_mint: string;
  outcome: RentalReceiptOutcome;
  settlement_signature: string;
  gross_fee: string;
  platform_fee: string;
  owner_payout: string;
  renter_refund: string;
  rental_token_status: "burned";
  created_at: string;
}

class FileRentalReceiptsRepository implements RentalReceiptsRepository {
  readonly storageKind = process.env.VERCEL ? "file-ephemeral" : "file";

  constructor(private readonly filePath = process.env.RENTAL_RECEIPTS_FILE_PATH ?? defaultRentalReceiptsFilePath()) {}

  async getByRentalId(rentalId: string) {
    const receipts = await this.readAll();
    return receipts.find((receipt) => receipt.rentalId === rentalId);
  }

  async listRecent(filters: RentalReceiptListFilters = {}) {
    const limit = normalizeLimit(filters.limit);
    const receipts = await this.readAll();
    return receipts
      .filter((receipt) => {
        if (filters.rentalId && receipt.rentalId !== filters.rentalId) return false;
        if (filters.wallet && receipt.ownerWallet !== filters.wallet && receipt.renterWallet !== filters.wallet) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }

  async save(receipt: PersistedRentalReceipt) {
    const receipts = await this.readAll();
    const index = receipts.findIndex((entry) => entry.id === receipt.id || entry.rentalId === receipt.rentalId);
    const next = index >= 0 ? [...receipts.slice(0, index), receipt, ...receipts.slice(index + 1)] : [...receipts, receipt];
    await this.writeAll(next);
    return receipt;
  }

  private async readAll() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as PersistedRentalReceipt[];
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(receipts: PersistedRentalReceipt[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

class SupabaseRentalReceiptsRepository implements RentalReceiptsRepository {
  readonly storageKind = "supabase";

  constructor(private readonly client: SupabaseClient) {}

  async getByRentalId(rentalId: string) {
    const { data, error } = await this.client
      .from("rental_receipts")
      .select("*")
      .eq("rental_id", rentalId)
      .maybeSingle();

    if (error) throw new Error(`Supabase rental receipt lookup failed: ${error.message}`);
    return data ? rowToRentalReceipt(data) : undefined;
  }

  async listRecent(filters: RentalReceiptListFilters = {}) {
    const limit = normalizeLimit(filters.limit);
    let query = this.client.from("rental_receipts").select("*").order("created_at", { ascending: false }).limit(limit);

    if (filters.rentalId) {
      query = query.eq("rental_id", filters.rentalId);
    }
    if (filters.wallet) {
      query = query.or(`owner_wallet.eq.${filters.wallet},renter_wallet.eq.${filters.wallet}`);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Supabase rental receipt history failed: ${error.message}`);
    return (data ?? []).map(rowToRentalReceipt);
  }

  async save(receipt: PersistedRentalReceipt) {
    const { data, error } = await this.client
      .from("rental_receipts")
      .upsert(rentalReceiptToRow(receipt), { onConflict: "rental_id" })
      .select("*")
      .single();

    if (error) throw new Error(`Supabase rental receipt save failed: ${error.message}`);
    return rowToRentalReceipt(data);
  }
}

let repository: RentalReceiptsRepository | undefined;

export function getRentalReceiptsRepository() {
  repository ??= createRentalReceiptsRepository();
  return repository;
}

function createRentalReceiptsRepository(): RentalReceiptsRepository {
  const config = supabaseConfig();
  if (!config) return new FileRentalReceiptsRepository();

  return new SupabaseRentalReceiptsRepository(
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

function defaultRentalReceiptsFilePath() {
  if (process.env.VERCEL) return path.join("/tmp", "tably-rental-receipts.json");
  return path.join(process.cwd(), ".rentproof", "rental-receipts.json");
}

function normalizeLimit(limit: number | undefined) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 20;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

function rentalReceiptToRow(receipt: PersistedRentalReceipt): RentalReceiptRow {
  return {
    id: receipt.id,
    rental_id: receipt.rentalId,
    item_id: receipt.itemId,
    session_pda: receipt.sessionPda,
    item_pda: receipt.itemPda,
    owner_wallet: receipt.ownerWallet,
    renter_wallet: receipt.renterWallet,
    payment_mint: receipt.paymentMint,
    outcome: receipt.outcome,
    settlement_signature: receipt.settlementSignature,
    gross_fee: receipt.grossFee,
    platform_fee: receipt.platformFee,
    owner_payout: receipt.ownerPayout,
    renter_refund: receipt.renterRefund,
    rental_token_status: receipt.rentalTokenStatus,
    created_at: receipt.createdAt,
  };
}

function rowToRentalReceipt(row: RentalReceiptRow): PersistedRentalReceipt {
  return {
    id: row.id,
    rentalId: row.rental_id,
    itemId: row.item_id,
    sessionPda: row.session_pda,
    itemPda: row.item_pda,
    ownerWallet: row.owner_wallet,
    renterWallet: row.renter_wallet,
    paymentMint: row.payment_mint,
    outcome: row.outcome,
    settlementSignature: row.settlement_signature,
    grossFee: String(row.gross_fee),
    platformFee: String(row.platform_fee),
    ownerPayout: String(row.owner_payout),
    renterRefund: String(row.renter_refund),
    rentalTokenStatus: row.rental_token_status,
    createdAt: row.created_at,
  };
}
