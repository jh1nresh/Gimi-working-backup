import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { PersistedRentalIntent } from "./rentalIntentsRepository";

export type ExecutionEnvironment = "local" | "preview" | "devnet" | "testnet" | "mainnet";
export type ActivityType = "seeded_demo" | "internal_test" | "partner_pilot" | "organic_user";
export type PaymentMode = "simulated" | "provider_authorized" | "onchain_confirmed";
export type ExecutionActor = "renter" | "owner" | "gimi_agent" | "payment_provider" | "chain";
export type ExecutionStatus = "planned" | "waiting" | "completed" | "failed" | "recovered";
export type ExecutionStep =
  | "intent_received"
  | "inventory_searched"
  | "offer_selected"
  | "terms_drafted"
  | "approval_requested"
  | "rental_funded"
  | "handoff_confirmed"
  | "return_confirmed"
  | "settlement_completed"
  | "receipt_issued";

export interface PersistedRentalExecutionEvent {
  id: string;
  intentId: string;
  rentalId?: string;
  itemId: string;
  step: ExecutionStep;
  actor: ExecutionActor;
  tool: string;
  summary: string;
  approvalRequired: boolean;
  status: ExecutionStatus;
  environment: ExecutionEnvironment;
  activityType: ActivityType;
  paymentMode: PaymentMode;
  recordRef?: string;
  createdAt: string;
}

export interface NewExecutionEvent
  extends Omit<PersistedRentalExecutionEvent, "id" | "environment" | "activityType" | "createdAt"> {
  eventKey: string;
  environment?: ExecutionEnvironment;
  activityType?: ActivityType;
  createdAt?: string;
}

export interface RentalExecutionEventsRepository {
  storageKind: string;
  record(event: PersistedRentalExecutionEvent): Promise<PersistedRentalExecutionEvent>;
  listByIntentIds(intentIds: string[]): Promise<PersistedRentalExecutionEvent[]>;
}

interface ExecutionEventRow {
  id: string;
  intent_id: string;
  rental_id?: string | null;
  item_id: string;
  step: ExecutionStep;
  actor: ExecutionActor;
  tool: string;
  summary: string;
  approval_required: boolean;
  status: ExecutionStatus;
  environment: ExecutionEnvironment;
  activity_type: ActivityType;
  payment_mode: PaymentMode;
  record_ref?: string | null;
  created_at: string;
}

export class FileRentalExecutionEventsRepository implements RentalExecutionEventsRepository {
  readonly storageKind = process.env.VERCEL ? "file-ephemeral" : "file";
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath = defaultExecutionEventsFilePath()) {
    this.filePath = filePath;
  }

  async record(event: PersistedRentalExecutionEvent) {
    const operation = this.writeQueue.then(async () => {
      const events = await this.readAll();
      const existing = events.find((entry) => entry.id === event.id);
      if (existing) return existing;
      await this.writeAll([...events, event].slice(-5000));
      return event;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async listByIntentIds(intentIds: string[]) {
    await this.writeQueue;
    const wanted = new Set(intentIds.slice(0, 100));
    if (!wanted.size) return [];
    const events = await this.readAll();
    return events
      .filter((event) => wanted.has(event.intentId))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, 500);
  }

  private async readAll() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      return Array.isArray(parsed) ? (parsed as PersistedRentalExecutionEvent[]) : [];
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(events: PersistedRentalExecutionEvent[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(events, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

class SupabaseRentalExecutionEventsRepository implements RentalExecutionEventsRepository {
  readonly storageKind = "supabase";
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async record(event: PersistedRentalExecutionEvent) {
    const row = executionEventToRow(event);
    const { data, error } = await this.client.from("rental_execution_events").insert(row).select("*").maybeSingle();
    if (!error && data) return rowToExecutionEvent(data);
    if (error?.code !== "23505") throw new Error(`Supabase execution event write failed: ${error?.message || "unknown error"}`);

    const { data: existing, error: lookupError } = await this.client
      .from("rental_execution_events")
      .select("*")
      .eq("id", event.id)
      .single();
    if (lookupError) throw new Error(`Supabase execution event lookup failed: ${lookupError.message}`);
    return rowToExecutionEvent(existing);
  }

  async listByIntentIds(intentIds: string[]) {
    const ids = [...new Set(intentIds)].slice(0, 100);
    if (!ids.length) return [];
    const { data, error } = await this.client
      .from("rental_execution_events")
      .select("*")
      .in("intent_id", ids)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(`Supabase execution event read failed: ${error.message}`);
    return (data ?? []).map(rowToExecutionEvent);
  }
}

let repository: RentalExecutionEventsRepository | undefined;

export function getRentalExecutionEventsRepository() {
  repository ??= createRentalExecutionEventsRepository();
  return repository;
}

export function newExecutionEvent(input: NewExecutionEvent): PersistedRentalExecutionEvent {
  const identity = [input.intentId, input.eventKey, input.recordRef ?? ""].join(":");
  return {
    id: `execution_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`,
    intentId: input.intentId,
    rentalId: input.rentalId,
    itemId: input.itemId,
    step: input.step,
    actor: input.actor,
    tool: safeText(input.tool, 120),
    summary: redactSummary(input.summary),
    approvalRequired: input.approvalRequired,
    status: input.status,
    environment: input.environment ?? configuredEnvironment(),
    activityType: input.activityType ?? configuredActivityType(),
    paymentMode: input.paymentMode,
    recordRef: input.recordRef ? safeText(input.recordRef, 220) : undefined,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function initialIntentExecutionEvents(
  intent: Pick<
    PersistedRentalIntent,
    "id" | "rentalId" | "itemId" | "itemName" | "durationHours" | "rentAmount" | "depositAmount" | "currency"
  >,
  options: {
    sourceTool: string;
    approvalTool: string;
    approvalStatus: "waiting" | "completed";
    approvalPaymentMode: PaymentMode;
    approvalSummary?: string;
  }
): NewExecutionEvent[] {
  const identity = { intentId: intent.id, rentalId: intent.rentalId, itemId: intent.itemId };
  return [
    {
      ...identity,
      eventKey: "intent-received",
      step: "intent_received",
      actor: "renter",
      tool: options.sourceTool,
      summary: `Requested ${intent.itemName} for ${intent.durationHours} hours.`,
      approvalRequired: false,
      status: "completed",
      paymentMode: "simulated",
    },
    {
      ...identity,
      eventKey: "inventory-validated",
      step: "inventory_searched",
      actor: "gimi_agent",
      tool: "getRentableItem",
      summary: "Validated the selected item against current community inventory.",
      approvalRequired: false,
      status: "completed",
      paymentMode: "simulated",
    },
    {
      ...identity,
      eventKey: "offer-selected",
      step: "offer_selected",
      actor: "gimi_agent",
      tool: "rental quote",
      summary: `Selected ${intent.itemName}; server quote is ${intent.rentAmount} ${intent.currency} plus a refundable ${intent.depositAmount} ${intent.currency} cap.`,
      approvalRequired: false,
      status: "completed",
      paymentMode: "simulated",
    },
    {
      ...identity,
      eventKey: "terms-drafted",
      step: "terms_drafted",
      actor: "gimi_agent",
      tool: "deterministic pricing",
      summary: `Drafted ${intent.durationHours}-hour terms using stored rate, minimum fee, and buyout cap.`,
      approvalRequired: false,
      status: "completed",
      paymentMode: "simulated",
    },
    {
      ...identity,
      eventKey: "approval-requested",
      step: "approval_requested",
      actor: options.approvalStatus === "completed" ? "renter" : "gimi_agent",
      tool: options.approvalTool,
      summary:
        options.approvalSummary ?? "Waiting for the renter to approve funding. No funds move without this approval.",
      approvalRequired: true,
      status: options.approvalStatus,
      paymentMode: options.approvalPaymentMode,
      recordRef: options.approvalStatus === "completed" ? `intent:${intent.id}` : undefined,
    },
  ];
}

export async function recordExecutionEventsSafely(inputs: NewExecutionEvent[]) {
  try {
    const events = inputs.map(newExecutionEvent);
    const eventRepository = getRentalExecutionEventsRepository();
    for (const event of events) await eventRepository.record(event);
    return "recorded" as const;
  } catch (error) {
    console.error("Rental execution timeline write failed", error);
    return "failed" as const;
  }
}

export function buildFunnelSummary(events: PersistedRentalExecutionEvent[]) {
  const funnelSteps: ExecutionStep[] = [
    "intent_received",
    "offer_selected",
    "approval_requested",
    "rental_funded",
    "handoff_confirmed",
    "return_confirmed",
    "settlement_completed",
    "receipt_issued",
  ];
  const completed = events.filter((event) => event.status === "completed" || event.status === "recovered");
  const stageCounts = Object.fromEntries(
    funnelSteps.map((step) => [step, new Set(completed.filter((event) => event.step === step).map((event) => event.intentId)).size])
  );
  const commercialEvents = completed.filter(
    (event) => event.activityType === "partner_pilot" || event.activityType === "organic_user"
  );

  return {
    stageCounts,
    environmentCounts: countBy(completed, (event) => event.environment),
    activityCounts: countBy(completed, (event) => event.activityType),
    commercialIntentCount: new Set(commercialEvents.map((event) => event.intentId)).size,
    failedEventCount: events.filter((event) => event.status === "failed").length,
    statement:
      commercialEvents.length === 0
        ? "0 verified commercial rental intents. Demo and test activity is shown separately."
        : "Commercial counts include only partner_pilot and organic_user activity.",
  };
}

export function executionTimelineDisclosureAllowed(requestedMode: string | null) {
  if (requestedMode !== "seeded_demo") return false;
  const configured = process.env.GIMI_ACTIVITY_TYPE;
  if (configured === "seeded_demo") return true;
  if (configured) return false;
  return !process.env.VERCEL;
}

export function executionProvenanceReady() {
  if (!process.env.VERCEL && process.env.NODE_ENV !== "production") return true;
  return isActivityType(process.env.GIMI_ACTIVITY_TYPE);
}

function createRentalExecutionEventsRepository() {
  const config = supabaseConfig();
  if (!config) return new FileRentalExecutionEventsRepository();
  return new SupabaseRentalExecutionEventsRepository(
    createClient(config.url, config.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  );
}

function configuredEnvironment(): ExecutionEnvironment {
  const configured = process.env.GIMI_ENVIRONMENT;
  if (isExecutionEnvironment(configured)) return configured;
  if (process.env.VERCEL_ENV === "preview") return "preview";
  if (process.env.VERCEL_ENV === "production") return "devnet";
  return "local";
}

function configuredActivityType(): ActivityType {
  const configured = process.env.GIMI_ACTIVITY_TYPE;
  if (isActivityType(configured)) return configured;
  if (!executionProvenanceReady()) {
    throw new Error("GIMI_ACTIVITY_TYPE must be configured outside local development");
  }
  return "seeded_demo";
}

function redactSummary(value: string) {
  const redacted = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/(?:sk|pk)_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted_key]")
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, "[redacted_private_key]");
  return safeText(redacted, 500);
}

function safeText(value: string, limit: number) {
  return String(value).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, limit);
}

function countBy<T>(values: T[], key: (value: T) => string) {
  return values.reduce<Record<string, number>>((counts, value) => {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
}

function isExecutionEnvironment(value: unknown): value is ExecutionEnvironment {
  return ["local", "preview", "devnet", "testnet", "mainnet"].includes(String(value));
}

function isActivityType(value: unknown): value is ActivityType {
  return ["seeded_demo", "internal_test", "partner_pilot", "organic_user"].includes(String(value));
}

function defaultExecutionEventsFilePath() {
  if (process.env.RENTAL_EXECUTION_EVENTS_FILE_PATH) return process.env.RENTAL_EXECUTION_EVENTS_FILE_PATH;
  if (process.env.VERCEL) return path.join("/tmp", "gimi-rental-execution-events.json");
  return path.join(process.cwd(), ".rentproof", "rental-execution-events.json");
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  return url && serviceRoleKey ? { url, serviceRoleKey } : undefined;
}

function executionEventToRow(event: PersistedRentalExecutionEvent): ExecutionEventRow {
  return {
    id: event.id,
    intent_id: event.intentId,
    rental_id: event.rentalId ?? null,
    item_id: event.itemId,
    step: event.step,
    actor: event.actor,
    tool: event.tool,
    summary: event.summary,
    approval_required: event.approvalRequired,
    status: event.status,
    environment: event.environment,
    activity_type: event.activityType,
    payment_mode: event.paymentMode,
    record_ref: event.recordRef ?? null,
    created_at: event.createdAt,
  };
}

function rowToExecutionEvent(row: ExecutionEventRow): PersistedRentalExecutionEvent {
  return {
    id: row.id,
    intentId: row.intent_id,
    rentalId: row.rental_id ?? undefined,
    itemId: row.item_id,
    step: row.step,
    actor: row.actor,
    tool: row.tool,
    summary: row.summary,
    approvalRequired: row.approval_required,
    status: row.status,
    environment: row.environment,
    activityType: row.activity_type,
    paymentMode: row.payment_mode,
    recordRef: row.record_ref ?? undefined,
    createdAt: row.created_at,
  };
}
