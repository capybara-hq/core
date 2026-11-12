import { randomUUID } from "node:crypto";
import type {
  DeviceExecArgs,
  DeviceFeature,
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
import { NetworkGrants } from "../../src/local-devices/network-grants.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { isPolicyGrantKey, tierGrantRefusal } from "../../src/schedules/grant-rules.js";
import { ScheduledTasksService } from "../../src/schedules/scheduled-tasks.service.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import { UNATTENDED_UNSANDBOXED_ERROR } from "../../src/schedules/unattended.js";
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
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";

/**
 * The `tier:open` task grant (sandbox dev tiers spec §11.4): the rule (only `tier:open`, only while
 * the org's ceiling is open), adding it on the task page, the unattended cap at `dev` on a local
 * device without it, the refusal of an unsandboxed device without it (recorded in
 * `missing_grants`, shown in the attention list) and the grant lifting both.
 */

const POLICY: DeviceLocalPolicySummary = {
  effectiveTier: "dev",
  isolation: "sandbox",
  localhost: "off",
  unixSockets: "off",
  allowedDomains: [],
  remoteGrants: "owner",
};
const OPEN = { egress: "allowlist" as const, allowHosts: ["*.example.com"] };

describe("tierGrantRefusal", () => {
  it("only tier:open, only under an open ceiling", () => {
    expect(tierGrantRefusal("tier:open", { ceiling: "open" })).toBeNull();
    expect(tierGrantRefusal("tier:open", { ceiling: "dev" })?.code).toBe("needs_admin");
    expect(tierGrantRefusal("tier:open", { ceiling: "strict" })?.code).toBe("needs_admin");
    expect(tierGrantRefusal("tier:dev", { ceiling: "open" })?.code).toBe("not_grantable");
    expect(tierGrantRefusal("tier:open", { ceiling: "open", deviceReachesOpen: false })?.code).toBe(
      "device_refuses",
    );
    expect(isPolicyGrantKey("tier:open")).toBe(true);
    expect(isPolicyGrantKey("network:a.example.com")).toBe(true);
    expect(isPolicyGrantKey("Bash")).toBe(false);
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
        sandbox: { limits: OPEN, tiers: { max: "open", default: "dev" } },
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

async function setup(
  policy: Partial<DeviceLocalPolicySummary> = {},
  features: DeviceFeature[] = ["networkReport", "policyOp", "tiers"],
): Promise<Setup> {
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
    features,
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

const results = async (conversationId: string) =>
  (await eventsOf(db, conversationId))
    .filter(
      (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
    )
    .map((e) => e.payload);

const grantKeys = async (s: Setup, taskId: string) => {
  const res = await s.req({ method: "GET", url: `${base()}/${taskId}/grants` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: { toolKey: string; specHash: string; stale: boolean }[] }).items;
};

const setOrgTier = (value: unknown) =>
  sql`UPDATE capybara.orgs SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{sandboxTier}',
    ${JSON.stringify(value)}::jsonb) WHERE id = ${orgId}`.execute(raw);

beforeEach(async () => {
  // the org follows the platform (ceiling open) unless a case lowers it
  await sql`UPDATE capybara.orgs SET settings = settings - 'sandboxTier' WHERE id = ${orgId}`.execute(
    raw,
  );
});

/** Ends a kernel run, so another can run in its conversation. */
const endRun = (run: { runId: string }) =>
  sql`UPDATE capybara.runs SET status = 'completed' WHERE id = ${run.runId}`.execute(raw);

const missingOf = async (taskRunId: string) =>
  (
    await db
      .selectFrom("scheduled_task_runs")
      .select("missing_grants")
      .where("id", "=", taskRunId)
      .executeTakeFirstOrThrow()
  ).missing_grants;

describe("adding the tier:open grant", { timeout: 60_000 }, () => {
  it("is taken under an open ceiling and stored without a tool; refused below it or for another tier", async () => {
    const s = await setup();
    const taskId = await createTask(s, ["tier:open"]);
    expect(await grantKeys(s, taskId)).toEqual([
      { toolKey: "tier:open", specHash: "tier", connectorId: null, stale: false },
    ]);
    let res = await s.req({
      method: "POST",
      url: `${base()}/${taskId}/grants`,
      payload: { grants: [{ toolKey: "tier:dev" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("schedule.grant_not_allowed");
    await setOrgTier({ max: "dev" });
    res = await s.req({
      method: "POST",
      url: base(),
      payload: {
        agentId: s.agentId,
        name: "Nightly",
        prompt: "Fetch.",
        trigger: { kind: "cron", expr: "0 9 * * *" },
        mode: "new",
        deviceId: s.deviceId,
        grants: [{ toolKey: "tier:open" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("schedule.grant_not_allowed");
    expect(res.body).toContain("only an organization admin");
  });

  it("is refused for a device whose program applies no sandbox levels", async () => {
    const s = await setup({}, ["networkReport", "policyOp"]);
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
        grants: [{ toolKey: "tier:open" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("schedule.grant_not_allowed");
    expect(res.body).toContain("without sandbox levels");
  });
});

describe("unattended runs on a local device", { timeout: 60_000 }, () => {
  const execs = (m: FakeMachine) =>
    m.frames.filter((f) => f.type === "req" && f.op === "exec") as KernelReq[];

  it("are capped at dev without tier:open; the grant lifts the cap", async () => {
    const s = await setup();
    const taskId = await createTask(s);
    const run = await taskRun(s, taskId, false);
    await curlStep(s, run, taskId, ["files.example.com"], false);
    const capped = execs(s.machine).at(-1)?.args as DeviceExecArgs | undefined;
    expect(capped?.limits).toMatchObject({ tier: "dev", defaultTier: "dev" });
    expect(await missingOf(run.taskRunId)).toEqual([]);

    await s.req({
      method: "POST",
      url: `${base()}/${taskId}/grants`,
      payload: { grants: [{ toolKey: "tier:open" }] },
    });
    await endRun(run);
    const run2 = await taskRun(s, taskId, false);
    await curlStep(s, run2, taskId, ["files.example.com"], false);
    const lifted = execs(s.machine).at(-1)?.args as DeviceExecArgs | undefined;
    expect(lifted?.limits).toMatchObject({ tier: "open", egress: "open" });
  });

  it("an unsandboxed device is refused without tier:open; the grant is missing, then granted", async () => {
    const s = await setup({ tier: "open", effectiveTier: "open", isolation: "none" });
    const taskId = await createTask(s);
    const run = await taskRun(s, taskId, false);
    const before = execs(s.machine).length;
    await curlStep(s, run, taskId, ["files.example.com"], false);
    // the curl command never reached the machine
    expect(
      execs(s.machine)
        .slice(before)
        .filter((f) => (f.args as DeviceExecArgs).command.startsWith("curl")),
    ).toEqual([]);
    const [r] = await results(s.conversationId);
    expect(r?.content).toContain(UNATTENDED_UNSANDBOXED_ERROR);
    expect(await missingOf(run.taskRunId)).toEqual(["tier:open"]);
    await sql`UPDATE capybara.scheduled_task_runs SET status = 'completed', fired_at = now()
      WHERE id = ${run.taskRunId}`.execute(raw);
    const svc = k.app.get(ScheduledTasksService);
    const item = (await svc.attentionFor(orgId, s.accountId)).find((i) => i.taskId === taskId);
    expect(item).toMatchObject({
      reason: "missing_grants",
      missing: ["tier:open"],
      needsAdmin: [],
    });

    // with the org's ceiling lowered, only an admin can help
    await setOrgTier({ max: "dev" });
    const low = (await svc.attentionFor(orgId, s.accountId)).find((i) => i.taskId === taskId);
    expect(low).toMatchObject({ missing: ["tier:open"], needsAdmin: ["tier:open"] });
    await setOrgTier({ max: "open" });

    const res = await s.req({
      method: "POST",
      url: `${base()}/${taskId}/grants`,
      payload: { grants: [{ toolKey: "tier:open" }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      (await svc.attentionFor(orgId, s.accountId)).find((i) => i.taskId === taskId),
    ).toBeUndefined();
    await endRun(run);
    const run2 = await taskRun(s, taskId, false);
    await curlStep(s, run2, taskId, ["files.example.com"], false);
    const last = execs(s.machine).at(-1)?.args as DeviceExecArgs | undefined;
    expect(last?.command.startsWith("curl")).toBe(true);
    expect(await missingOf(run2.taskRunId)).toEqual([]);
  });
});

describe("the unsandboxed gate reads isolation alone", { timeout: 60_000 }, () => {
  it("a summary the kernel cannot otherwise parse still reports isolation none", async () => {
    const s = await setup();
    const grants = k.app.get(NetworkGrants);
    expect(await grants.unsandboxed(s.deviceId)).toBe(false);
    await sql`UPDATE capybara.device_machines SET local_policy = '{"isolation":"none","tier":"x"}'::jsonb
      WHERE device_id = ${s.deviceId} AND revoked_at IS NULL`.execute(raw);
    expect(await grants.unsandboxed(s.deviceId)).toBe(true);
    await sql`UPDATE capybara.device_machines SET local_policy = '{"isolation":"sandbox"}'::jsonb
      WHERE device_id = ${s.deviceId} AND revoked_at IS NULL`.execute(raw);
    expect(await grants.unsandboxed(s.deviceId)).toBe(false);
  });
});
