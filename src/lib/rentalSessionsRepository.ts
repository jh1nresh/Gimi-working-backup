import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type RentalSessionStatus = "active" | "returned" | "buyout" | "disputed";

export interface PersistedRentalSession {
  rentalId: string;
  rentalIdHash: string;
  itemId: string;
  itemPda: string;
  sessionPda: string;
  rentalTokenPda: string;
  escrowTokenAccount: string;
  ownerWallet: string;
  renterWallet: string;
  paymentMint: string;
  startSignature: string;
  startTs: number;
  dueTs: number;
  returnedTs?: number;
  escrowAmount: string;
  expectedFeeAtStart: string;
  finalFee?: string;
  ownerPayout?: string;
  platformFee?: string;
  renterRefund?: string;
  returnSignature?: string;
  autoBuyoutSignature?: string;
  settledAt?: string;
  status: RentalSessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RentalSessionsRepository {
  storageKind: string;
  save(session: PersistedRentalSession): Promise<PersistedRentalSession>;
  getByRentalId(rentalId: string): Promise<PersistedRentalSession | undefined>;
  listByWallet(wallet: string, filters?: { status?: RentalSessionStatus; limit?: number }): Promise<PersistedRentalSession[]>;
}

interface RentalSessionRow {
  rental_id: string;
  rental_id_hash: string;
  item_id: string;
  item_pda: string;
  session_pda: string;
  rental_token_pda: string;
  escrow_token_account: string;
  owner_wallet: string;
  renter_wallet: string;
  payment_mint: string;
  start_signature: string;
  start_ts: number;
  due_ts: number;
  returned_ts: number | string;
  escrow_amount: string;
  expected_fee_at_start: string;
  final_fee: string;
  owner_payout: string;
  platform_fee: string;
  renter_refund: string;
  return_signature?: string | null;
  auto_buyout_signature?: string | null;
  settled_at?: string | null;
  status: RentalSessionStatus;
  created_at: string;
  updated_at: string;
}

class FileRentalSessionsRepository implements RentalSessionsRepository {
  readonly storageKind = process.env.VERCEL ? "file-ephemeral" : "file";

  constructor(private readonly filePath = process.env.RENTAL_SESSIONS_FILE_PATH ?? defaultRentalSessionsFilePath()) {}

  async getByRentalId(rentalId: string) {
    const sessions = await this.readAll();
    return sessions.find((session) => session.rentalId === rentalId);
  }

  async listByWallet(wallet: string, filters: { status?: RentalSessionStatus; limit?: number } = {}) {
    const limit = normalizeLimit(filters.limit);
    const sessions = await this.readAll();
    return sessions
      .filter((session) => {
        if (session.ownerWallet !== wallet && session.renterWallet !== wallet) return false;
        if (filters.status && session.status !== filters.status) return false;
        return true;
      })
      .sort((a, b) => b.startTs - a.startTs)
      .slice(0, limit);
  }

  async save(session: PersistedRentalSession) {
    const sessions = await this.readAll();
    const index = sessions.findIndex((entry) => entry.rentalId === session.rentalId || entry.sessionPda === session.sessionPda);
    const next = index >= 0 ? [...sessions.slice(0, index), session, ...sessions.slice(index + 1)] : [...sessions, session];
    await this.writeAll(next);
    return session;
  }

  private async readAll() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as PersistedRentalSession[];
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(sessions: PersistedRentalSession[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

class SupabaseRentalSessionsRepository implements RentalSessionsRepository {
  readonly storageKind = "supabase";

  constructor(private readonly client: SupabaseClient) {}

  async getByRentalId(rentalId: string) {
    const { data, error } = await this.client
      .from("rental_sessions")
      .select("*")
      .eq("rental_id", rentalId)
      .maybeSingle();

    if (error) throw new Error(`Supabase rental session lookup failed: ${error.message}`);
    return data ? rowToRentalSession(data) : undefined;
  }

  async listByWallet(wallet: string, filters: { status?: RentalSessionStatus; limit?: number } = {}) {
    const limit = normalizeLimit(filters.limit);
    let query = this.client
      .from("rental_sessions")
      .select("*")
      .or(`owner_wallet.eq.${wallet},renter_wallet.eq.${wallet}`)
      .order("start_ts", { ascending: false })
      .limit(limit);

    if (filters.status) query = query.eq("status", filters.status);

    const { data, error } = await query;
    if (error) throw new Error(`Supabase rental session history failed: ${error.message}`);
    return (data ?? []).map(rowToRentalSession);
  }

  async save(session: PersistedRentalSession) {
    const { data, error } = await this.client
      .from("rental_sessions")
      .upsert(rentalSessionToRow(session), { onConflict: "rental_id" })
      .select("*")
      .single();

    if (error) throw new Error(`Supabase rental session save failed: ${error.message}`);
    return rowToRentalSession(data);
  }
}

function normalizeLimit(limit: number | undefined) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 20;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

let repository: RentalSessionsRepository | undefined;

export function getRentalSessionsRepository() {
  repository ??= createRentalSessionsRepository();
  return repository;
}

function createRentalSessionsRepository(): RentalSessionsRepository {
  const config = supabaseConfig();
  if (!config) return new FileRentalSessionsRepository();

  return new SupabaseRentalSessionsRepository(
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

function defaultRentalSessionsFilePath() {
  if (process.env.VERCEL) return path.join("/tmp", "tably-rental-sessions.json");
  return path.join(process.cwd(), ".rentproof", "rental-sessions.json");
}

function rentalSessionToRow(session: PersistedRentalSession): RentalSessionRow {
  return {
    rental_id: session.rentalId,
    rental_id_hash: session.rentalIdHash,
    item_id: session.itemId,
    item_pda: session.itemPda,
    session_pda: session.sessionPda,
    rental_token_pda: session.rentalTokenPda,
    escrow_token_account: session.escrowTokenAccount,
    owner_wallet: session.ownerWallet,
    renter_wallet: session.renterWallet,
    payment_mint: session.paymentMint,
    start_signature: session.startSignature,
    start_ts: session.startTs,
    due_ts: session.dueTs,
    returned_ts: session.returnedTs ?? 0,
    escrow_amount: session.escrowAmount,
    expected_fee_at_start: session.expectedFeeAtStart,
    final_fee: session.finalFee ?? "0",
    owner_payout: session.ownerPayout ?? "0",
    platform_fee: session.platformFee ?? "0",
    renter_refund: session.renterRefund ?? "0",
    return_signature: session.returnSignature ?? null,
    auto_buyout_signature: session.autoBuyoutSignature ?? null,
    settled_at: session.settledAt ?? null,
    status: session.status,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

function rowToRentalSession(row: RentalSessionRow): PersistedRentalSession {
  return {
    rentalId: row.rental_id,
    rentalIdHash: row.rental_id_hash,
    itemId: row.item_id,
    itemPda: row.item_pda,
    sessionPda: row.session_pda,
    rentalTokenPda: row.rental_token_pda,
    escrowTokenAccount: row.escrow_token_account,
    ownerWallet: row.owner_wallet,
    renterWallet: row.renter_wallet,
    paymentMint: row.payment_mint,
    startSignature: row.start_signature,
    startTs: Number(row.start_ts),
    dueTs: Number(row.due_ts),
    returnedTs: Number(row.returned_ts ?? 0),
    escrowAmount: String(row.escrow_amount),
    expectedFeeAtStart: String(row.expected_fee_at_start),
    finalFee: String(row.final_fee ?? "0"),
    ownerPayout: String(row.owner_payout ?? "0"),
    platformFee: String(row.platform_fee ?? "0"),
    renterRefund: String(row.renter_refund ?? "0"),
    returnSignature: row.return_signature ?? undefined,
    autoBuyoutSignature: row.auto_buyout_signature ?? undefined,
    settledAt: row.settled_at ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
