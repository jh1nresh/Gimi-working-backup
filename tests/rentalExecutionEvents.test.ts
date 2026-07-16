import { mkdtemp, readFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFunnelSummary,
  executionTimelineDisclosureAllowed,
  FileRentalExecutionEventsRepository,
  newExecutionEvent,
} from "@/lib/rentalExecutionEvents";

function event(overrides: Partial<Parameters<typeof newExecutionEvent>[0]> = {}) {
  return newExecutionEvent({
    eventKey: "intent",
    intentId: "intent_1",
    itemId: "power_bank_18",
    step: "intent_received",
    actor: "renter",
    tool: "test tool",
    summary: "Requested a power bank",
    approvalRequired: false,
    status: "completed",
    environment: "local",
    activityType: "seeded_demo",
    paymentMode: "simulated",
    createdAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  });
}

describe("rental execution events", () => {
  it("records a deterministic event only once", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gimi-events-"));
    const filePath = path.join(directory, "events.json");
    const repository = new FileRentalExecutionEventsRepository(filePath);
    const first = event();
    await repository.record(first);
    await repository.record(first);

    const stored = JSON.parse(await readFile(filePath, "utf8"));
    expect(stored).toHaveLength(1);
    await expect(repository.listByIntentIds(["intent_1"])).resolves.toEqual([first]);
  });

  it("preserves concurrent event writes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gimi-events-"));
    const repository = new FileRentalExecutionEventsRepository(path.join(directory, "events.json"));
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.record(event({ eventKey: `event-${index}`, step: index % 2 ? "offer_selected" : "intent_received" }))
      )
    );
    await expect(repository.listByIntentIds(["intent_1"])).resolves.toHaveLength(20);
  });

  it("redacts access tokens and payment keys from summaries", () => {
    const created = event({
      summary: "Authorization Bearer abc.def.ghi used sk_live_not_a_real_key",
    });
    expect(created.summary).toBe("Authorization Bearer [redacted] used [redacted_key]");
  });

  it("redacts a private key before truncating long summaries", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const created = event({ summary: `provider response ${privateKeyPem} complete` });
    expect(created.summary).toContain("[redacted_private_key]");
    expect(created.summary).not.toContain("BEGIN PRIVATE KEY");
    expect(created.summary).not.toContain(privateKeyPem);
  });

  it("only discloses timelines for explicitly configured demo activity", () => {
    const original = process.env.GIMI_ACTIVITY_TYPE;
    const originalVercel = process.env.VERCEL;
    process.env.GIMI_ACTIVITY_TYPE = "seeded_demo";
    expect(executionTimelineDisclosureAllowed("seeded_demo")).toBe(true);
    expect(executionTimelineDisclosureAllowed(null)).toBe(false);
    process.env.GIMI_ACTIVITY_TYPE = "organic_user";
    expect(executionTimelineDisclosureAllowed("seeded_demo")).toBe(false);
    delete process.env.GIMI_ACTIVITY_TYPE;
    process.env.VERCEL = "1";
    expect(executionTimelineDisclosureAllowed("seeded_demo")).toBe(false);
    if (original === undefined) delete process.env.GIMI_ACTIVITY_TYPE;
    else process.env.GIMI_ACTIVITY_TYPE = original;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });

  it("keeps demo activity separate from commercial funnel counts", () => {
    const events = [
      event(),
      event({ eventKey: "funded-demo", step: "rental_funded" }),
      event({
        eventKey: "funded-pilot",
        intentId: "intent_2",
        step: "rental_funded",
        activityType: "partner_pilot",
        paymentMode: "provider_authorized",
      }),
    ];
    const summary = buildFunnelSummary(events);
    expect(summary.stageCounts.rental_funded).toBe(2);
    expect(summary.commercialIntentCount).toBe(1);
    expect(summary.activityCounts.seeded_demo).toBe(2);
    expect(summary.statement).toContain("partner_pilot");
  });

  it("requires explicit activity provenance in deployed environments", () => {
    const originalActivity = process.env.GIMI_ACTIVITY_TYPE;
    const originalVercel = process.env.VERCEL;
    delete process.env.GIMI_ACTIVITY_TYPE;
    process.env.VERCEL = "1";
    expect(() => newExecutionEvent({
      eventKey: "deployed-event",
      intentId: "intent_1",
      itemId: "power_bank_18",
      step: "intent_received",
      actor: "renter",
      tool: "test",
      summary: "test",
      approvalRequired: false,
      status: "completed",
      paymentMode: "simulated",
    })).toThrow("GIMI_ACTIVITY_TYPE");
    if (originalActivity === undefined) delete process.env.GIMI_ACTIVITY_TYPE;
    else process.env.GIMI_ACTIVITY_TYPE = originalActivity;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });
});
