import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelReq, SandboxRoots } from "@capybara-hq/plugin-sdk";
import {
  fakeDm as dm,
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ConversationEvent,
  type EventPayload,
  PermissionContextV2Schema,
} from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { DeviceTargets } from "../../src/local-devices/targets.js";
import { RunSteps } from "../../src/runtime/run-steps.js";
import { PERMISSION_CONTEXT_ACTIVE } from "../../src/sandbox/permission-context-types.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrgWithProviders,
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
import { FakeMachineV3 } from "../local-devices/fake-machine-v3.js";
import type { Answer } from "../local-devices/test-holder.js";

/**
 * Permission activation, gate on end to end (W6 Task Q, B-20 and the cross-path smoke test): the
 * kernel as production starts it (no activation override) records a v2 permission context before
 * every agent request and answers, on each path a run reaches a device by: an anonymous IM guest
 * (no device), a member's local device whose machine speaks protocol 3 over the real gateway
 * route, and a member's cloud device on the sandbox-fake provider through the managed operation
 * route.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

const MACHINE_ROOTS: SandboxRoots = {
  workspace: "/home/me/capybara/box/workspace",
  skills: "/home/me/capybara/box/skills",
  tmp: "/home/me/capybara/box/tmp",
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let im: FakeChannelServer;
let sandboxRoot: string;
let owner: Req;
let ownerId: string;
let orgId: string;
let chatAgentId: string;
let bashAgentId: string;
const machines: FakeMachineV3[] = [];
/** The local and cloud conversations of the scenarios below (their follow-ups continue them). */
let localConv: { conv: string; req: Req; deviceId: string } | undefined;
let cloudConv: { conv: string; req: Req; deviceId: string } | undefined;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-activation-"));
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, CHAN_MINI, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root: sandboxRoot } },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000 },
        devices: { local: { reconnectGraceSeconds: 30, leaseTtlMs: 6000 } },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  chatAgentId = await createAgent(owner, orgId);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the device.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  bashAgentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  for (const m of machines.splice(0)) m.close();
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

type Of<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e) => e.type === type) as Of<T>[];

/**
 * The recorded contexts of a finished conversation, checked against the activation invariant:
 * the run finished; every context is a schema-valid v2 snapshot; the first one precedes the first
 * agent request; and every agent request locates the latest context recorded before it. Returns
 * the contexts, the agent requests and the events.
 */
async function recorded(conv: string) {
  const ends = await waitForTerminal(db, conv, 1, 60_000);
  expect(ends.map((e) => e.type)).toEqual(ends.map(() => "run_finished"));
  const events = await eventsOf(db, conv);
  const contexts = ofType(events, "permission_context");
  // every agent request of the run (model_call logs agent-history requests only)
  const calls = ofType(events, "model_call");
  expect(contexts.length).toBeGreaterThan(0);
  expect(calls.length).toBeGreaterThan(0);
  for (const c of contexts) {
    expect(PermissionContextV2Schema.safeParse(c.payload).success, JSON.stringify(c.payload)).toBe(
      true,
    );
    expect(c.payload.version).toBe(2);
    expect(c.payload.rootConversationId).toBe(conv);
  }
  expect(contexts[0]?.seq ?? Infinity).toBeLessThan(calls[0]?.seq ?? 0);
  for (const call of calls) {
    const latest = contexts.filter((c) => c.seq < call.seq).at(-1);
    expect(latest, `a context before request ${call.seq}`).toBeDefined();
    expect(call.payload.request.permissionContext).toMatchObject({ version: 1 });
    expect(call.payload.request.permissionContext?.contextSeq).toBe(latest?.seq);
  }
  return { contexts, calls, events };
}

/** The text of the run's last assistant message. */
const replyOf = (events: ConversationEvent[]): string =>
  JSON.stringify(ofType(events, "assistant_message").at(-1)?.payload ?? null);

/** A new org member with a web session. */
async function member(login: string): Promise<{ id: string; req: Req }> {
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  return { id, req: await session(k, login) };
}

describe("the paired activation is on as production starts it", () => {
  it("the gate is the production constant, and the run steps carry the live recorder", () => {
    expect(PERMISSION_CONTEXT_ACTIVE).toBe(true);
    expect(k.app.get(RunSteps).deps.permissionContext).toBeDefined();
  });
});

describe("every path records a v2 permission context and replies", () => {
  it("an anonymous IM guest: no device, the context says so, and the bot replies", async () => {
    const en = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
      payload: { enabled: true },
    });
    expect(en.statusCode, en.body).toBe(200);
    const created = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin: "chan-mini",
        name: "Bot",
        agentId: chatAgentId,
        config: { platformUrl: im.url, appId: "cli_1", appSecret: "app-secret-1234567" },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const connId = (created.json() as { channel: { id: string } }).channel.id;
    const policy = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/channels/${connId}`,
      payload: { unboundPolicy: "anonymous" },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    await waitFor(async () => im.active(connId).length === 1, 20_000, "long connection");

    const before = im.sent.length;
    expect(im.push(connId, dm("guest-1", "guest", "echo:guest reply"))).toBe(1);
    const thread = await waitFor(
      async () =>
        (
          await sql<{ conversation_id: string; account_id: string | null }>`
            SELECT conversation_id, account_id FROM capybara.channel_threads
            WHERE connection_id = ${connId} AND chat_id = 'dm-guest'`.execute(raw)
        ).rows[0],
      20_000,
      "guest thread",
    );
    // a guest: no linked account
    expect(thread.account_id).toBeNull();
    const { contexts } = await recorded(thread.conversation_id);
    expect(contexts.at(-1)?.payload).toMatchObject({
      deviceId: null,
      scope: null,
      availability: { state: "unavailable", cause: "no-device" },
    });
    // the reply streams into the guest's chat: one message, then updates to the full text
    await waitFor(
      async () =>
        [...im.sent.slice(before), ...im.updated].some(
          (s) => s.target.chatId === "dm-guest" && s.message.text?.includes("guest reply"),
        ),
      20_000,
      "guest reply",
    );
  });

  it("a local device on protocol 3: the command reaches the machine by its operation scope, the context is local and supported", async () => {
    const m = await member("local-member");
    const { deviceId, credential } = await k.app.get(TransactionHost).run(async () => {
      const { id } = await k.app.get(DevicesService).createLocal(orgId, m.id, "Box");
      const issued = await k.app.get(MachinesService).issue({
        orgId,
        deviceId: id,
        accountId: m.id,
        name: "box",
        os: "linux",
        arch: "x64",
        programVersion: "0.1.0",
      });
      return { deviceId: id, credential: issued.credential };
    });
    const answer = (req: KernelReq): Answer => {
      switch (String(req.op)) {
        case "create":
          return { ok: true, result: { roots: MACHINE_ROOTS } };
        case "exec":
          return {
            ok: true,
            result: {
              exitCode: 0,
              stdout: "machine-ok\n",
              stderr: "",
              truncated: false,
              timedOut: false,
            },
          };
        default:
          // bindInstance: the installed evidence (autoBind); prepare and revoke: nothing
          return { ok: true, result: null };
      }
    };
    const machine = new FakeMachineV3(
      `ws://127.0.0.1:${k.port}/device/connect`,
      credential,
      answer,
      { hello: false },
    );
    machines.push(machine);
    await machine.opened;
    machine.hello({ roots: MACHINE_ROOTS });
    await machine.ready;
    const targets = k.app.get(DeviceTargets);
    await waitFor(
      () => targets.transport(deviceId).catch(() => null),
      20_000,
      "the machine's transport",
    );

    const res = await m.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: { agentId: bashAgentId, deviceId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const conv = (res.json() as { conversation: { id: string } }).conversation.id;
    const input = { description: "Say hi", command: "echo hi" };
    await postMessage(m.req, orgId, conv, `tool:Bash:${JSON.stringify(input)}`);
    const { contexts, events } = await recorded(conv);
    localConv = { conv, req: m.req, deviceId };

    // the command went to the machine as a scoped protocol 3 exec of this conversation
    const exec = machine.frames.find((f) => f.type === "req" && String(f.op) === "exec") as
      | KernelReq
      | undefined;
    expect(exec).toBeDefined();
    const scope = (
      exec?.args as { scope?: { deviceId: string; rootConversationId: string } } | undefined
    )?.scope;
    expect(scope).toMatchObject({ deviceId, rootConversationId: conv });
    expect(
      machine.frames.some(
        (f) => f.type === "req" && ["killAll", "killTagged"].includes(String(f.op)),
      ),
    ).toBe(false);
    const result = ofType(events, "tool_result").at(-1)?.payload;
    expect(result?.isError, JSON.stringify(result)).toBe(false);
    expect(result?.content).toContain("machine-ok");
    expect(replyOf(events)).toContain("machine-ok");
    // the request answering with the command's result runs under a supported local context
    expect(contexts.at(-1)?.payload).toMatchObject({
      deviceId,
      availability: { state: "supported" },
      scope: { location: "local" },
    });
  });

  it("a cloud device on sandbox-fake: the managed call runs, the context is cloud and supported", async () => {
    const m = await member("cloud-member");
    const res = await m.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: { agentId: bashAgentId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const conv = (res.json() as { conversation: { id: string } }).conversation.id;
    const input = { description: "Say hi", command: "echo cloud-ok" };
    await postMessage(m.req, orgId, conv, `tool:Bash:${JSON.stringify(input)}`);
    const { contexts, events } = await recorded(conv);
    const device = await db
      .selectFrom("conversations")
      .innerJoin("devices", "devices.id", "conversations.device_id")
      .select(["devices.id", "devices.source", "devices.provider"])
      .where("conversations.id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(device).toMatchObject({ source: "cloud", provider: "sandbox-fake" });
    cloudConv = { conv, req: m.req, deviceId: device.id };
    const result = ofType(events, "tool_result").at(-1)?.payload;
    expect(result?.isError, JSON.stringify(result)).toBe(false);
    expect(result?.content).toContain("cloud-ok");
    expect(replyOf(events)).toContain("cloud-ok");
    expect(contexts.at(-1)?.payload).toMatchObject({
      deviceId: device.id,
      availability: { state: "supported" },
      scope: { location: "cloud" },
    });
  });
  it("a profile change on the local device's conversation appends a new context before the next request", async () => {
    const c = localConv;
    if (!c) throw new Error("the local scenario runs first");
    const before = ofType(await eventsOf(db, c.conv), "permission_context");
    const now = await c.req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${c.conv}/permissions`,
    });
    expect(now.statusCode, now.body).toBe(200);
    const body = now.json() as { revision?: number; permission?: { revision: number } };
    const res = await c.req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/conversations/${c.conv}/permissions`,
      payload: {
        profile: "request-approval",
        expectedRevision: body.revision ?? body.permission?.revision ?? 0,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    await postMessage(c.req, orgId, c.conv, "echo:after the change");
    await waitForTerminal(db, c.conv, 2, 60_000);
    const { contexts, calls, events } = await recorded(c.conv);
    // append-only: the earlier snapshots stay as they were, a new one follows them
    expect(contexts.slice(0, before.length).map((e) => e.payload)).toEqual(
      before.map((e) => e.payload),
    );
    const added = contexts.slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toMatchObject({
      selectedProfile: "request-approval",
      effectiveProfile: "request-approval",
      deviceId: c.deviceId,
      availability: { state: "supported" },
      scope: { location: "local" },
    });
    expect(calls.at(-1)?.payload.request.permissionContext?.contextSeq).toBe(added[0]?.seq);
    expect(replyOf(events)).toContain("after the change");
  });

  it("a cloud conversation's next request with nothing changed records no duplicate context", async () => {
    const c = cloudConv;
    if (!c) throw new Error("the cloud scenario runs first");
    const events = await eventsOf(db, c.conv);
    const contexts = ofType(events, "permission_context");
    const calls = ofType(events, "model_call");
    await postMessage(c.req, orgId, c.conv, "echo:again");
    await waitForTerminal(db, c.conv, 2, 60_000);
    const after = await recorded(c.conv);
    expect(after.contexts.map((e) => e.seq)).toEqual(contexts.map((e) => e.seq));
    expect(after.calls).toHaveLength(calls.length + 1);
    expect(after.calls.at(-1)?.payload.request.permissionContext?.contextSeq).toBe(
      contexts.at(-1)?.seq,
    );
    expect(replyOf(after.events)).toContain("again");
  });
});
