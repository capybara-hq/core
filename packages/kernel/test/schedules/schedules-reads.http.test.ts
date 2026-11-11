import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The scheduled-task reads the web needs (spec §8, §10; Task 12 fix round): chat targets, the
 * grantable tools, stale grants, each task's last run, the tasks posting into a conversation and
 * the conversation's `scheduledTaskId`.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const CHAN_MINI = fixture("chan-mini");
const CHAN_PLAIN = fixture("chan-plain");

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let im: FakeChannelServer;
let owner: Req;
let alice: Req;
let aliceId: string;
let bobId: string;
let orgId: string;
let agentId: string;
let miniId: string;
let plainId: string;

const base = () => `/api/v1/orgs/${orgId}/schedules`;

async function connection(plugin: string, appId: string): Promise<string> {
  let res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled: true },
  });
  expect(res.statusCode, res.body).toBe(200);
  res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin,
      name: `${plugin} bot`,
      agentId,
      config: { platformUrl: im.url, appId, appSecret: "app-secret-1234567" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { channel: { id: string } }).channel.id;
}

/** A `channel_threads` row of `accountId` in a chat (its conversation made through the API). */
async function thread(
  connectionId: string,
  chatId: string,
  key: string,
  accountId: string | null,
  archived = false,
): Promise<string> {
  const conversationId = await createConv(owner, orgId, agentId);
  await db
    .insertInto("channel_threads")
    .values({
      id: randomUUID(),
      connection_id: connectionId,
      chat_id: chatId,
      thread_key: key,
      account_id: accountId,
      conversation_id: conversationId,
      created_at: new Date(),
      archived_at: archived ? new Date() : null,
    })
    .execute();
  return conversationId;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, CHAN_MINI, CHAN_PLAIN],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const accounts = accountsFor(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  aliceId = (await accounts.createLocal({ login: "alice", password: PW, displayName: "A" })).id;
  bobId = (await accounts.createLocal({ login: "bob", password: PW, displayName: "B" })).id;
  owner = await session(k, "owner");
  const org = await owner({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  orgId = (org.json() as { org: { id: string } }).org.id;
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  await testMembers(db).add(orgId, bobId, "member", ownerId);
  alice = await session(k, "alice");
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("AskUserQuestion", "ScheduleCreate", "CurrentTime"),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
  miniId = await connection("chan-mini", "cli_1");
  plainId = await connection("chan-plain", "cli_plain");
}, 180_000);

afterAll(async () => {
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Target = {
  connectionId: string;
  connectionName: string;
  plugin: string;
  agentId: string;
  chatId: string;
  chatType: "dm" | "group";
  label: string;
};

describe("schedule reads for the web", () => {
  it("chat targets: my DMs (archived too) and, on a channel with threads, my groups", async () => {
    await thread(miniId, "dm-alice", "dm:u-alice", aliceId, true);
    await thread(miniId, "g-1", "m-root-1", aliceId);
    await thread(plainId, "dm-alice-plain", "dm:u-alice", aliceId);
    // a group on a channel without threads, and someone else's DM, are not offered
    await thread(plainId, "g-plain", "m-root-2", aliceId);
    await thread(miniId, "dm-bob", "dm:u-bob", bobId);
    const res = await alice({ method: "GET", url: `${base()}/chat-targets` });
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: Target[] }).items;
    const key = (t: Target) => `${t.connectionId}/${t.chatId}/${t.chatType}`;
    expect(items.map(key).sort()).toEqual(
      [`${miniId}/dm-alice/dm`, `${miniId}/g-1/group`, `${plainId}/dm-alice-plain/dm`].sort(),
    );
    const dm = items.find((t) => t.chatId === "dm-alice") as Target;
    expect(dm).toMatchObject({
      connectionName: "chan-mini bot",
      plugin: "chan-mini",
      agentId,
    });
    expect(dm.label.length).toBeGreaterThan(0);
  });

  it("grantable tools: every tool of the agent, each grantable or why not", async () => {
    let res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { scheduledTasks: { forbiddenTools: ["CurrentTime"] } },
    });
    expect(res.statusCode, res.body).toBe(200);
    res = await alice({ method: "GET", url: `${base()}/grantable-tools?agentId=${agentId}` });
    expect(res.statusCode, res.body).toBe(200);
    const items = (
      res.json() as { items: { key: string; grantable: boolean; reason: string | null }[] }
    ).items;
    const of = (key: string) => items.find((t) => t.key === key);
    expect(of("AskUserQuestion")).toMatchObject({ grantable: true, reason: null });
    expect(of("ScheduleCreate")).toMatchObject({ grantable: false, reason: "fixed_ask" });
    expect(of("CurrentTime")).toMatchObject({ grantable: false, reason: "forbidden" });
    res = await alice({ method: "GET", url: `${base()}/grantable-tools?agentId=nope` });
    expect(res.statusCode).toBe(404);
  });

  it("grants say when they are out of date; the list carries each task's last settled run", async () => {
    let res = await alice({
      method: "POST",
      url: base(),
      payload: {
        agentId,
        name: "Digest",
        prompt: "Go.",
        trigger: { kind: "cron", expr: "0 9 * * *" },
        mode: "new",
        grants: [{ toolKey: "AskUserQuestion" }],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const taskId = (res.json() as { task: { id: string } }).task.id;
    res = await alice({ method: "GET", url: `${base()}/${taskId}/grants` });
    expect((res.json() as { items: { stale: boolean }[] }).items).toEqual([
      expect.objectContaining({ toolKey: "AskUserQuestion", stale: false }),
    ]);
    await db
      .updateTable("scheduled_task_grants")
      .set({ spec_hash: "0000000000000000" })
      .where("task_id", "=", taskId)
      .execute();
    res = await alice({ method: "GET", url: `${base()}/${taskId}/grants` });
    expect((res.json() as { items: { stale: boolean }[] }).items[0]?.stale).toBe(true);

    const runAt = (h: number) => new Date(Date.UTC(2026, 10, 10, h));
    const insertRun = (h: number, over: Record<string, unknown>) =>
      db
        .insertInto("scheduled_task_runs")
        .values({
          id: randomUUID(),
          task_id: taskId,
          org_id: orgId,
          scheduled_for: runAt(h),
          fired_at: runAt(h),
          status: "completed",
          ...over,
        })
        .execute();
    res = await alice({ method: "GET", url: base() });
    expect((res.json() as { items: { lastRun: unknown }[] }).items[0]?.lastRun).toBeNull();
    await insertRun(1, { status: "failed", error: "boom" });
    await insertRun(2, { status: "skipped", skip_reason: "overlap", fired_at: null });
    // trial and unsettled runs don't count
    await insertRun(3, { status: "completed", trial: true });
    await insertRun(4, { status: "running" });
    res = await alice({ method: "GET", url: base() });
    expect((res.json() as { items: { lastRun: unknown }[] }).items[0]?.lastRun).toEqual({
      status: "skipped",
      skipReason: "overlap",
      at: runAt(2).toISOString(),
    });
  });

  it("the tasks posting into a conversation; a conversation a task started names it", async () => {
    const conv = await createConv(alice, orgId, agentId);
    let res = await alice({
      method: "POST",
      url: base(),
      payload: {
        agentId,
        name: "Into the conversation",
        prompt: "Go.",
        trigger: { kind: "cron", expr: "0 9 * * *" },
        mode: "conversation",
        conversationId: conv,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const convTask = (res.json() as { task: { id: string } }).task.id;
    const chatConv = await thread(miniId, "dm-alice-2", "dm:u-alice-2", aliceId);
    res = await alice({
      method: "POST",
      url: base(),
      payload: {
        agentId,
        name: "Into the chat",
        prompt: "Go.",
        trigger: { kind: "cron", expr: "0 9 * * *" },
        mode: "chat",
        chat: { connectionId: miniId, chatId: "dm-alice-2", chatType: "dm" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const chatTask = (res.json() as { task: { id: string } }).task.id;

    const ids = async (c: string) =>
      (
        (await alice({ method: "GET", url: `${base()}?conversationId=${c}` })).json() as {
          items: { id: string }[];
        }
      ).items.map((t) => t.id);
    expect(await ids(conv)).toEqual([convTask]);
    expect(await ids(chatConv)).toEqual([chatTask]);

    res = await alice({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations/${conv}` });
    expect(
      (res.json() as { conversation: { scheduledTaskId: string | null } }).conversation
        .scheduledTaskId,
    ).toBeNull();
    await db
      .updateTable("conversations")
      .set({ scheduled_task_id: convTask })
      .where("id", "=", conv)
      .execute();
    res = await alice({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations/${conv}` });
    expect(
      (res.json() as { conversation: { scheduledTaskId: string | null } }).conversation
        .scheduledTaskId,
    ).toBe(convTask);
  });

  it("the new reads are read operations of the Platform tool", () => {
    const ops = k.app.get(PlatformOperations);
    for (const id of ["schedules.chat-targets", "schedules.grantable-tools"]) {
      expect(ops.get(id), id).toMatchObject({ confirm: "read" });
    }
  });
});
