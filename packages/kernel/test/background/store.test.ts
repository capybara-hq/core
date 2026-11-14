import { fileURLToPath } from "node:url";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BackgroundLaunchLock } from "../../src/background/launch-lock.js";
import { type BackgroundTaskInsert, BackgroundTaskStore } from "../../src/background/store.js";
import { ConversationEventSchema } from "../../src/conversations/events.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { XactLock } from "../../src/infra/database/xact-lock.js";
import {
  effectiveWakeOnBackgroundTask,
  parseOrgSettings,
} from "../../src/orgs/settings.service.js";
import { truncateTables } from "../helpers/db.js";
import { handlesFor, orgSettingsFor } from "../helpers/identity.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

let pgc: TestContainer;
let raw: ReturnType<typeof createDb>;
let store: BackgroundTaskStore;
let seed: Awaited<ReturnType<typeof seedConversation>>;

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  const h = handlesFor(raw);
  store = new BackgroundTaskStore(
    h.db,
    h.txHost,
    new BackgroundLaunchLock(new XactLock(h.db, h.txHost), h.txHost),
  );
});
afterAll(async () => {
  await raw?.destroy();
  await pgc?.stop();
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  seed = await seedConversation(raw);
});

const T0 = new Date("2026-11-05T10:00:00.000Z");
/** The device the tasks run in (the column has no foreign key). */
const ENV = "env-1";

const task = (id: string, over: Partial<BackgroundTaskInsert> = {}): BackgroundTaskInsert => ({
  id,
  orgId: seed.orgId,
  conversationId: seed.conversationId,
  sandboxConversationId: seed.conversationId,
  deviceId: ENV,
  runId: "run-1",
  callId: "call-1",
  triggerAccountId: seed.accountId,
  description: "Run the test suite",
  command: "pnpm test",
  sid: "4242",
  outputPath: `.capybara/tasks/${id}.out`,
  startedAt: T0,
  deadlineAt: new Date(T0.getTime() + 3600_000),
  sandboxCreatedAt: new Date("2026-11-05T09:00:00.000Z"),
  ...over,
});

/** `finish` is a mandatory-transaction method: call it the way the finisher does, in one. */
const finish = (id: string, to: Parameters<BackgroundTaskStore["finish"]>[1]) =>
  handlesFor(raw).txHost.run(() => store.finish(id, to));

async function childConversation(id: string): Promise<string> {
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${id}, ${seed.orgId}, ${seed.agentId}, ${seed.accountId})`.execute(raw);
  return id;
}

describe("BackgroundTaskStore", () => {
  it("insert then get round-trips every field", async () => {
    const t = task("bt_aaaaaa");
    await store.insert(t);
    expect(await store.get("bt_aaaaaa")).toEqual({
      ...t,
      status: "running",
      lostReason: null,
      exitCode: null,
      finishedAt: null,
      killPending: false,
      readOffset: 0,
      stoppingAt: null,
    });
    expect(await store.get("bt_missing")).toBeUndefined();
  });

  it("countRunning and runningIn count only running rows of that sandbox conversation", async () => {
    const other = await childConversation("conv-other");
    await store.insert(task("bt_000001"));
    await store.insert(task("bt_000002"));
    await store.insert(task("bt_000003"));
    await store.insert(task("bt_000004", { conversationId: other, sandboxConversationId: other }));
    await finish("bt_000003", { status: "completed", exitCode: 0 });
    expect(await store.countRunning(seed.conversationId)).toBe(2);
    expect(await store.countRunning(other)).toBe(1);
    expect((await store.runningIn(seed.conversationId)).map((r) => r.id)).toEqual([
      "bt_000001",
      "bt_000002",
    ]);
    expect(await store.countRunning("nobody")).toBe(0);
  });

  it("finish moves running to a final status once; the second call returns false", async () => {
    await store.insert(task("bt_000001"));
    expect(await finish("bt_000001", { status: "failed", exitCode: 2 })).toBe(true);
    expect(await finish("bt_000001", { status: "completed", exitCode: 0 })).toBe(false);
    const row = await store.get("bt_000001");
    expect(row).toMatchObject({ status: "failed", exitCode: 2, lostReason: null });
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it("finish records the lost reason and the pending kill; pendingKills and clearKill follow", async () => {
    await store.insert(task("bt_000001"));
    await store.insert(task("bt_000002"));
    await finish("bt_000001", { status: "lost", lostReason: "process_gone", killPending: true });
    await finish("bt_000002", { status: "stopped" });
    expect(await store.get("bt_000001")).toMatchObject({
      status: "lost",
      lostReason: "process_gone",
      killPending: true,
    });
    expect((await store.pendingKills(ENV)).map((r) => r.id)).toEqual(["bt_000001"]);
    // by device: another device's pending kills are its own
    expect(await store.pendingKills("env-2")).toEqual([]);
    await store.clearKill(["bt_000001"]);
    expect(await store.pendingKills(ENV)).toEqual([]);
  });

  it("finish outside a transaction throws (mandatory propagation)", async () => {
    await store.insert(task("bt_000001"));
    await expect(store.finish("bt_000001", { status: "completed" })).rejects.toThrow(/mandatory/);
  });

  it("advanceOffset only moves forward", async () => {
    await store.insert(task("bt_000001"));
    await store.advanceOffset("bt_000001", 100);
    await store.advanceOffset("bt_000001", 40);
    expect((await store.get("bt_000001"))?.readOffset).toBe(100);
  });

  it("listFor returns the rows of the given conversations, newest first", async () => {
    const child = await childConversation("conv-child");
    await store.insert(task("bt_000001", { startedAt: new Date(T0.getTime() + 1000) }));
    await store.insert(
      task("bt_000002", {
        conversationId: child,
        startedAt: new Date(T0.getTime() + 3000),
      }),
    );
    await store.insert(task("bt_000003", { startedAt: new Date(T0.getTime() + 2000) }));
    const rows = await store.listFor([seed.conversationId, child]);
    expect(rows.map((r) => r.id)).toEqual(["bt_000002", "bt_000003", "bt_000001"]);
    expect((await store.listFor([child])).map((r) => r.id)).toEqual(["bt_000002"]);
    expect(await store.listFor([])).toEqual([]);
  });

  it("deleting the conversation deletes its rows", async () => {
    const child = await childConversation("conv-child");
    await store.insert(task("bt_000001"));
    await store.insert(task("bt_000002", { conversationId: child }));
    await sql`DELETE FROM capybara.conversations WHERE id = ${child}`.execute(raw);
    expect(await store.get("bt_000002")).toBeUndefined();
    expect(await store.get("bt_000001")).toBeDefined();
    await sql`DELETE FROM capybara.conversations WHERE id = ${seed.conversationId}`.execute(raw);
    expect(await store.get("bt_000001")).toBeUndefined();
  });

  it("pruneFinished deletes old finished rows only, never a running one", async () => {
    await store.insert(task("bt_000001"));
    await store.insert(task("bt_000002"));
    await store.insert(task("bt_000003"));
    await finish("bt_000001", { status: "completed", exitCode: 0 });
    await finish("bt_000002", { status: "timed_out" });
    await sql`UPDATE capybara.background_tasks SET finished_at = now() - interval '40 days'
      WHERE id = 'bt_000001'`.execute(raw);
    // bt_000003 is running with an old start: it must survive
    await sql`UPDATE capybara.background_tasks SET started_at = now() - interval '90 days'
      WHERE id = 'bt_000003'`.execute(raw);
    const n = await store.pruneFinished(new Date(Date.now() - 30 * 86_400_000));
    expect(n).toBe(1);
    expect(await store.get("bt_000001")).toBeUndefined();
    expect(await store.get("bt_000002")).toBeDefined();
    expect(await store.get("bt_000003")).toBeDefined();
  });
});

describe("background_task_finished event and the org override", () => {
  const payload = {
    taskId: "bt_k3f9a2",
    description: "Run the test suite",
    status: "completed",
    exitCode: 1,
    elapsedMs: 252_000,
    lastLines: "x".repeat(4000),
    outputPath: ".capybara/tasks/bt_k3f9a2.out",
    reported: false,
  };
  it("the events schema accepts the payload and rejects lastLines over 4000 characters", () => {
    const ok = ConversationEventSchema.safeParse({ type: "background_task_finished", payload });
    expect(ok.success).toBe(true);
    const lost = ConversationEventSchema.safeParse({
      type: "background_task_finished",
      payload: { ...payload, status: "lost", exitCode: null, lostReason: "process_gone" },
    });
    expect(lost.success).toBe(true);
    const long = ConversationEventSchema.safeParse({
      type: "background_task_finished",
      payload: { ...payload, lastLines: "x".repeat(4001) },
    });
    expect(long.success).toBe(false);
  });

  it("the org setting overrides the deployment value; absent follows it", () => {
    expect(parseOrgSettings({}).wakeOnBackgroundTask).toBeUndefined();
    expect(parseOrgSettings({ wakeOnBackgroundTask: false }).wakeOnBackgroundTask).toBe(false);
    expect(parseOrgSettings({ wakeOnBackgroundTask: "x" }).wakeOnBackgroundTask).toBeUndefined();
    expect(effectiveWakeOnBackgroundTask(true, undefined)).toBe(true);
    expect(effectiveWakeOnBackgroundTask(true, false)).toBe(false);
    expect(effectiveWakeOnBackgroundTask(false, true)).toBe(true);
  });

  it("the org override can be set and cleared with null (back to the deployment value)", async () => {
    await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
      VALUES (${seed.orgId}, ${seed.accountId}, 'owner')`.execute(raw);
    const svc = orgSettingsFor(raw, () => ({ sandbox: { limits: {} } }));
    const deployment = true;
    const effective = async () =>
      effectiveWakeOnBackgroundTask(deployment, (await svc.get(seed.orgId)).wakeOnBackgroundTask);
    expect(await effective()).toBe(true);
    await svc.update(seed.orgId, { wakeOnBackgroundTask: false }, seed.accountId);
    expect((await svc.get(seed.orgId)).wakeOnBackgroundTask).toBe(false);
    expect(await effective()).toBe(false);
    await svc.update(seed.orgId, { wakeOnBackgroundTask: null }, seed.accountId);
    expect((await svc.get(seed.orgId)).wakeOnBackgroundTask).toBeUndefined();
    expect(await effective()).toBe(true);
  });
});
