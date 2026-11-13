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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { NetworkGrants, type NetworkRunState } from "../../src/local-devices/network-grants.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { networkGrantRefusal } from "../../src/schedules/grant-rules.js";
import { ScheduledTasksService } from "../../src/schedules/scheduled-tasks.service.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import type { UnattendedRun } from "../../src/schedules/unattended.js";
import {
  planNetworkAsk,
  taskGrantIgnoredNote,
  unattendedNetworkNote,
} from "../../src/tools/network-asks.js";
import { ToolPipeline } from "../../src/tools/pipeline.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { webCaller } from "../helpers/step-context.js";
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";

/**
 * Scheduled task network grants (network ask-to-allow spec §8.1, §8.3; plan P2.4, P-D7): the
 * rule for a `network:<host>` grant, adding grants on the route, the task's grants reaching an
 * unattended run's exec (source `task`, no ask), the missing domains and the inbox item, and a
 * trial run's 「这次允许」 kept as a task grant.
 */

const POLICY: DeviceLocalPolicySummary = {
  effectiveTier: "strict",
  isolation: "sandbox",
  localhost: "off",
  unixSockets: "off",
  allowedDomains: [],
  remoteGrants: "owner",
};
const OPEN = { egress: "allowlist" as const, allowHosts: ["*.example.com"] };

describe("networkGrantRefusal", () => {
  const cases: [string, Partial<{ remoteGrants: "owner" | "off" }> | null, string | null][] = [
    ["files.example.com", null, null],
    ["files.example.com", { remoteGrants: "owner" }, null],
    ["*.example.com", null, "not_grantable"],
    ["10.0.0.5", null, "not_grantable"],
    ["printer.local", null, "not_grantable"],
    ["Files.Example.com", null, "not_grantable"],
    ["api.foo.com", null, "needs_admin"],
    ["files.example.com", { remoteGrants: "off" }, "device_refuses"],
    // the org layer comes first: an admin must act before the device matters
    ["api.foo.com", { remoteGrants: "off" }, "needs_admin"],
  ];
  it.each(cases)("%s with device %j → %s", (host, device, code) => {
    const summary = device === null ? null : { ...POLICY, ...device };
    expect(networkGrantRefusal(host, { limits: OPEN, deviceSummary: summary })?.code ?? null).toBe(
      code,
    );
  });

  it("egress none refuses every host; open admits every valid one", () => {
    expect(
      networkGrantRefusal("a.example.com", { limits: { egress: "none", allowHosts: [] } })?.code,
    ).toBe("needs_admin");
    expect(
      networkGrantRefusal("a.foo.com", { limits: { egress: "open", allowHosts: [] } }),
    ).toBeNull();
  });
});

describe("planNetworkAsk with task grants", () => {
  const run = (taskGranted: string[]): NetworkRunState => ({
    granted: new Set(),
    refused: new Set(),
    asks: 0,
    pending: false,
    taskGranted: new Set(taskGranted),
  });
  const unattended: UnattendedRun = {
    taskId: "t",
    taskRunId: "tr",
    trial: false,
    unattendedAsk: "fail",
    forbiddenTools: [],
  };
  const device = {
    features: ["networkReport", "policyOp", "policyOpId"] as const,
    policy: POLICY,
  };

  it("a task-granted host the device still refused: the ignored note, no ask, no missing grant", () => {
    const plan = planNetworkAsk(
      [
        { host: "files.example.com", port: 443, layer: "device" },
        { host: "other.example.com", port: 443, layer: "device" },
      ],
      run(["files.example.com"]),
      { device: { ...device, features: [...device.features] }, unattended },
    );
    expect(plan.ask).toEqual([]);
    expect(plan.missingGrants).toEqual(["network:other.example.com"]);
    expect(plan.notes).toEqual([
      taskGrantIgnoredNote(["files.example.com"]),
      unattendedNetworkNote(["other.example.com"]),
    ]);
  });
});

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

/** The fake device: what it refuses (granted or allowed hosts pass). */
interface Device {
  blocking: Map<string, NetworkBlockLayer>;
  allowed: Set<string>;
  policy: DeviceLocalPolicySummary;
}

interface Setup {
  accountId: string;
  req: Req;
  deviceId: string;
  agentId: string;
  conversationId: string;
  dev: Device;
  machine: FakeMachine;
}

function answer(dev: Device) {
  return (req: KernelReq) => {
    switch (req.op) {
      case "create":
        return { ok: true, result: { roots: { ...HELLO.roots } } } as const;
      case "exec": {
        const args = req.args as unknown as DeviceExecArgs;
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
            stderr: blocked.length > 0 ? "curl: (56) blocked\n" : "",
            truncated: false,
            timedOut: false,
            ...(blocked.length > 0 && { network: { blocked } }),
          },
        } as const;
      }
      default:
        return { ok: true, result: null } as const;
    }
  };
}

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
        sandbox: { limits: OPEN },
        devices: { local: { reconnectGraceSeconds: 1, leaseTtlMs: 6000 } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  wsUrl = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterEach(() => {
  for (const m of open.splice(0)) m.close();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function setup(policy: Partial<DeviceLocalPolicySummary> = {}): Promise<Setup> {
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
  const dev: Device = { blocking: new Map(), allowed: new Set(), policy: { ...POLICY, ...policy } };
  // biome-ignore lint/suspicious/noExplicitAny: the answers are the device protocol's
  const machine = new FakeMachine(wsUrl, device.credential, answer(dev) as any, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.send({
    ...HELLO,
    features: ["networkReport", "policyOp", "policyOpId"],
    policy: dev.policy,
  } as typeof HELLO);
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(device.deviceId))) !== null,
    10_000,
    "lease held",
  );
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("roots")
          .where("id", "=", device.machineId)
          .executeTakeFirst()
      )?.roots != null,
    10_000,
    "hello recorded",
  );
  const res = await req({
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
  const agentId = (res.json() as { agent: { id: string } }).agent.id;
  const conversationId = await createConv(req, orgId, agentId);
  await sql`UPDATE capybara.conversations SET device_id = ${device.deviceId}
    WHERE id = ${conversationId}`.execute(raw);
  return { accountId, req, deviceId: device.deviceId, agentId, conversationId, dev, machine };
}

const base = () => `/api/v1/orgs/${orgId}/schedules`;
const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

/** A `new` task on the setup's device, through the route. */
async function createTask(s: Setup, grants: string[] = []): Promise<string> {
  const res = await s.req({
    method: "POST",
    url: base(),
    payload: {
      agentId: s.agentId,
      name: "Nightly",
      prompt: "Fetch.",
      trigger: { kind: "cron", expr: "0 9 * * *" },
      mode: "new",
      deviceId: s.deviceId,
      ...(grants.length > 0 && { grants: grants.map((toolKey) => ({ toolKey })) }),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { task: { id: string } }).task.id;
}

/** A task run of `taskId` and a kernel run in the setup's conversation that serves it. */
async function taskRun(s: Setup, taskId: string, trial: boolean) {
  const taskRunId = randomUUID();
  const runId = randomUUID();
  await new ScheduledTaskStore().insertRun(db, {
    id: taskRunId,
    taskId,
    orgId,
    scheduledFor: new Date(),
    trial,
    status: "running",
  });
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
      trigger_account_id, trigger_seq, scheduled_task_run_id)
    VALUES (${runId}, ${s.conversationId}, 'running', 1, ${s.accountId}, 0, ${taskRunId})`.execute(
    raw,
  );
  return { taskRunId, runId };
}

/** Runs one `curl <hosts>` tool step of `runId` through the pipeline. */
async function curlStep(
  s: Setup,
  run: { taskRunId: string; runId: string },
  taskId: string,
  hosts: string[],
  trial: boolean,
) {
  const input = { command: `curl ${hosts.join(" ")}`, description: "Fetch" };
  await k.app.get(EventLog).append(s.conversationId, [
    {
      type: "assistant_message",
      runId: run.runId,
      idemKey: assistantIdemKey(run.runId, 1),
      payload: {
        step: 1,
        stopReason: "tool_use",
        content: [{ type: "tool_call", id: `call-${run.runId}`, name: "Bash", input }],
      },
    } as never,
  ]);
  const agent = {
    name: "Coder",
    instructions: "x",
    model: { provider: "model-fake", model: "fake-1" },
    disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
  } as AgentDefinition;
  return k.app.get(ToolPipeline).runStep({
    orgId,
    conversationId: s.conversationId,
    runId: run.runId,
    step: 1,
    agentId: s.agentId,
    agentVersion: 1,
    agent,
    accountId: s.accountId,
    ...webCaller(s.accountId),
    signal: new AbortController().signal,
    unattended: {
      taskId,
      taskRunId: run.taskRunId,
      trial,
      unattendedAsk: "fail",
      forbiddenTools: [],
    },
  });
}

const curlExecs = (m: FakeMachine) =>
  m.frames.filter(
    (f) =>
      f.type === "req" && f.op === "exec" && (f.args as DeviceExecArgs).command.startsWith("curl"),
  ) as KernelReq[];

const results = async (conversationId: string) =>
  (await eventsOf(db, conversationId))
    .filter(
      (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
    )
    .map((e) => e.payload);

const networkAsks = (conversationId: string) =>
  db
    .selectFrom("approvals")
    .select(["id", "status"])
    .where("conversation_id", "=", conversationId)
    .where("kind", "=", "network")
    .execute();

const grantKeys = async (s: Setup, taskId: string) => {
  const res = await s.req({ method: "GET", url: `${base()}/${taskId}/grants` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: { toolKey: string; specHash: string; stale: boolean }[] }).items;
};

describe("adding network grants", () => {
  it("create and add take network:<host> by the rule; the grant is stored as P-D7 says", async () => {
    const s = await setup();
    const taskId = await createTask(s, ["network:files.example.com"]);
    let res = await s.req({
      method: "POST",
      url: `${base()}/${taskId}/grants`,
      payload: { grants: [{ toolKey: "network:API.Example.com" }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await grantKeys(s, taskId)).toEqual([
      { toolKey: "network:api.example.com", specHash: "network", connectorId: null, stale: false },
      {
        toolKey: "network:files.example.com",
        specHash: "network",
        connectorId: null,
        stale: false,
      },
    ]);

    for (const [key, text] of [
      ["network:*.example.com", "exact domain"],
      ["network:10.0.0.5", "exact domain"],
      ["network:api.foo.com", "only an organization admin"],
    ] as const) {
      res = await s.req({
        method: "POST",
        url: `${base()}/${taskId}/grants`,
        payload: { grants: [{ toolKey: key }] },
      });
      expect(res.statusCode, key).toBe(400);
      expect(codeOf(res)).toBe("schedule.grant_not_allowed");
      expect(res.body).toContain(text);
    }

    // removing works by the full key
    res = await s.req({
      method: "DELETE",
      url: `${base()}/${taskId}/grants/${encodeURIComponent("network:api.example.com")}`,
    });
    expect(res.statusCode).toBe(204);
    expect((await grantKeys(s, taskId)).map((g) => g.toolKey)).toEqual([
      "network:files.example.com",
    ]);
  });

  it("a device that takes no remote grants refuses a network grant (device_refuses)", async () => {
    const s = await setup({ remoteGrants: "off" });
    const taskId = await createTask(s);
    const res = await s.req({
      method: "POST",
      url: `${base()}/${taskId}/grants`,
      payload: { grants: [{ toolKey: "network:files.example.com" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("schedule.grant_not_allowed");
    expect(res.body).toContain("capybara-device policy add allowedDomains files.example.com");
  });
});

describe("who may approve domains", () => {
  const refusal = "Network domains are approved on the task page by a person.";

  it("a personal access token cannot add or create network grants", async () => {
    const s = await setup();
    const taskId = await createTask(s);
    const pat = await apiTokensFor(db).createPersonal(s.accountId, { name: "cli" });
    const viaPat = (url: string, payload: unknown) =>
      k.http.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${pat.token}`, "x-capybara-csrf": "1" },
        payload: payload as Record<string, unknown>,
      });
    let res = await viaPat(`${base()}/${taskId}/grants`, {
      grants: [{ toolKey: "network:files.example.com" }],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(codeOf(res)).toBe("schedule.grant_not_allowed");
    expect(res.body).toContain(refusal);
    res = await viaPat(base(), {
      agentId: s.agentId,
      name: "Nightly",
      prompt: "Fetch.",
      trigger: { kind: "cron", expr: "0 9 * * *" },
      mode: "new",
      deviceId: s.deviceId,
      grants: [{ toolKey: "network:files.example.com" }],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain(refusal);
    expect(await grantKeys(s, taskId)).toEqual([]);
  });

  it("the Platform operations cannot add or create network grants", async () => {
    const s = await setup();
    const taskId = await createTask(s);
    const ops = k.app.get(PlatformOperations);
    const ctx = {
      orgId,
      actorAccountId: s.accountId,
      agentId: s.agentId,
      conversationId: s.conversationId,
      runId: randomUUID(),
      signal: new AbortController().signal,
    };
    const call = (id: string, input: unknown) => {
      const o = ops.get(id);
      if (o === null) throw new Error(`no operation ${id}`);
      return o.run(o.input.parse(input), ctx);
    };
    await expect(
      call("schedules.grants-add", {
        scheduleId: taskId,
        grants: [{ toolKey: "network:files.example.com" }],
      }),
    ).rejects.toThrow(refusal);
    await expect(
      call("schedules.create", {
        agentId: s.agentId,
        name: "Nightly",
        prompt: "Fetch.",
        trigger: { kind: "cron", expr: "0 9 * * *" },
        mode: "new",
        deviceId: s.deviceId,
        grants: [{ toolKey: "network:files.example.com" }],
      }),
    ).rejects.toThrow(refusal);
    expect(await grantKeys(s, taskId)).toEqual([]);
  });
});

describe("unattended runs", () => {
  it("a task grant reaches the exec with source task; nothing is asked or missing", async () => {
    const s = await setup();
    s.dev.blocking.set("files.example.com", "device");
    const taskId = await createTask(s, ["network:files.example.com"]);
    const run = await taskRun(s, taskId, false);
    expect(await curlStep(s, run, taskId, ["files.example.com"], false)).toEqual({ kind: "done" });
    const [exec] = curlExecs(s.machine);
    expect((exec?.args as DeviceExecArgs | undefined)?.grants).toEqual({
      hosts: ["files.example.com"],
      source: { kind: "task", id: taskId, accountId: s.accountId },
    });
    const [r] = await results(s.conversationId);
    expect(r?.content).toContain("fetched");
    expect(await networkAsks(s.conversationId)).toEqual([]);
    const row = await db
      .selectFrom("scheduled_task_runs")
      .select("missing_grants")
      .where("id", "=", run.taskRunId)
      .executeTakeFirstOrThrow();
    expect(row.missing_grants).toEqual([]);
  });

  it("without a grant: missing network:<host>, an inbox item; an org-layer host needs an admin", async () => {
    const s = await setup();
    s.dev.blocking.set("files.example.com", "device");
    s.dev.blocking.set("api.foo.com", "device");
    const taskId = await createTask(s);
    const run = await taskRun(s, taskId, false);
    await curlStep(s, run, taskId, ["files.example.com", "api.foo.com"], false);
    const [exec] = curlExecs(s.machine);
    expect(exec).toBeDefined();
    expect((exec?.args as DeviceExecArgs | undefined)?.grants).toBeUndefined();
    expect(await networkAsks(s.conversationId)).toEqual([]);
    await sql`UPDATE capybara.scheduled_task_runs SET status = 'completed', fired_at = now()
      WHERE id = ${run.taskRunId}`.execute(raw);
    const svc = k.app.get(ScheduledTasksService);
    const [item] = await svc.attentionFor(orgId, s.accountId);
    expect(item).toMatchObject({
      taskId,
      reason: "missing_grants",
      needsRole: [],
      needsAdmin: ["network:api.foo.com"],
      deviceRefuses: false,
    });
    expect([...(item?.missing ?? [])].sort()).toEqual([
      "network:api.foo.com",
      "network:files.example.com",
    ]);

    // granting the device-layer domain drops it; the org-layer one stays until an admin acts
    const res = await s.req({
      method: "POST",
      url: `${base()}/${taskId}/grants`,
      payload: { grants: [{ toolKey: "network:files.example.com" }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [after] = await svc.attentionFor(orgId, s.accountId);
    expect(after).toMatchObject({
      missing: ["network:api.foo.com"],
      needsAdmin: ["network:api.foo.com"],
    });
  });
});

describe("NetworkGrants with task grants", () => {
  it("run and task grants merge (source task); another person's device, a trial or another org get none", async () => {
    const s = await setup();
    const taskId = await createTask(s, ["network:files.example.com"]);
    const run = await taskRun(s, taskId, false);
    const grants = k.app.get(NetworkGrants);
    // a once-approved ask of the same run about the same device
    await sql`INSERT INTO capybara.approvals (id, org_id, conversation_id, run_id, call_id,
        tool_key, requested_for, status, scope, decided_by, decided_at, expires_at, spec_hash,
        attempt, kind, detail)
      VALUES (${randomUUID()}, ${orgId}, ${s.conversationId}, ${run.runId}, 'c1', 'Bash',
        ${s.accountId}, 'approved', 'once', ${s.accountId}, now(), now() + interval '1 day',
        'network', 1, 'network', ${JSON.stringify({
          deviceId: s.deviceId,
          hosts: [{ host: "img.example.com", port: 443 }],
          command: "curl",
          description: null,
          result: { content: "", isError: false },
          grantedHosts: ["img.example.com"],
        })})`.execute(raw);
    const merged = await grants.forExec({ orgId, runId: run.runId, deviceId: s.deviceId });
    expect(merged?.source).toEqual({ kind: "task", id: taskId, accountId: s.accountId });
    expect([...(merged?.hosts ?? [])].sort()).toEqual(["files.example.com", "img.example.com"]);
    expect((await grants.runState(run.runId, s.deviceId)).taskGranted).toEqual(
      new Set(["files.example.com"]),
    );

    // another member's device: the creator's approvals are not theirs to give
    const other = await setup();
    expect(
      await grants.forExec({ orgId, runId: run.runId, deviceId: other.deviceId }),
    ).toBeUndefined();
    // another org
    expect(
      await grants.forExec({ orgId: randomUUID(), runId: run.runId, deviceId: s.deviceId }),
    ).toBeUndefined();
    // a trial run is attended: its grants are the asks decided in it
    await sql`UPDATE capybara.runs SET status = 'completed' WHERE id = ${run.runId}`.execute(raw);
    const trial = await taskRun(s, taskId, true);
    expect(
      await grants.forExec({ orgId, runId: trial.runId, deviceId: s.deviceId }),
    ).toBeUndefined();
  });
});

describe("trial runs", () => {
  it("the creator's 「这次允许」 becomes a task grant; an unchecked host does not", async () => {
    const s = await setup();
    s.dev.blocking.set("files.example.com", "device");
    s.dev.blocking.set("img.example.com", "device");
    const taskId = await createTask(s);
    const run = await taskRun(s, taskId, true);
    const out = await curlStep(s, run, taskId, ["files.example.com", "img.example.com"], true);
    expect(out.kind).toBe("suspended");
    const ask = await waitFor(
      async () => (await networkAsks(s.conversationId)).find((a) => a.status === "pending"),
      15_000,
      "a pending network ask",
    );
    const res = await s.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${ask.id}/decision`,
      payload: { decision: "approve", scope: "once", hosts: ["files.example.com"] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await grantKeys(s, taskId)).map((g) => g.toolKey)).toEqual([
      "network:files.example.com",
    ]);
  });
});
