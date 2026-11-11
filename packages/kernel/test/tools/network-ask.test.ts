import { randomUUID } from "node:crypto";
import type {
  DeviceExecArgs,
  DeviceLocalPolicySummary,
  KernelReq,
  NetworkBlockLayer,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { Waits } from "../../src/runtime/waits.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import { NETWORK_ASK_CANCELLED_NOTE } from "../../src/tools/approvals.service.js";
import {
  addressLayerNote,
  allowedAlwaysNote,
  allowedOnceNote,
  deniedNote,
  expiredNote,
  orgLayerNote,
  skippedNote,
  tooManyNote,
  unattendedNetworkNote,
} from "../../src/tools/network-asks.js";
import { ToolPipeline } from "../../src/tools/pipeline.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createConv,
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
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";

/**
 * The network ask in the tool pipeline (network ask-to-allow spec §6.2, §6.6–§6.9, §8.3, P1.7):
 * a foreground `Bash` on a connected device whose exec reports refused hosts. The run waits for
 * the device owner; each outcome writes the kept output plus its note and never runs the command
 * again. Model-fake drives the runs; a fake machine answers the exec with `network.blocked`.
 */

const POLICY: DeviceLocalPolicySummary = {
  network: "allowlist",
  allowedDomains: [],
  remoteGrants: "owner",
};
const CURL_ERR = "curl: (56) CONNECT tunnel failed, response 403";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let wsUrl: string;
const open: FakeMachine[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        // the org allows *.example.com; anything else a device calls `device` becomes `org`
        sandbox: { limits: { egress: "allowlist", allowHosts: ["*.example.com"] } },
        devices: { local: { reconnectGraceSeconds: 1, leaseTtlMs: 6000 } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  wsUrl = `ws://127.0.0.1:${k.port}/device/connect`;
}, 180_000);

afterEach(() => {
  for (const m of open.splice(0)) m.close();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** What the fake device refuses: host → layer it reports (hosts it was granted pass). */
interface Device {
  blocking: Map<string, NetworkBlockLayer>;
  /** The device's local allowlist (the policy op adds to it). */
  allowed: Set<string>;
  /** Answer the policy op with a refusal. */
  refusePolicy: boolean;
  features: string[];
  policy: DeviceLocalPolicySummary;
}

interface Setup {
  accountId: string;
  req: Req;
  deviceId: string;
  credential: string;
  machineId: string;
  agentId: string;
  conversationId: string;
  dev: Device;
  machine: FakeMachine;
}

let s: Setup;

/** `curl <host>…`: the exec answer of the fake device. */
function answer(dev: Device) {
  return (req: KernelReq) => {
    const a = req.args as Record<string, unknown>;
    switch (req.op) {
      case "create":
        return { ok: true, result: { roots: { ...HELLO.roots } } } as const;
      case "exec": {
        const args = a as unknown as DeviceExecArgs;
        const granted = new Set(args.grants?.hosts ?? []);
        const hosts = args.command.startsWith("curl ") ? args.command.split(" ").slice(1) : [];
        const blocked = hosts.flatMap((host) => {
          const layer = dev.blocking.get(host);
          return layer === undefined || granted.has(host) || dev.allowed.has(host)
            ? []
            : [{ host, port: 443, layer }];
        });
        return {
          ok: true,
          result: {
            exitCode: blocked.length > 0 ? 56 : 0,
            stdout: blocked.length > 0 ? "" : "fetched\n",
            stderr: blocked.length > 0 ? `${CURL_ERR}\n` : "",
            truncated: false,
            timedOut: false,
            ...(blocked.length > 0 && { network: { blocked } }),
          },
        } as const;
      }
      case "policy": {
        if (dev.refusePolicy) {
          return {
            ok: false,
            error: { kind: "policy", message: "This device does not accept network changes." },
          } as const;
        }
        for (const h of (a.add as string[] | undefined) ?? []) dev.allowed.add(h);
        return {
          ok: true,
          result: { policy: { ...dev.policy, allowedDomains: [...dev.allowed] } },
        } as const;
      }
      default:
        return { ok: true, result: null } as const;
    }
  };
}

async function connect(deviceId: string, credential: string, machineId: string, dev: Device) {
  // biome-ignore lint/suspicious/noExplicitAny: the answers are the device protocol's
  const machine = new FakeMachine(wsUrl, credential, answer(dev) as any, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.send({ ...HELLO, features: dev.features, policy: dev.policy } as typeof HELLO);
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(deviceId))) !== null,
    10_000,
    "lease held",
  );
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("roots")
          .where("id", "=", machineId)
          .executeTakeFirst()
      )?.roots != null,
    10_000,
    "hello recorded",
  );
  return machine;
}

async function setup(over: Partial<Device> = {}, tools = ["Bash"]): Promise<Setup> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Dev ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const req = await session(k, login);
  const device = await k.app.get(TransactionHost).run(async () => {
    const { id: deviceId } = await k.app.get(DevicesService).createLocal(orgId, accountId, "Box");
    const issued = await k.app.get(MachinesService).issue({
      orgId,
      deviceId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { deviceId, ...issued };
  });
  const dev: Device = {
    blocking: new Map(),
    allowed: new Set(),
    refusePolicy: false,
    features: ["networkReport", "policyOp"],
    policy: POLICY,
    ...over,
  };
  const machine = await connect(device.deviceId, device.credential, device.machineId, dev);
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the device.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins(tools.map((name) => ({ kind: "builtin", name }))),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const agentId = (res.json() as { agent: { id: string } }).agent.id;
  const conversationId = await createConv(req, orgId, agentId);
  await sql`UPDATE capybara.conversations SET device_id = ${device.deviceId}
    WHERE id = ${conversationId}`.execute(raw);
  return { accountId, req, ...device, agentId, conversationId, dev, machine };
}

const curl = (hosts: string[], extra: Record<string, unknown> = {}) => ({
  name: "Bash",
  input: { command: `curl ${hosts.join(" ")}`, description: "Fetch", ...extra },
});

/** Posts `tool:` / `tools:` calls of Bash. */
async function post(calls: ReturnType<typeof curl>[], conv = s.conversationId) {
  const text =
    calls.length === 1
      ? `tool:Bash:${JSON.stringify(calls[0]?.input)}`
      : `tools:${JSON.stringify(calls)}`;
  await postMessage(s.req, orgId, conv, text);
}

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

/** The pending network asks of the conversation. */
const pendingAsks = (conversationId = s.conversationId) =>
  db
    .selectFrom("approvals")
    .select(["id", "status", "scopes", "detail", "requested_for"])
    .where("conversation_id", "=", conversationId)
    .where("kind", "=", "network")
    .where("status", "=", "pending")
    .execute();

const asks = (conversationId = s.conversationId) =>
  db
    .selectFrom("approvals")
    .select(["id", "status"])
    .where("conversation_id", "=", conversationId)
    .where("kind", "=", "network")
    .execute();

/** Waits for the `n`-th network ask of the conversation to be pending; returns it. */
const nextAsk = (conversationId = s.conversationId) =>
  waitFor(async () => (await pendingAsks(conversationId))[0], 15_000, "a pending network ask");

const decide = (id: string, payload: Record<string, unknown>) =>
  s.req({ method: "POST", url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`, payload });

/** The exec frames of the fake machine that ran a `curl`. */
const curlExecs = (m = s.machine) =>
  m.frames.filter(
    (f) =>
      f.type === "req" && f.op === "exec" && (f.args as DeviceExecArgs).command.startsWith("curl"),
  ) as KernelReq[];

const results = async (conversationId = s.conversationId) =>
  ofType(await eventsOf(db, conversationId), "tool_result").map((e) => e.payload);

const runStatus = async (conversationId = s.conversationId) =>
  (
    await db
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow()
  ).status;

describe("the ask and its outcomes", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    s = await setup();
    s.dev.blocking.set("files.example.com", "device");
  });

  it("「这次允许」: the run waits, network_blocked + approval_requested; the kept output + once note; one exec; the next exec carries the run grant", async () => {
    await post([curl(["files.example.com"]), curl(["files.example.com"])]);
    const ask = await nextAsk();
    expect(ask).toMatchObject({ requested_for: s.accountId, scopes: ["once", "always"] });
    expect(ask.detail).toMatchObject({
      deviceId: s.deviceId,
      hosts: [{ host: "files.example.com", port: 443 }],
      command: "curl files.example.com",
      description: "Fetch",
      result: { isError: false },
    });
    await waitFor(async () => (await runStatus()) === "waiting", 10_000, "run waiting");
    const evs = await eventsOf(db, s.conversationId);
    const blocked = ofType(evs, "network_blocked");
    expect(blocked.map((e) => e.payload.hosts)).toEqual([
      [{ host: "files.example.com", port: 443, layer: "device" }],
    ]);
    expect(ofType(evs, "approval_requested")[0]?.payload.network).toEqual({
      hosts: ["files.example.com"],
    });
    expect(ofType(evs, "tool_result")).toEqual([]);
    expect(curlExecs()).toHaveLength(1);

    expect((await decide(ask.id, { decision: "approve", scope: "once" })).statusCode).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [first, second] = await results();
    expect(first?.content).toContain(CURL_ERR);
    expect(first?.content).toContain("[exit code: 56]");
    expect(first?.content.endsWith(`\n\n${allowedOnceNote(["files.example.com"])}`)).toBe(true);
    expect(first?.view).toMatchObject({ kind: "command", exitCode: 56 });
    // the first command never ran again; the second ran with the run grant and passed
    const execs = curlExecs();
    expect(execs).toHaveLength(2);
    expect((execs[1]?.args as DeviceExecArgs | undefined)?.grants?.hosts).toEqual([
      "files.example.com",
    ]);
    expect(second?.content).toContain("fetched");
    expect(second?.content).not.toContain("[network]");
    // display-only: no model request carries network_blocked or the ask's hosts
    const requests = ofType(await eventsOf(db, s.conversationId), "model_call").map((e) =>
      JSON.stringify(e.payload.request),
    );
    for (const r of requests) expect(r).not.toContain("network_blocked");
    // tool.called audited once, when the command ran
    const called = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "tool.called")
      .where("target", "=", s.conversationId)
      .execute();
    expect(called).toHaveLength(2);
  });

  it("「一直允许」: the device applies the policy op; the always note", async () => {
    await post([curl(["files.example.com"])]);
    const ask = await nextAsk();
    expect((await decide(ask.id, { decision: "approve", scope: "always" })).statusCode).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [r] = await results();
    expect(r?.content.endsWith(`\n\n${allowedAlwaysNote(["files.example.com"])}`)).toBe(true);
    expect(s.dev.allowed.has("files.example.com")).toBe(true);
    expect(curlExecs()).toHaveLength(1);
  });

  it("「一直允许」 the device refuses: falls back to this time, the once note", async () => {
    s.dev.refusePolicy = true;
    await post([curl(["files.example.com"])]);
    const ask = await nextAsk();
    const res = await decide(ask.id, { decision: "approve", scope: "always" });
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      detail: { outcome: "once_fallback", fallback: "refused" },
    });
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [r] = await results();
    expect(r?.content.endsWith(`\n\n${allowedOnceNote(["files.example.com"])}`)).toBe(true);
  });

  it("「一直允许」 with the device offline: once fallback, the once note", async () => {
    await post([curl(["files.example.com"])]);
    const ask = await nextAsk();
    s.machine.close();
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(s.deviceId))) === null,
      15_000,
      "lease released",
    );
    const res = await decide(ask.id, { decision: "approve", scope: "always" });
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      detail: { outcome: "once_fallback", fallback: "offline" },
    });
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [r] = await results();
    expect(r?.content.endsWith(`\n\n${allowedOnceNote(["files.example.com"])}`)).toBe(true);
  });

  it("deny with a reason: the denied note with the reason; the host is not asked again in the run", async () => {
    await post([curl(["files.example.com"]), curl(["files.example.com"])]);
    const ask = await nextAsk();
    expect(
      (await decide(ask.id, { decision: "deny", reason: "Not on this machine" })).statusCode,
    ).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [first, second] = await results();
    expect(
      first?.content.endsWith(`\n\n${deniedNote(["files.example.com"], "Not on this machine")}`),
    ).toBe(true);
    // the second command ran, was refused again and got the denied note without an ask
    expect(curlExecs()).toHaveLength(2);
    expect(second?.content.endsWith(`\n\n${deniedNote(["files.example.com"])}`)).toBe(true);
    expect(await asks()).toHaveLength(1);
  });

  it("expired: the expired note with the timeout's hours", async () => {
    await post([curl(["files.example.com"])]);
    const ask = await nextAsk();
    // asked 24h ago (the default tools.approvalTimeoutHours): the note says how long it waited
    await sql`UPDATE capybara.approvals SET created_at = now() - interval '24 hours',
      expires_at = now() - interval '1 second' WHERE id = ${ask.id}`.execute(raw);
    await k.app.get(Waits).expire("approval", ask.id);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [r] = await results();
    expect(r?.content.endsWith(`\n\n${expiredNote(["files.example.com"], 24)}`)).toBe(true);
    expect(curlExecs()).toHaveLength(1);
  });

  it("a reply skips the ask: the skipped note; the run goes on with the reply", async () => {
    await post([curl(["files.example.com"])]);
    await nextAsk();
    await waitFor(async () => (await runStatus()) === "waiting", 10_000, "run waiting");
    await postMessage(s.req, orgId, s.conversationId, "echo:never mind");
    // the waiting run resumes and takes the reply in (the person leads, spec §6.7)
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [r] = await results();
    expect(r?.content.endsWith(`\n\n${skippedNote(["files.example.com"])}`)).toBe(true);
    expect(curlExecs()).toHaveLength(1);
  });

  it("abort: the kept output + the cancelled note", async () => {
    await post([curl(["files.example.com"])]);
    await nextAsk();
    await waitFor(async () => (await runStatus()) === "waiting", 10_000, "run waiting");
    const res = await s.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${s.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [r] = await results();
    expect(r?.content).toContain(CURL_ERR);
    expect(r?.content.endsWith(`\n\n${NETWORK_ASK_CANCELLED_NOTE}`)).toBe(true);
  });
});

describe("not asked", { timeout: 60_000 }, () => {
  it("org and address layers: immediate notes and network_blocked, no ask (the org layer is the kernel's)", async () => {
    s = await setup();
    // the device calls api.foo.com `device`: the org does not allow it, so it is `org`
    s.dev.blocking.set("api.foo.com", "device");
    s.dev.blocking.set("10.0.0.5", "address");
    await post([curl(["api.foo.com", "10.0.0.5"])]);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [r] = await results();
    expect(
      r?.content.endsWith(
        `\n\n${orgLayerNote(["api.foo.com"])}\n${addressLayerNote(["10.0.0.5"])}`,
      ),
    ).toBe(true);
    expect(await asks()).toEqual([]);
    const blocked = ofType(await eventsOf(db, s.conversationId), "network_blocked");
    expect(blocked[0]?.payload.hosts).toEqual([
      { host: "api.foo.com", port: 443, layer: "org" },
      { host: "10.0.0.5", port: 443, layer: "address" },
    ]);
    // network_blocked comes before the call's result
    const evs = await eventsOf(db, s.conversationId);
    const at = (t: string) => evs.findIndex((e) => e.type === t);
    expect(at("network_blocked")).toBeLessThan(at("tool_result"));
  });

  it("a program without policyOp: no ask, no note", async () => {
    s = await setup({ features: ["networkReport"] });
    s.dev.blocking.set("files.example.com", "device");
    await post([curl(["files.example.com"])]);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [r] = await results();
    expect(r?.content).not.toContain("[network]");
    expect(await asks()).toEqual([]);
    expect(ofType(await eventsOf(db, s.conversationId), "network_blocked")).toHaveLength(1);
  });

  it("a device without remote grants is asked 「这次」 only", async () => {
    s = await setup({ policy: { ...POLICY, remoteGrants: "off" } });
    s.dev.blocking.set("files.example.com", "device");
    await post([curl(["files.example.com"])]);
    expect((await nextAsk()).scopes).toEqual(["once"]);
  });

  it("background Bash is not asked", async () => {
    s = await setup();
    s.dev.blocking.set("files.example.com", "device");
    await post([curl(["files.example.com"], { run_in_background: true })]);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    expect(await asks()).toEqual([]);
    expect(ofType(await eventsOf(db, s.conversationId), "network_blocked")).toEqual([]);
  });

  it("at most 5 asks per run; then the too-many note", async () => {
    s = await setup();
    const hosts = Array.from({ length: 6 }, (_, i) => `h${i}.example.com`);
    for (const h of hosts) s.dev.blocking.set(h, "device");
    await post(hosts.map((h) => curl([h])));
    for (let i = 0; i < 5; i++) {
      const ask = await nextAsk();
      expect((await decide(ask.id, { decision: "deny" })).statusCode).toBe(200);
    }
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const rs = await results();
    expect(rs).toHaveLength(6);
    expect(rs[5]?.content.endsWith(`\n\n${tooManyNote(["h5.example.com"])}`)).toBe(true);
    expect(await asks()).toHaveLength(5);
  });
});

describe("sub-agents and unattended runs", { timeout: 90_000 }, () => {
  it("a sub-agent's ask surfaces in the root (subagent_waiting); deciding resumes the child", async () => {
    s = await setup({}, ["Agent", "Bash"]);
    s.dev.blocking.set("files.example.com", "device");
    await postMessage(
      s.req,
      orgId,
      s.conversationId,
      `tool:Agent:${JSON.stringify({
        description: "Fetch",
        prompt: `tool:Bash:${JSON.stringify(curl(["files.example.com"]).input)}`,
        subagent_type: "general-purpose",
      })}`,
    );
    const waiting = (await waitFor(
      async () =>
        ofType(await eventsOf(db, s.conversationId), "subagent_waiting").find(
          (e) => e.payload.kind === "approval",
        ),
      30_000,
      "subagent_waiting in the root",
    )) as Extract<ConversationEvent, { type: "subagent_waiting" }>;
    const child = waiting.payload.subagentId;
    const [ask] = await pendingAsks(child);
    expect(ask?.requested_for).toBe(s.accountId);
    expect(waiting.payload).toMatchObject({ approvalId: ask?.id, requestedFor: s.accountId });
    expect((await decide(ask?.id as string, { decision: "approve" })).statusCode).toBe(200);
    await waitFor(async () => (await results(child)).length > 0, 30_000, "the child's result");
    const [r] = await results(child);
    expect(r?.content.endsWith(`\n\n${allowedOnceNote(["files.example.com"])}`)).toBe(true);
  });

  it("unattended, fail: no ask, the §8.3 note, missing_grants recorded (device and org layers)", async () => {
    s = await setup();
    s.dev.blocking.set("files.example.com", "device");
    s.dev.blocking.set("api.foo.com", "device");
    const store = new ScheduledTaskStore();
    const taskId = randomUUID();
    const taskRunId = randomUUID();
    const runId = randomUUID();
    await store.insertTask(db, {
      id: taskId,
      orgId,
      accountId: s.accountId,
      agentId: s.agentId,
      name: "Nightly",
      prompt: "Fetch.",
      trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "UTC" },
      mode: "conversation",
      conversationId: s.conversationId,
      chat: null,
      model: null,
      effort: null,
      deviceId: s.deviceId,
      status: "active",
      nextRunAt: null,
      jitterSeconds: 0,
      expiresAt: null,
    });
    await store.insertRun(db, {
      id: taskRunId,
      taskId,
      orgId,
      scheduledFor: new Date(),
      trial: false,
      status: "running",
    });
    await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
        trigger_account_id, trigger_seq, scheduled_task_run_id)
      VALUES (${runId}, ${s.conversationId}, 'running', 1, ${s.accountId}, 0, ${taskRunId})`.execute(
      raw,
    );
    const call = curl(["files.example.com", "api.foo.com"]);
    await k.app.get(EventLog).append(s.conversationId, [
      {
        type: "assistant_message",
        runId,
        idemKey: assistantIdemKey(runId, 1),
        payload: {
          step: 1,
          stopReason: "tool_use",
          content: [{ type: "tool_call", id: "call-1", name: "Bash", input: call.input }],
        },
      } as never,
    ]);
    const agent: AgentDefinition = {
      name: "Coder",
      instructions: "x",
      model: { provider: "model-fake", model: "fake-1" },
      disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
    } as AgentDefinition;
    const out = await k.app.get(ToolPipeline).runStep({
      orgId,
      conversationId: s.conversationId,
      runId,
      step: 1,
      agentId: s.agentId,
      agentVersion: 1,
      agent,
      accountId: s.accountId,
      signal: new AbortController().signal,
      unattended: {
        taskId,
        taskRunId,
        trial: false,
        unattendedAsk: "fail",
        forbiddenTools: [],
      },
    });
    expect(out).toEqual({ kind: "done" });
    const [r] = await results();
    expect(
      r?.content.endsWith(
        `\n\n${unattendedNetworkNote(["files.example.com"])}\n${orgLayerNote(["api.foo.com"])}`,
      ),
    ).toBe(true);
    expect(await asks()).toEqual([]);
    const row = await db
      .selectFrom("scheduled_task_runs")
      .select("missing_grants")
      .where("id", "=", taskRunId)
      .executeTakeFirstOrThrow();
    expect([...(row.missing_grants as string[])].sort()).toEqual([
      "network:api.foo.com",
      "network:files.example.com",
    ]);
  });
});
