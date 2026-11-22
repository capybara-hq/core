import { randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import {
  FakeDialInMachine,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import type { DeviceList, DeviceView } from "../../src/devices/devices.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { DialInRelay } from "../../src/dial-in/relay.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { RunExecution } from "../../src/runtime/run-execution.js";
import { ManagedDeviceContextRecorder } from "../../src/sandbox/managed-device-context.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { ScheduledTaskFirer } from "../../src/schedules/fire.js";
import { SCHED_SCAN_JOB } from "../../src/schedules/job-ids.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import { DEVICE_OFFLINE_TEXT } from "../../src/tools/builtins/sandbox/common.js";
import { type SandboxToolDeps, sandboxTools } from "../../src/tools/builtins/sandbox/index.js";
import type { BuiltinCallContext, BuiltinTool } from "../../src/tools/registry.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import {
  createAgent,
  createOrgWithProviders,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { startRun } from "../runtime/permission-context-fixture.js";

/**
 * A dial-in device handled through its provider like any other (device provider spec §5, §6.1;
 * phase 2 Task 13): the devices API, the sandbox tools and scheduled tasks never branch on a
 * device's location. Driven with the `fake-dial-in` fixture provider (the generic channel) and
 * `FakeDialInMachine`, never with the kernel's interim `@local`.
 */

const GRACE_SECONDS = 1;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let ownerId: string;
let owner: Req;
let orgId: string;
let url: string;
const open: FakeDialInMachine[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        devices: { maxPersonal: 50, dialIn: { reconnectGraceSeconds: GRACE_SECONDS } },
        extensions: [MODEL_FAKE],
      },
    ),
    { bootstrap: { dir: bootstrap.dir }, bootstrapManifest: bootstrap.manifest },
  );
  // the tests own the scheduled task runs: the worker's scan would add its own
  k.app.get(SchedulerRegistry).getCronJob(SCHED_SCAN_JOB).stop();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await enableExtensions(raw, orgId, "fake-dial-in");
  await waitFor(async () => k.app.get(DeviceProviders).forDevice("fake-dial-in") ?? null);
  url = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterEach(async () => {
  for (const m of open.splice(0)) await m.close();
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await bootstrap?.cleanup();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** A member with a `fake-dial-in` device and its signed-in machine's credential (not connected). */
async function member() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
    .id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const txHost = k.app.get(TransactionHost);
  const { id: deviceId } = await txHost.run(() =>
    k.app.get(DevicesService).createDialIn(orgId, accountId, "fake-dial-in", "Box"),
  );
  const issued = await txHost.run(() =>
    k.app.get(DialInMachines).issue({
      orgId,
      deviceId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.0.0",
    }),
  );
  return { accountId, deviceId, req: await session(k, login), ...issued };
}

/** Connects the member's machine: it answers every relayed operation with `answer`. */
async function connect(
  m: { deviceId: string; credential: string },
  answer: (body: { op: string; args: Record<string, unknown> }) => unknown = defaultAnswer,
): Promise<FakeDialInMachine> {
  const machine = await FakeDialInMachine.connect({
    url,
    credential: m.credential,
    hello: { revision: "r1", outsideSandbox: false },
  });
  open.push(machine);
  machine.onRequest((body) => answer(body as { op: string; args: Record<string, unknown> }));
  await waitFor(async () => k.app.get(DialInRelay).online(m.deviceId));
  return machine;
}

/** What the fake machine answers by default: a file system, an instance and empty commands. */
function defaultAnswer(body: { op: string }): unknown {
  switch (body.op) {
    case "exec":
      return { exitCode: 0, stdout: "on the machine\n", stderr: "", truncated: false };
    case "stat":
    case "readFile":
      return null;
    case "resume":
      return "resumed";
    default:
      return null;
  }
}

const viewOf = async (req: Req, id: string): Promise<DeviceView> => {
  const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/devices/${id}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { device: DeviceView }).device;
};

describe("a dial-in device through the devices API", () => {
  it("devices list shows dialIn and online for a fake-dial-in device and no machine-only fields", async () => {
    const m = await member();
    const list = async () => {
      const res = await m.req({ method: "GET", url: `/api/v1/orgs/${orgId}/devices` });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as DeviceList).items.find((e) => e.id === m.deviceId);
    };
    expect(await list()).toMatchObject({
      provider: "fake-dial-in",
      dialIn: true,
      available: true,
      online: false,
      machine: { id: m.machineId, name: "box", os: "linux", programVersion: "0.0.0" },
    });
    await connect(m);
    const item = await list();
    expect(item).toMatchObject({ dialIn: true, online: true });
    // the provider's report is what the page reads about it
    expect(item?.report).toMatchObject({
      description: { en: "Fake dial-in device" },
      reset: false,
    });
    for (const key of ["source", "network", "ownerCeiling", "sessionIsolation"])
      expect(item).not.toHaveProperty(key);
    expect(item?.machine).not.toHaveProperty("mode");
  });

  it("the device network route accepts a dial-in device", async () => {
    const m = await member();
    const res = await m.req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/devices/${m.deviceId}`,
      payload: { network: { mode: "none" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { device: DeviceView }).device.sandbox).toMatchObject({
      network: "none",
      ownNetwork: "none",
    });
  });

  it("a provider whose report offers no reset refuses a file reset with its description", async () => {
    const m = await member();
    await connect(m);
    // the hello stored the provider's report
    await waitFor(async () => (await viewOf(m.req, m.deviceId)).report !== null);
    const res = await m.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/devices/${m.deviceId}/files/reset`,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: "device.files_on_device",
        message: expect.stringContaining("Fake dial-in device"),
      },
    });
    expect(res.body).not.toContain("capybara-device");
  });
});

describe("a dial-in device through the sandbox tools", () => {
  /** A conversation of `m` bound to its device with a running, claimed run, on the managed route. */
  async function conversation(m: { accountId: string; deviceId: string }) {
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${m.accountId}, 'org', 1)`.execute(raw);
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id)
      VALUES (${conversationId}, ${orgId}, ${agentId}, ${m.accountId}, ${m.deviceId})`.execute(raw);
    const { runId, claim } = await startRun(k, raw, conversationId, m.accountId);
    const deps: SandboxToolDeps = {
      sandbox: k.app.get(SandboxService),
      devices: k.app.get(ConversationDevices),
      attachments: { listForConversation: async () => [], openForConversation: async () => null },
      // biome-ignore lint/suspicious/noExplicitAny: never called (no attachments)
      storage: {} as any,
      eventLog: k.app.get(EventLog),
      config: k.app.get(KernelConfigService),
      managedDeviceContext: k.app.get(ManagedDeviceContextRecorder),
      managedDeviceContextRequired: true,
    };
    const tools = sandboxTools(deps);
    return async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      const tool = tools.find((t) => t.spec.name === name) as BuiltinTool;
      const callId = randomUUID();
      await k.app.get(EventLog).append(conversationId, [
        {
          type: "tool_call_started",
          runId,
          idemKey: `started:${callId}`,
          payload: { step: 1, callId, toolKey: name, specHash: "test" },
        } as never,
      ]);
      return k.app.get(RunExecution).withClaim(
        claim,
        () => true,
        () =>
          tool.run(input, {
            orgId,
            conversationId,
            runId,
            callId,
            accountId: m.accountId,
            agentId,
            signal: AbortSignal.timeout(60_000),
            executionClaim: claim,
          } as BuiltinCallContext),
      );
    };
  }

  const toolError = async (p: Promise<unknown>): Promise<string> => {
    const e = await p.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(ToolError);
    return (e as ToolError).message;
  };

  it("a command runs on the machine through the generic channel", async () => {
    const m = await member();
    const ops: string[] = [];
    await connect(m, (body) => {
      ops.push(body.op);
      return defaultAnswer(body);
    });
    const run = await conversation(m);
    expect(JSON.stringify(await run("Bash", { command: "echo hi" }))).toContain("on the machine");
    // the lifecycle and the command went to the provider, which relayed them to its machine
    expect(ops).toContain("create");
    expect(ops).toContain("exec");
  });

  it("an offline machine is the tools' offline text, naming no program", async () => {
    const m = await member();
    const machine = await connect(m);
    const run = await conversation(m);
    await run("Bash", { command: "true" });
    await machine.close();
    await waitFor(async () => !(await k.app.get(DialInRelay).online(m.deviceId)));
    const text = await toolError(run("Bash", { command: "true" }));
    expect(text).toBe(DEVICE_OFFLINE_TEXT);
    expect(text).not.toMatch(/capybara-device/);
  });

  it("a revoked machine answers the disconnected text without reaching the provider", async () => {
    const m = await member();
    const ops: string[] = [];
    const machine = await connect(m, (body) => {
      ops.push(body.op);
      return defaultAnswer(body);
    });
    const run = await conversation(m);
    await run("Bash", { command: "true" });
    await k.app.get(DialInMachines).revoke(orgId, m.accountId, m.deviceId);
    await machine.closed;
    const sent = ops.length;
    const text = await toolError(run("Bash", { command: "true" }));
    expect(text).toMatch(/was disconnected.*sign that machine in to this device again/);
    expect(text).not.toMatch(/capybara-device/);
    expect(ops.length).toBe(sent);
  });
});

describe("a dial-in device in scheduled tasks", () => {
  it("a schedule on an offline dial-in device does not fire and records device offline", async () => {
    const m = await member();
    const agentId = await createAgent(owner, orgId);
    const store = new ScheduledTaskStore();
    const task = await store.insertTask(db, {
      id: randomUUID(),
      orgId,
      accountId: m.accountId,
      agentId,
      name: "Nightly",
      prompt: "hello",
      trigger: { kind: "cron", expr: "*/5 * * * *", timeZone: "UTC" },
      mode: "new",
      conversationId: null,
      chat: null,
      model: null,
      effort: null,
      deviceId: m.deviceId,
      status: "active",
      nextRunAt: new Date(Date.now() + 86_400_000),
      jitterSeconds: 0,
      expiresAt: null,
    });
    const fire = async () => {
      const r = await store.insertRun(db, {
        id: randomUUID(),
        taskId: task.id,
        orgId,
        scheduledFor: new Date(),
        trial: false,
      });
      if (!r) throw new Error("tick taken");
      await k.app.get(ScheduledTaskFirer).fire(r.id);
      return (await store.updateRun(db, r.id, {})) ?? Promise.reject(new Error("no task run"));
    };
    // its machine is not connected: no conversation, the run says why
    expect(await fire()).toMatchObject({ status: "skipped", skipReason: "device_offline" });
    const started = await db
      .selectFrom("conversations")
      .select("id")
      .where("scheduled_task_id", "=", task.id)
      .execute();
    expect(started).toEqual([]);
  });
});
