import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  findTaskGrant,
  type ScheduledTaskInsert,
  ScheduledTaskStore,
} from "../../src/schedules/store.js";
import { truncateTables } from "../helpers/db.js";
import { legacyDbFor } from "../helpers/identity.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

let pgc: TestContainer;
let raw: ReturnType<typeof createDb>;
/** The `capybara` view the store queries through. */
let db: KernelSchemaDb;
const store = new ScheduledTaskStore();
let seed: Awaited<ReturnType<typeof seedConversation>>;

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = legacyDbFor(raw);
}, 120_000);
afterAll(async () => {
  await raw?.destroy();
  await pgc?.stop();
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  seed = await seedConversation(raw);
});

const NOW = new Date("2026-11-11T09:00:00.000Z");
const TICK = new Date("2026-11-11T09:00:00.000Z");

const task = (over: Partial<ScheduledTaskInsert> = {}): ScheduledTaskInsert => ({
  id: randomUUID(),
  orgId: seed.orgId,
  accountId: seed.accountId,
  agentId: seed.agentId,
  name: "Daily digest",
  prompt: "Summarize yesterday's issues.",
  trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "Asia/Shanghai" },
  mode: "new",
  conversationId: null,
  chat: null,
  model: null,
  effort: null,
  deviceId: null,
  status: "active",
  nextRunAt: new Date(NOW.getTime() - 60_000),
  jitterSeconds: 17,
  expiresAt: null,
  ...over,
});

const run = (taskId: string, over: { trial?: boolean; scheduledFor?: Date } = {}) => ({
  id: randomUUID(),
  taskId,
  orgId: seed.orgId,
  scheduledFor: over.scheduledFor ?? TICK,
  trial: over.trial ?? false,
});

describe("ScheduledTaskStore", () => {
  it("round-trips a task and lists it for its creator and its org", async () => {
    const t = task({
      mode: "chat",
      chat: { connectionId: "c1", chatId: "oc_1", chatType: "group" },
    });
    const inserted = await store.insertTask(db, t);
    expect(inserted).toMatchObject({
      id: t.id,
      trigger: t.trigger,
      chat: t.chat,
      status: "active",
      pauseReason: null,
      pausedBy: null,
      consecutiveFailures: 0,
      jitterSeconds: 17,
    });
    expect(await store.getTask(db, seed.orgId, t.id)).toEqual(inserted);
    expect(await store.getTask(db, randomUUID(), t.id)).toBeNull();
    expect((await store.listForAccount(db, seed.orgId, seed.accountId)).map((x) => x.id)).toEqual([
      t.id,
    ]);
    expect((await store.listForOrg(db, seed.orgId)).map((x) => x.id)).toEqual([t.id]);
  });

  it("updateTask patches the given fields; softDelete hides the task everywhere", async () => {
    const t = await store.insertTask(db, task());
    const paused = await store.updateTask(db, t.id, {
      status: "paused",
      pauseReason: "creator",
      pausedBy: seed.accountId,
      nextRunAt: null,
    });
    expect(paused).toMatchObject({ status: "paused", pauseReason: "creator", nextRunAt: null });
    expect(await store.countActive(db, seed.orgId)).toBe(1);
    expect(await store.countActive(db, seed.orgId, seed.accountId)).toBe(1);
    expect(await store.countActive(db, seed.orgId, randomUUID())).toBe(0);
    await store.softDelete(db, t.id);
    expect(await store.getTask(db, seed.orgId, t.id)).toBeNull();
    expect(await store.listForOrg(db, seed.orgId)).toEqual([]);
    expect(await store.countActive(db, seed.orgId)).toBe(0);
  });

  it("insertRun twice for the same tick returns null the second time", async () => {
    const t = await store.insertTask(db, task());
    const first = await store.insertRun(db, run(t.id));
    expect(first).toMatchObject({
      taskId: t.id,
      status: "pending",
      trial: false,
      missingGrants: [],
    });
    expect(await store.insertRun(db, run(t.id))).toBeNull();
    expect(await store.listRuns(db, t.id, 10)).toHaveLength(1);
  });

  it("trial runs do not collide with a scheduled tick", async () => {
    const t = await store.insertTask(db, task());
    expect(await store.insertRun(db, run(t.id))).not.toBeNull();
    expect(await store.insertRun(db, run(t.id, { trial: true }))).not.toBeNull();
    expect(await store.insertRun(db, run(t.id, { trial: true }))).not.toBeNull();
    expect(await store.listRuns(db, t.id, 10)).toHaveLength(3);
  });

  it("lockDue returns due active tasks only", async () => {
    const due = await store.insertTask(db, task());
    await store.insertTask(db, task({ nextRunAt: new Date(NOW.getTime() + 60_000) }));
    await store.insertTask(db, task({ status: "paused", nextRunAt: null }));
    const deleted = await store.insertTask(db, task());
    await store.softDelete(db, deleted.id);
    expect((await store.lockDue(db, NOW, 10)).map((x) => x.id)).toEqual([due.id]);
  });

  it("lockDue skips rows locked by another transaction", async () => {
    const a = await store.insertTask(db, task({ nextRunAt: new Date(NOW.getTime() - 120_000) }));
    const b = await store.insertTask(db, task());
    await db.transaction().execute(async (first) => {
      const held = await store.lockDue(first, NOW, 1);
      expect(held.map((x) => x.id)).toEqual([a.id]);
      const other = await db
        .transaction()
        .execute(async (second) => store.lockDue(second, NOW, 10));
      expect(other.map((x) => x.id)).toEqual([b.id]);
    });
  });

  it("updateRun, latestNonTerminalRun and countFiredSince", async () => {
    const t = await store.insertTask(db, task());
    const r1 = await store.insertRun(
      db,
      run(t.id, { scheduledFor: new Date("2026-11-10T09:00Z") }),
    );
    const r2 = await store.insertRun(db, run(t.id));
    if (!r1 || !r2) throw new Error("insert failed");
    await store.updateRun(db, r1.id, {
      status: "completed",
      firedAt: new Date(NOW.getTime() - 7200_000),
    });
    expect((await store.latestNonTerminalRun(db, t.id))?.id).toBe(r2.id);
    const updated = await store.updateRun(db, r2.id, {
      status: "failed",
      firedAt: NOW,
      error: "boom",
      missingGrants: ["Bash"],
    });
    expect(updated).toMatchObject({ status: "failed", error: "boom", missingGrants: ["Bash"] });
    expect(await store.latestNonTerminalRun(db, t.id)).toBeNull();
    expect(await store.countFiredSince(db, seed.orgId, new Date(NOW.getTime() - 3600_000))).toBe(1);
    expect((await store.listRuns(db, t.id, 1)).map((x) => x.id)).toEqual([r2.id]);
  });

  it("findTaskGrant ignores a different spec hash", async () => {
    const t = await store.insertTask(db, task());
    await store.addGrant(db, t.id, { toolKey: "Bash", specHash: "h1", connectorId: null });
    await store.addGrant(db, t.id, { toolKey: "search", specHash: "h2", connectorId: "conn-1" });
    expect(await findTaskGrant(db, t.id, "Bash", "h1", null)).toBe(true);
    expect(await findTaskGrant(db, t.id, "Bash", "h-other", null)).toBe(false);
    expect(await findTaskGrant(db, t.id, "search", "h2", "conn-1")).toBe(true);
    expect(await findTaskGrant(db, t.id, "search", "h2", "conn-2")).toBe(false);
    expect(await findTaskGrant(db, t.id, "search", "h2", null)).toBe(false);
    // re-adding replaces the hash
    await store.addGrant(db, t.id, { toolKey: "Bash", specHash: "h3", connectorId: null });
    expect(await findTaskGrant(db, t.id, "Bash", "h1", null)).toBe(false);
    expect(await store.listGrants(db, t.id)).toHaveLength(2);
    await store.removeGrant(db, t.id, "Bash");
    expect(await store.listGrants(db, t.id)).toEqual([
      { toolKey: "search", specHash: "h2", connectorId: "conn-1" },
    ]);
  });
});
