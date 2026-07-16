import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type RentalIntentPaymentMethod = "card" | "solana_wallet" | "base_mcp";
export type RentalIntentPaymentStatus = "created" | "requires_action" | "confirmed" | "failed" | "expired";
export type RentalIntentEscrowStatus = "not_funded" | "provider_authorized" | "provider_captured" | "onchain_locked";
export type RentalIntentSessionStatus = "intent" | "reserved" | "active" | "returned" | "cancelled";
export type RentalIntentReceiptStatus = "none" | "pending_onchain" | "issued";
export type RentalIntentSettlementStatus = "none" | "pending_provider" | "settled" | "failed";

export interface PersistedRentalIntent {
  id: string;
  itemId: string;
  itemName: string;
  ownerWallet: string;
  renterWallet?: string;
  renterIdentity?: string;
  paymentMethod: RentalIntentPaymentMethod;
  paymentStatus: RentalIntentPaymentStatus;
  escrowStatus: RentalIntentEscrowStatus;
  sessionStatus: RentalIntentSessionStatus;
  receiptStatus: RentalIntentReceiptStatus;
  currency: "USD" | "USDC";
  durationHours: number;
  rentAmount: number;
  depositAmount: number;
  platformFeeEstimate: number;
  provider?: string;
  providerCheckoutUrl?: string;
  providerPaymentId?: string;
  rentalId?: string;
  activatedAt?: string;
  returnedAt?: string;
  finalFee?: number;
  ownerPayout?: number;
  platformFee?: number;
  renterRefund?: number;
  settlementStatus?: RentalIntentSettlementStatus;
  receiptSignature?: string;
  receiptIssuedAt?: string;
  notes?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RentalIntentsRepository {
  storageKind: string;
  save(intent: PersistedRentalIntent): Promise<PersistedRentalIntent>;
  compareAndSave(intent: PersistedRentalIntent, expectedUpdatedAt: string): Promise<PersistedRentalIntent | undefined>;
  getById(id: string): Promise<PersistedRentalIntent | undefined>;
  getByProviderPaymentId(providerPaymentId: string): Promise<PersistedRentalIntent | undefined>;
  listByRenterWallet(wallet: string, limit?: number): Promise<PersistedRentalIntent[]>;
  listByOwnerWallet(wallet: string, limit?: number): Promise<PersistedRentalIntent[]>;
}

interface RentalIntentRow {
  id: string;
  item_id: string;
  item_name: string;
  owner_wallet: string;
  renter_wallet?: string | null;
  renter_identity?: string | null;
  payment_method: RentalIntentPaymentMethod;
  payment_status: RentalIntentPaymentStatus;
  escrow_status: RentalIntentEscrowStatus;
  session_status: RentalIntentSessionStatus;
  receipt_status: RentalIntentReceiptStatus;
  currency: "USD" | "USDC";
  duration_hours: number | string;
  rent_amount: number | string;
  deposit_amount: number | string;
  platform_fee_estimate: number | string;
  provider?: string | null;
  provider_checkout_url?: string | null;
  provider_payment_id?: string | null;
  rental_id?: string | null;
  activated_at?: string | null;
  returned_at?: string | null;
  final_fee?: number | string;
  owner_payout?: number | string;
  platform_fee?: number | string;
  renter_refund?: number | string;
  settlement_status?: RentalIntentSettlementStatus | null;
  receipt_signature?: string | null;
  receipt_issued_at?: string | null;
  notes?: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export class FileRentalIntentsRepository implements RentalIntentsRepository {
  readonly storageKind = process.env.VERCEL ? "file-ephemeral" : "file";
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = process.env.RENTAL_INTENTS_FILE_PATH ?? defaultRentalIntentsFilePath()) {}

  async getById(id: string) {
    await this.writeQueue;
    const intents = await this.readAll();
    return intents.find((intent) => intent.id === id);
  }

  async getByProviderPaymentId(providerPaymentId: string) {
    await this.writeQueue;
    const intents = await this.readAll();
    return intents.find((intent) => intent.providerPaymentId === providerPaymentId);
  }

  async listByRenterWallet(wallet: string, limit = 20) {
    await this.writeQueue;
    const intents = await this.readAll();
    return intents
      .filter((intent) => intent.renterWallet === wallet)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, normalizeLimit(limit));
  }

  async listByOwnerWallet(wallet: string, limit = 20) {
    await this.writeQueue;
    const intents = await this.readAll();
    return intents
      .filter((intent) => intent.ownerWallet === wallet)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, normalizeLimit(limit));
  }

  async save(intent: PersistedRentalIntent) {
    return this.enqueue(async () => {
      const intents = await this.readAll();
      await this.writeAll(upsertIntent(intents, intent));
      return intent;
    });
  }

  async compareAndSave(intent: PersistedRentalIntent, expectedUpdatedAt: string) {
    return this.enqueue(async () => {
      const intents = await this.readAll();
      const current = intents.find((entry) => entry.id === intent.id);
      if (!current || current.updatedAt !== expectedUpdatedAt) return undefined;
      await this.writeAll(upsertIntent(intents, intent));
      return intent;
    });
  }

  private async enqueue<T>(operation: () => Promise<T>) {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readAll() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as PersistedRentalIntent[];
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(intents: PersistedRentalIntent[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(intents, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

class SupabaseRentalIntentsRepository implements RentalIntentsRepository {
  readonly storageKind = "supabase";

  constructor(private readonly client: SupabaseClient) {}

  async getById(id: string) {
    const { data, error } = await this.client.from("rental_intents").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`Supabase rental intent lookup failed: ${error.message}`);
    return data ? rowToRentalIntent(data) : undefined;
  }

  async getByProviderPaymentId(providerPaymentId: string) {
    const { data, error } = await this.client
      .from("rental_intents")
      .select("*")
      .eq("provider_payment_id", providerPaymentId)
      .maybeSingle();

    if (error) throw new Error(`Supabase rental intent provider lookup failed: ${error.message}`);
    return data ? rowToRentalIntent(data) : undefined;
  }

  async listByRenterWallet(wallet: string, limit = 20) {
    const { data, error } = await this.client
      .from("rental_intents")
      .select("*")
      .eq("renter_wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(normalizeLimit(limit));

    if (error) throw new Error(`Supabase rental intent history failed: ${error.message}`);
    return (data ?? []).map(rowToRentalIntent);
  }

  async listByOwnerWallet(wallet: string, limit = 20) {
    const { data, error } = await this.client
      .from("rental_intents")
      .select("*")
      .eq("owner_wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(normalizeLimit(limit));

    if (error) throw new Error(`Supabase owner rental intent history failed: ${error.message}`);
    return (data ?? []).map(rowToRentalIntent);
  }

  async save(intent: PersistedRentalIntent) {
    const { data, error } = await this.client
      .from("rental_intents")
      .upsert(rentalIntentToRow(intent), { onConflict: "id" })
      .select("*")
      .single();

    if (error) throw new Error(`Supabase rental intent save failed: ${error.message}`);
    return rowToRentalIntent(data);
  }

  async compareAndSave(intent: PersistedRentalIntent, expectedUpdatedAt: string) {
    const { data, error } = await this.client
      .from("rental_intents")
      .update(rentalIntentToRow(intent))
      .eq("id", intent.id)
      .eq("updated_at", expectedUpdatedAt)
      .select("*")
      .maybeSingle();

    if (error) throw new Error(`Supabase rental intent conditional save failed: ${error.message}`);
    return data ? rowToRentalIntent(data) : undefined;
  }
}

let repository: RentalIntentsRepository | undefined;

export function getRentalIntentsRepository() {
  repository ??= createRentalIntentsRepository();
  return repository;
}

export function newRentalIntentId() {
  return `intent_${randomUUID()}`;
}

function createRentalIntentsRepository(): RentalIntentsRepository {
  const config = supabaseConfig();
  if (!config) return new FileRentalIntentsRepository();

  return new SupabaseRentalIntentsRepository(
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

function defaultRentalIntentsFilePath() {
  if (process.env.VERCEL) return path.join("/tmp", "gimi-rental-intents.json");
  return path.join(process.cwd(), ".rentproof", "rental-intents.json");
}

function normalizeLimit(limit: number | undefined) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 20;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

function upsertIntent(intents: PersistedRentalIntent[], intent: PersistedRentalIntent) {
  const index = intents.findIndex((entry) => entry.id === intent.id);
  return index >= 0 ? [...intents.slice(0, index), intent, ...intents.slice(index + 1)] : [...intents, intent];
}

function rentalIntentToRow(intent: PersistedRentalIntent): RentalIntentRow {
  return {
    id: intent.id,
    item_id: intent.itemId,
    item_name: intent.itemName,
    owner_wallet: intent.ownerWallet,
    renter_wallet: intent.renterWallet ?? null,
    renter_identity: intent.renterIdentity ?? null,
    payment_method: intent.paymentMethod,
    payment_status: intent.paymentStatus,
    escrow_status: intent.escrowStatus,
    session_status: intent.sessionStatus,
    receipt_status: intent.receiptStatus,
    currency: intent.currency,
    duration_hours: intent.durationHours,
    rent_amount: intent.rentAmount,
    deposit_amount: intent.depositAmount,
    platform_fee_estimate: intent.platformFeeEstimate,
    provider: intent.provider ?? null,
    provider_checkout_url: intent.providerCheckoutUrl ?? null,
    provider_payment_id: intent.providerPaymentId ?? null,
    rental_id: intent.rentalId ?? null,
    activated_at: intent.activatedAt ?? null,
    returned_at: intent.returnedAt ?? null,
    final_fee: intent.finalFee ?? 0,
    owner_payout: intent.ownerPayout ?? 0,
    platform_fee: intent.platformFee ?? 0,
    renter_refund: intent.renterRefund ?? 0,
    settlement_status: intent.settlementStatus ?? "none",
    receipt_signature: intent.receiptSignature ?? null,
    receipt_issued_at: intent.receiptIssuedAt ?? null,
    notes: intent.notes ?? null,
    expires_at: intent.expiresAt,
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
  };
}

function rowToRentalIntent(row: RentalIntentRow): PersistedRentalIntent {
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    ownerWallet: row.owner_wallet,
    renterWallet: row.renter_wallet ?? undefined,
    renterIdentity: row.renter_identity ?? undefined,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    escrowStatus: row.escrow_status,
    sessionStatus: row.session_status,
    receiptStatus: row.receipt_status,
    currency: row.currency,
    durationHours: Number(row.duration_hours),
    rentAmount: Number(row.rent_amount),
    depositAmount: Number(row.deposit_amount),
    platformFeeEstimate: Number(row.platform_fee_estimate),
    provider: row.provider ?? undefined,
    providerCheckoutUrl: row.provider_checkout_url ?? undefined,
    providerPaymentId: row.provider_payment_id ?? undefined,
    rentalId: row.rental_id ?? undefined,
    activatedAt: row.activated_at ?? undefined,
    returnedAt: row.returned_at ?? undefined,
    finalFee: Number(row.final_fee ?? 0),
    ownerPayout: Number(row.owner_payout ?? 0),
    platformFee: Number(row.platform_fee ?? 0),
    renterRefund: Number(row.renter_refund ?? 0),
    settlementStatus: row.settlement_status ?? "none",
    receiptSignature: row.receipt_signature ?? undefined,
    receiptIssuedAt: row.receipt_issued_at ?? undefined,
    notes: row.notes ?? undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
