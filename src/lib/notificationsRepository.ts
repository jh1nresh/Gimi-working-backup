import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type NotificationKind = "rental_handoff" | "rental_returned" | "receipt_issued" | "listing_status";

export interface PersistedNotification {
  id: string;
  wallet: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href?: string;
  readAt?: string;
  createdAt: string;
}

export interface NotificationsRepository {
  storageKind: string;
  save(notification: PersistedNotification): Promise<PersistedNotification>;
  listByWallet(wallet: string, limit?: number): Promise<PersistedNotification[]>;
}

interface NotificationRow {
  id: string;
  wallet: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href?: string | null;
  read_at?: string | null;
  created_at: string;
}

class FileNotificationsRepository implements NotificationsRepository {
  readonly storageKind = process.env.VERCEL ? "file-ephemeral" : "file";

  constructor(private readonly filePath = process.env.NOTIFICATIONS_FILE_PATH ?? defaultNotificationsFilePath()) {}

  async save(notification: PersistedNotification) {
    const notifications = await this.readAll();
    const next = [notification, ...notifications.filter((entry) => entry.id !== notification.id)].slice(0, 500);
    await this.writeAll(next);
    return notification;
  }

  async listByWallet(wallet: string, limit = 20) {
    const notifications = await this.readAll();
    return notifications
      .filter((notification) => notification.wallet === wallet)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, normalizeLimit(limit));
  }

  private async readAll() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PersistedNotification[]) : [];
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(notifications: PersistedNotification[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(notifications, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

class SupabaseNotificationsRepository implements NotificationsRepository {
  readonly storageKind = "supabase";

  constructor(private readonly client: SupabaseClient) {}

  async save(notification: PersistedNotification) {
    const { data, error } = await this.client
      .from("notifications")
      .upsert(notificationToRow(notification), { onConflict: "id" })
      .select("*")
      .single();

    if (error) throw new Error(`Supabase notification save failed: ${error.message}`);
    return rowToNotification(data);
  }

  async listByWallet(wallet: string, limit = 20) {
    const { data, error } = await this.client
      .from("notifications")
      .select("*")
      .eq("wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(normalizeLimit(limit));

    if (error) throw new Error(`Supabase notifications read failed: ${error.message}`);
    return (data ?? []).map(rowToNotification);
  }
}

let repository: NotificationsRepository | undefined;

export function getNotificationsRepository() {
  repository ??= createNotificationsRepository();
  return repository;
}

export function newNotification(input: Omit<PersistedNotification, "id" | "createdAt">) {
  return {
    id: `notification_${randomUUID()}`,
    ...input,
    createdAt: new Date().toISOString(),
  } satisfies PersistedNotification;
}

function createNotificationsRepository(): NotificationsRepository {
  const config = supabaseConfig();
  if (!config) return new FileNotificationsRepository();

  return new SupabaseNotificationsRepository(
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

function defaultNotificationsFilePath() {
  if (process.env.VERCEL) return path.join("/tmp", "gimi-notifications.json");
  return path.join(process.cwd(), ".rentproof", "notifications.json");
}

function normalizeLimit(limit: number | undefined) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 20;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

function notificationToRow(notification: PersistedNotification): NotificationRow {
  return {
    id: notification.id,
    wallet: notification.wallet,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    href: notification.href ?? null,
    read_at: notification.readAt ?? null,
    created_at: notification.createdAt,
  };
}

function rowToNotification(row: NotificationRow): PersistedNotification {
  return {
    id: row.id,
    wallet: row.wallet,
    kind: row.kind,
    title: row.title,
    body: row.body,
    href: row.href ?? undefined,
    readAt: row.read_at ?? undefined,
    createdAt: row.created_at,
  };
}
