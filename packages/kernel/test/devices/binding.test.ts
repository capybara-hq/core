import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackgroundTaskPollJob } from "../../src/background/poll.job.js";
import { AnonymousGuests } from "../../src/channels/threads.js";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Conversations bound to devices (spec 2026-11-07-environments-design §4.1 items 1-3, §4.2
 * items 8, 9, 12): bound at create (or on the first sandbox call when unbound), sub-agents in the
 * root's device, sessions of one device sharing its files, and only the owner's
 * devices usable. One kernel (api + worker), model-fake and the fake sandbox.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let ownerId: string;
let owner: Req;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-device-bind-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the sandbox.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("Bash", "Read", "Write", "Agent"),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

const conversations = () => `/api/v1/orgs/${orgId}/conversations`;

/** A new member of the org with a session. */
async function member(): Promise<{ id: string; req: Req }> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  return { id, req: await session(k, login) };
}

/** A conversation of `req` with the coder agent (optionally in `deviceId`); its view. */
async function newConversation(
  req: Req,
  deviceId?: string,
): Promise<{ id: string; deviceId: string | null }> {
  const res = await req({
    method: "POST",
    url: conversations(),
    payload: { agentId, ...(deviceId !== undefined && { deviceId }) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { conversation: { id: string; deviceId: string | null } }).conversation;
}

async function newDevice(req: Req, name: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/devices`,
    payload: { name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { device: { id: string } }).device.id;
}

async function boundTo(convId: string): Promise<string | null> {
  const r = await db
    .selectFrom("conversations")
    .select("device_id")
    .where("id", "=", convId)
    .executeTakeFirstOrThrow();
  return r.device_id;
}

async function defaultOf(accountId: string): Promise<string | undefined> {
  const r = await db
    .selectFrom("devices")
    .select("id")
    .where("org_id", "=", orgId)
    .where("owner_account_id", "=", accountId)
    .where("is_default", "=", true)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return r?.id;
}

type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>;

/** Has the model call `key` with `input` (the conversation's `n`th run); returns its result. */
async function call(
  req: Req,
  convId: string,
  key: string,
  input: unknown,
  n: number,
): Promise<ToolResult["payload"]> {
  await postMessage(req, orgId, convId, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, convId, n, 30_000);
  const results = (await eventsOf(db, convId)).filter(
    (e): e is ToolResult => e.type === "tool_result",
  );
  const last = results.at(-1);
  if (!last) throw new Error("no tool result");
  return last.payload;
}

const text = (p: ToolResult["payload"]): string =>
  typeof p.content === "string" ? p.content : JSON.stringify(p.content);

// Each test drives one to three agent runs end to end (queue, model, sandbox) and waits for them
// with 30 s conditions; the 5 s default test timeout cut those waits short on a loaded machine.
describe("conversations bound to devices", { timeout: 60_000 }, () => {
  it("a new conversation is bound to the owner's default device", async () => {
    const m = await member();
    const conv = await newConversation(m.req);
    expect(conv.deviceId).not.toBeNull();
    expect(conv.deviceId).toBe(await defaultOf(m.id));
    // a chosen device of the person's own
    const mine = await newDevice(m.req, "Repo");
    expect((await newConversation(m.req, mine)).deviceId).toBe(mine);
  });

  it("unbound conversation binds the owner's default on first sandbox call", async () => {
    const m = await member();
    const conv = await newConversation(m.req);
    // as if created before devices existed
    await db
      .updateTable("conversations")
      .set({ device_id: null })
      .where("id", "=", conv.id)
      .execute();
    const r = await call(
      m.req,
      conv.id,
      "Bash",
      { description: "Write", command: "echo hi > /workspace/u.txt" },
      1,
    );
    expect(r.isError, text(r)).toBe(false);
    expect(await boundTo(conv.id)).toBe(await defaultOf(m.id));
  });

  it("two conversations share one device's files", async () => {
    const m = await member();
    const env = await newDevice(m.req, "Shared");
    const a = await newConversation(m.req, env);
    const b = await newConversation(m.req, env);
    const w = await call(
      m.req,
      a.id,
      "Bash",
      { description: "Write", command: "echo from-a > /workspace/x" },
      1,
    );
    expect(w.isError, text(w)).toBe(false);
    const r = await call(m.req, b.id, "Read", { file_path: "/workspace/x" }, 1);
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toContain("from-a");
    // a conversation in another device of the same person does not see it
    const c = await newConversation(m.req);
    const other = await call(m.req, c.id, "Read", { file_path: "/workspace/x" }, 1);
    expect(other.isError).toBe(true);
  });

  it("two first sandbox calls racing on an unbound conversation bind one device", async () => {
    const m = await member();
    const conv = await newConversation(m.req);
    const first = conv.deviceId as string;
    // as if created before devices existed, by a person without a default device yet
    await db
      .updateTable("conversations")
      .set({ device_id: null })
      .where("id", "=", conv.id)
      .execute();
    await db.deleteFrom("devices").where("id", "=", first).execute();
    expect(await defaultOf(m.id)).toBeUndefined();

    const envs = k.app.get(ConversationDevices);
    const [a, b] = await Promise.all([envs.forTool(orgId, conv.id), envs.forTool(orgId, conv.id)]);
    expect(a).toBe(b);
    expect(await boundTo(conv.id)).toBe(a);
    expect(await defaultOf(m.id)).toBe(a);
    const live = await db
      .selectFrom("devices")
      .select("id")
      .where("org_id", "=", orgId)
      .where("owner_account_id", "=", m.id)
      .where("deleted_at", "is", null)
      .execute();
    expect(live.map((r) => r.id)).toEqual([a]);
  });

  it("sub-agent uses the root's device", async () => {
    const m = await member();
    const conv = await newConversation(m.req);
    await call(
      m.req,
      conv.id,
      "Bash",
      { description: "Write", command: "echo from-root > /workspace/root.txt" },
      1,
    );
    const childPrompt = `tool:Bash:${JSON.stringify({ description: "Read", command: "cat /workspace/root.txt" })}`;
    await call(
      m.req,
      conv.id,
      "Agent",
      { description: "Check", prompt: childPrompt, subagent_type: "general-purpose" },
      2,
    );
    const dispatched = (await eventsOf(db, conv.id)).find(
      (e) => e.type === "subagent_dispatched",
    ) as Extract<ConversationEvent, { type: "subagent_dispatched" }> | undefined;
    const child = dispatched?.payload.subagentId as string;
    expect(child).toBeTruthy();
    const childResult = (await waitFor(
      async () => (await eventsOf(db, child)).find((e) => e.type === "tool_result"),
      30_000,
      "the child's tool result",
    )) as ToolResult;
    expect(text(childResult.payload)).toContain("from-root");
    // the child itself stays unbound: it works in its root's device
    expect(await boundTo(child)).toBeNull();
    expect(await boundTo(conv.id)).toBe(await defaultOf(m.id));
  });

  it("create with another person's deviceId is not_found", async () => {
    const a = await member();
    const b = await member();
    const theirs = await newDevice(b.req, "Private");
    const before = await db.selectFrom("conversations").select("id").execute();
    for (const message of [undefined, { text: "hi", clientMessageId: randomUUID() }]) {
      const res = await a.req({
        method: "POST",
        url: conversations(),
        payload: { agentId, deviceId: theirs, ...(message !== undefined && { message }) },
      });
      expect(res.statusCode, res.body).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe("device.not_found");
    }
    // nothing was created
    expect((await db.selectFrom("conversations").select("id").execute()).length).toBe(
      before.length,
    );
    // a deleted device of one's own is not_found too
    const gone = await newDevice(a.req, "Gone");
    const del = await a.req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/devices/${gone}`,
    });
    expect(del.statusCode, del.body).toBe(202);
    const res = await a.req({
      method: "POST",
      url: conversations(),
      payload: { agentId, deviceId: gone },
    });
    expect(res.statusCode).toBe(404);
  });

  it("create with one's own device of another org is not_found", async () => {
    const m = await member();
    const otherOrg = await createOrg(owner, `Other ${randomUUID().slice(0, 6)}`);
    await testMembers(db).add(otherOrg, m.id, "member", ownerId);
    const res = await m.req({
      method: "POST",
      url: `/api/v1/orgs/${otherOrg}/devices`,
      payload: { name: "Elsewhere" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const elsewhere = (res.json() as { device: { id: string } }).device.id;
    const create = await m.req({
      method: "POST",
      url: conversations(),
      payload: { agentId, deviceId: elsewhere },
    });
    expect(create.statusCode, create.body).toBe(404);
    expect((create.json() as { error: { code: string } }).error.code).toBe("device.not_found");
  });

  it("a conversation whose device was deleted fails its sandbox tools", async () => {
    const m = await member();
    const env = await newDevice(m.req, "Doomed");
    const conv = await newConversation(m.req, env);
    const del = await m.req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/devices/${env}`,
    });
    expect(del.statusCode, del.body).toBe(202);
    const r = await call(m.req, conv.id, "Bash", { description: "Try", command: "true" }, 1);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("device was deleted");
    // still bound to it: no silent switch to another device
    expect(await boundTo(conv.id)).toBe(env);
  });

  it("background task status follows the device instance", async () => {
    const m = await member();
    const env = await newDevice(m.req, "Tasks");
    const a = await newConversation(m.req, env);
    const b = await newConversation(m.req, env);
    const started = await call(
      m.req,
      a.id,
      "Bash",
      { description: "Wait", command: "sleep 60", run_in_background: true },
      1,
    );
    expect(started.isError, text(started)).toBe(false);
    const task = await db
      .selectFrom("background_tasks")
      .select(["id", "device_id", "sandbox_conversation_id", "sandbox_created_at", "status"])
      .where("conversation_id", "=", a.id)
      .executeTakeFirstOrThrow();
    expect(task.device_id).toBe(env);
    expect(task.sandbox_conversation_id).toBe(a.id);
    const instance = await db
      .selectFrom("device_instances")
      .select("created_at")
      .where("device_id", "=", env)
      .executeTakeFirstOrThrow();
    expect(new Date(task.sandbox_created_at as Date).getTime()).toBe(instance.created_at.getTime());
    // another conversation using the instance: the task keeps running
    const seen = await call(
      m.req,
      b.id,
      "Bash",
      { description: "Look", command: "ls /workspace/.capybara/tasks" },
      1,
    );
    expect(text(seen)).toContain(task.id);
    const poll = k.app.get(BackgroundTaskPollJob);
    expect(await poll.pollOnce()).toBe(0);
    // the device's instance is suspended: the task ends lost with it
    expect(
      await k.app.get(SandboxService).suspendIdle(new Date(Date.now() + 24 * 3600_000)),
    ).toBeGreaterThan(0);
    expect(await poll.pollOnce()).toBe(1);
    const after = await db
      .selectFrom("background_tasks")
      .select(["status", "lost_reason"])
      .where("id", "=", task.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ status: "lost", lost_reason: "sandbox_suspended" });
  });

  it("a new IM thread uses the IM default only while it is the person's own and usable", async () => {
    const a = await member();
    const b = await member();
    const convs = k.app.get(ConversationsService);
    const imDefault = async (deviceId: string) =>
      db
        .insertInto("device_defaults")
        .values({ org_id: orgId, account_id: a.id, device_id: deviceId })
        .onConflict((oc) =>
          oc.columns(["org_id", "account_id"]).doUpdateSet({ device_id: deviceId }),
        )
        .execute();
    const chosen = await newDevice(a.req, "IM work");
    await imDefault(chosen);
    expect((await convs.create(orgId, a.id, agentId, { im: true })).deviceId).toBe(chosen);
    // the web ignores the IM default
    expect((await convs.create(orgId, a.id, agentId)).deviceId).toBe(await defaultOf(a.id));
    // a row naming someone else's device (no DB guard) is never used
    await imDefault(await newDevice(b.req, "Not yours"));
    expect((await convs.create(orgId, a.id, agentId, { im: true })).deviceId).toBe(
      await defaultOf(a.id),
    );
    // nor a deleted one
    await imDefault(chosen);
    await db
      .updateTable("devices")
      .set({ deleted_at: new Date() })
      .where("id", "=", chosen)
      .execute();
    expect((await convs.create(orgId, a.id, agentId, { im: true })).deviceId).toBe(
      await defaultOf(a.id),
    );
  });

  it("anonymous IM conversation has no sandbox", async () => {
    const guest = await k.app.get(AnonymousGuests).ensure(orgId);
    const convs = k.app.get(ConversationsService);
    const conv = await convs.create(orgId, guest, agentId, { im: true });
    expect(conv.deviceId).toBeNull();
    await convs.postUserMessage(orgId, conv.id, guest, {
      text: `tool:Bash:${JSON.stringify({ description: "Try", command: "true" })}`,
      clientMessageId: randomUUID(),
    });
    await waitForTerminal(db, conv.id, 1, 30_000);
    const r = (await eventsOf(db, conv.id)).find((e) => e.type === "tool_result") as ToolResult;
    expect(r.payload.isError).toBe(true);
    expect(text(r.payload)).toContain("anonymous IM senders");
    // the guest got no device
    expect(await defaultOf(guest)).toBeUndefined();
    expect(await boundTo(conv.id)).toBeNull();
  });
});
