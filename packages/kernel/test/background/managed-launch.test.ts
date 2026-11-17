import { randomUUID } from "node:crypto";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxBackground,
  type SandboxExecutionRef,
  type SandboxOperationScope,
  type SandboxPermissionSupport,
  type SandboxProvider,
  SandboxScopeDeniedError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { backgroundMaxSeconds } from "../../src/background/launch.js";
import { BackgroundTaskPollJob } from "../../src/background/poll.job.js";
import { BackgroundTaskStopper } from "../../src/background/stop.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import type { LockService } from "../../src/infra/lock/lock.service.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { LocalDeviceProvider } from "../../src/local-devices/local-device-provider.js";
import { createLogger } from "../../src/log.js";
import type { ExecutionClaim } from "../../src/runtime/run-execution.js";
import { operationIdFor, SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { SandboxOperationReconcileJob } from "../../src/sandbox/operation-reconcile.job.js";
import { PermissionCallGrants } from "../../src/sandbox/permission-call-grants.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { runInBackgroundManaged } from "../../src/tools/builtins/sandbox/bash.js";
import type { SandboxToolDeps } from "../../src/tools/builtins/sandbox/common.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { seedInstalledEvidence } from "../helpers/installed-evidence.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { enableModelProviders, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Durable managed background launches (permission runtime cutover phase 8.2): the launch identity
 * persisted before dispatch, exact typed refs, cancellation races and genuinely authorized
 * artifacts, through the real operation facade, intents and background store.
 */

const MAX_TASKS = 2;
const GENERATION = 1700000000000;
const PROVIDER = "@managed-launch-test";
const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let accounts: AccountsService;
let owner: Account;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      // API-only: no worker consumes the outbox while the tests assert on it
      roles: ["api"],
      sandbox: { background: { maxTasks: MAX_TASKS } },
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  redis = new Redis(rd.url);
  accounts = accountsFor(kernelDb(raw));
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface StartCall {
  scope: SandboxOperationScope;
  args: Parameters<SandboxBackground["start"]>[2];
}

/**
 * A provider that owns background executions by exact operation id: a repeated start of the same
 * operation returns the same ref and launches nothing new (the SDK contract). `launches` counts
 * actual launches; `hooks` inject denials before effects and losses after them.
 */
function managedProvider() {
  const calls: StartCall[] = [];
  const launched = new Map<string, SandboxExecutionRef>();
  const inflight = new Map<string, Promise<SandboxExecutionRef>>();
  const revoked: string[] = [];
  const stops: SandboxExecutionRef[] = [];
  let stopOutcome: Awaited<ReturnType<SandboxBackground["stop"]>> = { outcome: "stopped" };
  let statusOf: Awaited<ReturnType<SandboxBackground["status"]>> = { state: "running" };
  const hooks: {
    beforeEffect?: ((c: StartCall) => Promise<void>) | undefined;
    onCall?: ((c: StartCall) => void) | undefined;
    afterEffect?: ((c: StartCall) => Promise<void>) | undefined;
  } = {};
  const background: SandboxBackground = {
    async start(h, scope, args) {
      const call = { scope, args };
      calls.push(call);
      hooks.onCall?.(call);
      // Concurrency-safe ownership by exact operation id: a concurrent or later start of the same
      // operation joins the first and never launches twice.
      const owned = inflight.get(scope.operationId);
      if (owned) return owned;
      const launch = (async () => {
        await hooks.beforeEffect?.(call);
        const ref: SandboxExecutionRef = {
          executionId: `x-${scope.operationId.slice(0, 12)}`,
          operationId: scope.operationId,
          instanceId: h.id,
          instanceGeneration: String(GENERATION),
        };
        launched.set(scope.operationId, ref);
        return ref;
      })();
      inflight.set(scope.operationId, launch);
      // a start refused or failed before its effect owns nothing yet
      launch.catch(() => {
        if (!launched.has(scope.operationId)) inflight.delete(scope.operationId);
      });
      const ref = await launch;
      await hooks.afterEffect?.(call);
      return ref;
    },
    async status() {
      return statusOf;
    },
    async tail() {
      return { data: new Uint8Array(), truncated: false };
    },
    async readOutput(_h, _ref, opts) {
      return {
        data: new Uint8Array(),
        offset: opts.offset,
        nextOffset: opts.offset,
        totalBytes: 0,
      };
    },
    async stop(_h, ref) {
      stops.push(ref);
      return stopOutcome;
    },
  };
  const impl = {
    concurrentExec: true,
    async permissionSupport() {
      return {
        version: 1,
        restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        fullAccess: true,
        background: true,
      };
    },
    async operation() {
      throw new Error("A managed launch dispatches no native operation");
    },
    async prepare() {
      return {
        async readFile() {
          return null;
        },
        async writeFile() {},
        async stat() {
          return null;
        },
      };
    },
    async revokeOperation(_h: unknown, ref: { operationId: string }) {
      revoked.push(ref.operationId);
    },
    background,
  } as unknown as SandboxProvider;
  return {
    impl,
    calls,
    launched,
    revoked,
    stops,
    hooks,
    /** What the next exact stops answer. */
    stopWith(r: Awaited<ReturnType<SandboxBackground["stop"]>>) {
      stopOutcome = r;
    },
    /** What the exact status answers. */
    statusWith(r: Awaited<ReturnType<SandboxBackground["status"]>>) {
      statusOf = r;
    },
  };
}

async function createOrg(): Promise<{ orgId: string; agentId: string; conversationId: string }> {
  const req = asUser(k.http, cookieJar());
  expect(
    (
      await req({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { login: "owner", password: PW },
      })
    ).statusCode,
  ).toBe(200);
  const org = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: randomUUID() } });
  const orgId = (org.json() as { org: { id: string } }).org.id;
  await enableModelProviders(k, orgId);
  const agent = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  const agentId = (agent.json() as { agent: { id: string } }).agent.id;
  const conv = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations`,
    payload: { agentId },
  });
  return {
    orgId,
    agentId,
    conversationId: (conv.json() as { conversation: { id: string } }).conversation.id,
  };
}

/** One org, one local device running instance, one root conversation with one running run. */
async function fixture(opts: { project?: string } = {}) {
  const { orgId, agentId, conversationId } = await createOrg();
  const db = kernelDb(raw);
  const provider = managedProvider();
  k.app
    .get(SandboxProviders)
    .register({ plugin: PROVIDER, version: "test-1", impl: provider.impl });
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: owner.id,
      source: "local",
      provider: PROVIDER,
      name: "Laptop",
    })
    .execute();
  await db
    .insertInto("device_machines")
    .values({
      org_id: orgId,
      device_id: deviceId,
      account_id: owner.id,
      credential_hash: randomUUID(),
      name: "Laptop",
      os: "darwin",
      arch: "arm64",
      features: ["mode", "projects"],
      roots: JSON.stringify({ workspace: "/work" }),
      home: "/home/owner",
      local_policy: JSON.stringify({ mode: "auto", allowedDomains: [] }),
    })
    .execute();
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", conversationId)
    .execute();
  if (opts.project) {
    await db
      .insertInto("device_projects")
      .values({ device_id: deviceId, name: "app", path: opts.project, created_by: owner.id })
      .execute();
    // Fixture setup intentionally writes the otherwise immutable project binding.
    await sql`UPDATE capybara.conversations SET project_name = 'app',
      project_path = ${opts.project} WHERE id = ${conversationId}`.execute(raw);
  }
  const roots = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/work" };
  await db
    .insertInto("device_instances")
    .values({
      device_id: deviceId,
      org_id: orgId,
      provider: PROVIDER,
      status: "running",
      handle: JSON.stringify({ id: deviceId, roots }),
      created_at: new Date(GENERATION),
      fs_status: "ready",
      had_instance: true,
      instance_limits: JSON.stringify({
        mode: "auto",
        network: { kind: "open-public", hosts: [] },
      }),
    })
    .execute();
  // admission proves the installed environment (B-16): the provider's report and its binding
  await seedInstalledEvidence(k, raw, {
    orgId,
    deviceId,
    provider: PROVIDER,
    version: "test-1",
    report: await (provider.impl.permissionSupport as () => Promise<SandboxPermissionSupport>)(),
  });
  const runId = randomUUID();
  const callId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: conversationId,
      execution_id: randomUUID(),
      trigger_account_id: owner.id,
      status: "running",
      agent_version: 1,
      trigger_seq: 0,
    })
    .execute();
  const event = async (type: string, payload: object) => {
    // the launch appends its own events: continue after the conversation's last one
    const { last_seq } = await db
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
    const seq = Number(last_seq) + 1;
    await db
      .insertInto("conversation_events")
      .values({
        conversation_id: conversationId,
        run_id: runId,
        seq,
        type,
        payload: JSON.stringify(payload),
      })
      .execute();
    await db
      .updateTable("conversations")
      .set({ last_seq: seq })
      .where("id", "=", conversationId)
      .execute();
  };
  if (opts.project) await event("project_root", { root: opts.project });
  await event("tool_call_started", { callId, toolKey: "Bash" });
  const claimFor = async (): Promise<ExecutionClaim> => {
    const run = await db
      .selectFrom("runs")
      .select("execution_id")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    if (!run.execution_id) throw new Error("the run has no execution claim");
    return { orgId, conversationId, rootId: conversationId, runId, executionId: run.execution_id };
  };
  /** A new execution claim of the same run (a resumed worker retrying the same call). */
  const reclaim = async () => {
    await db
      .updateTable("runs")
      .set({ execution_id: randomUUID() })
      .where("id", "=", runId)
      .execute();
  };
  const deps: SandboxToolDeps = {
    sandbox: k.app.get(SandboxService),
    devices: k.app.get(ConversationDevices),
    background: k.app.get(BackgroundTaskStore),
    attachments: {
      listForConversation: async () => [],
      openForConversation: async () => {
        throw new Error("no attachments");
      },
    },
    storage: {} as SandboxToolDeps["storage"],
    eventLog: k.app.get(EventLog),
    config: k.app.get(KernelConfigService),
  };
  const ctxFor = async (claim?: ExecutionClaim): Promise<BuiltinCallContext> => ({
    orgId,
    accountId: owner.id,
    agentId,
    conversationId,
    callId,
    runId,
    signal: new AbortController().signal,
    executionClaim: claim ?? (await claimFor()),
  });
  const run = async (input: { command: string; timeout?: number }, claim?: ExecutionClaim) =>
    runInBackgroundManaged(deps, await ctxFor(claim), {
      ...input,
      description: "Serve",
      run_in_background: true,
    });
  /** A second Bash call of the same run (a sibling task in the same tree). */
  const runCall = async (call: string, input: { command: string }) => {
    await event("tool_call_started", { callId: call, toolKey: "Bash" });
    return runInBackgroundManaged(
      deps,
      { ...(await ctxFor()), callId: call },
      { ...input, description: "Serve", run_in_background: true },
    );
  };
  const opFor = (call: string) => operationIdFor({ claim: { runId }, callId: call, ordinal: 0 });
  const outcome = (p: Promise<unknown>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const operationId = operationIdFor({ claim: { runId }, callId, ordinal: 0 });
  const task = () =>
    db
      .selectFrom("background_tasks")
      .selectAll()
      .where("run_id", "=", runId)
      .where("call_id", "=", callId)
      .executeTakeFirst();
  const intent = () =>
    db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirst();
  // the owed jobs as written in their transactions (the fast path may deliver and delete rows)
  const added: { name: string; jobId: string }[] = [];
  const outbox = k.app.get(OutboxService);
  const add = outbox.add.bind(outbox);
  vi.spyOn(outbox, "add").mockImplementation(async (job) => {
    added.push({ name: job.name, jobId: job.jobId });
    return add(job);
  });
  const revokeJobs = async () =>
    added.filter((j) => j.name === "sandbox-operation-revoke" && j.jobId.includes(operationId));
  const jobs = () => added;
  return {
    orgId,
    deviceId,
    conversationId,
    runId,
    callId,
    db,
    provider,
    claimFor,
    reclaim,
    run,
    runCall,
    opFor,
    outcome,
    operationId,
    task,
    intent,
    revokeJobs,
    jobs,
  };
}

/** The reconcile job as the maintenance consumer builds it. */
const reconcileJob = () =>
  new SandboxOperationReconcileJob(
    k.app.get(SandboxOperationIntents),
    k.app.get(KernelDb),
    k.app.get(SandboxProviders),
    k.app.get(SandboxService),
    k.app.get(BackgroundTaskStore),
    k.app.get(BackgroundTaskStopper),
  );

/** Publishes an actual ceiling write at `level`, revoking what it selects. */
async function narrow(
  subject: { orgId: string; deviceId?: string; rootConversationId?: string },
  level: "device" | "root",
) {
  await k.app.get(TransactionHost).run(async () => {
    const ceiling = k.app.get(PermissionCeilingWrites);
    await ceiling.lock(subject, level);
    await ceiling.publishLocked(subject, level);
  });
}

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text: string }[] }).content.map((c) => c.text).join("\n");

describe("managed background launch identity", () => {
  it("persists the full reservation before dispatch and records the typed ref on acknowledgement", async () => {
    const f = await fixture();
    let seenAtDispatch: Awaited<ReturnType<typeof f.task>>;
    f.provider.hooks.beforeEffect = async () => {
      seenAtDispatch = await f.task();
    };
    const result = await f.run({ command: "npm run dev" });
    const row = await f.task();
    expect(row).toBeDefined();
    if (!row || !seenAtDispatch) throw new Error("no reservation");
    // every identity field was durable before the provider saw the start
    expect(seenAtDispatch).toMatchObject({
      launch_state: "dispatched",
      operation_id: f.operationId,
      task_tag: f.operationId,
      instance_id: f.deviceId,
      instance_provider: PROVIDER,
      instance_provider_version: "test-1",
      instance_generation: String(GENERATION),
      working_root: "/work",
      output_path: `/work/.capybara/tasks/${row.id}.out`,
      execution_ref: null,
    });
    expect(seenAtDispatch.input_digest).toMatch(/\S/);
    expect(seenAtDispatch.run_execution_id).toBe((await f.claimFor()).executionId);
    expect(seenAtDispatch.profile_revision).toBe(0);
    expect(seenAtDispatch.ceiling_revision).toMatch(/\S/);
    expect(seenAtDispatch.retain_until).not.toBeNull();
    const [call] = f.provider.calls;
    expect(call?.args).toMatchObject({
      taskId: row.id,
      cwd: "/work",
      outputPath: `/work/.capybara/tasks/${row.id}.out`,
      retainUntilMs: row.retain_until?.getTime(),
    });
    expect(row.launch_state).toBe("acknowledged");
    expect(row.execution_ref).toEqual(f.provider.launched.get(f.operationId));
    expect(new Date(row.sandbox_created_at ?? 0).getTime()).toBe(GENERATION);
    expect(row.sid).toBeNull();
    const i = await f.intent();
    expect(i?.state).toBe("background-running");
    expect(i?.execution_ref).toEqual(row.execution_ref);
    expect(i?.result).toBeNull();
    expect(textOf(result)).toContain(`Output: /work/.capybara/tasks/${row.id}.out`);
    // a retry of the acknowledged call returns the recorded ref without a new start
    await f.reclaim();
    expect(textOf(await f.run({ command: "npm run dev" }))).toContain(row.id);
    expect(f.provider.calls).toHaveLength(1);
  });

  it("a lost start acknowledgement launches once; the retry of the same call returns the same files and ref", async () => {
    const f = await fixture();
    let lose = true;
    f.provider.hooks.afterEffect = async () => {
      if (lose) {
        lose = false;
        throw new Error("connection dropped after the device launched");
      }
    };
    const first = await f.outcome(f.run({ command: "npm run dev" }));
    expect(first.ok).toBe(false);
    const lost = await f.task();
    if (!lost) throw new Error("no reservation");
    expect(lost.launch_state).toBe("dispatched");
    expect(lost.execution_ref).toBeNull();
    expect(lost.status).toBe("running");
    // the output path is not advertised before the acknowledgement
    expect(String((first as { error: unknown }).error)).not.toContain(lost.output_path);
    expect((await f.intent())?.state).toBe("started-or-unknown");
    // the same call on a newly claimed execution reconciles the same identity
    await f.reclaim();
    const retried = await f.run({ command: "npm run dev" });
    const after = await f.task();
    expect(f.provider.launched.size).toBe(1);
    expect(f.provider.calls).toHaveLength(2);
    expect(f.provider.calls[1]?.scope.operationId).toBe(f.provider.calls[0]?.scope.operationId);
    const { signal: _a, ...firstArgs } = f.provider.calls[0]?.args ?? { signal: null };
    const { signal: _b, ...retryArgs } = f.provider.calls[1]?.args ?? { signal: null };
    expect(retryArgs).toEqual(firstArgs);
    expect(after).toMatchObject({
      id: lost.id,
      output_path: lost.output_path,
      launch_state: "acknowledged",
      execution_ref: f.provider.launched.get(f.operationId),
    });
    expect(textOf(retried)).toContain(lost.output_path);
    expect(
      await f.db
        .selectFrom("background_tasks")
        .select("id")
        .where("run_id", "=", f.runId)
        .execute(),
    ).toHaveLength(1);
  });

  it("recovers a lost acknowledgement after the launching run ended, without a new identity", async () => {
    const f = await fixture();
    f.provider.hooks.afterEffect = async () => {
      throw new Error("acknowledgement lost");
    };
    expect((await f.outcome(f.run({ command: "sleep 100" }))).ok).toBe(false);
    f.provider.hooks.afterEffect = undefined;
    await f.db.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
    await reconcileJob().reconcile(f.operationId);
    const row = await f.task();
    expect(row?.launch_state).toBe("acknowledged");
    expect(row?.execution_ref).toEqual(f.provider.launched.get(f.operationId));
    expect(f.provider.launched.size).toBe(1);
    expect(new Set(f.provider.calls.map((c) => c.scope.operationId))).toEqual(
      new Set([f.operationId]),
    );
    const i = await f.intent();
    expect(i?.state).toBe("background-running");
    expect(i?.execution_id.startsWith("recovery-")).toBe(true);
  });

  it("an unreachable instance keeps the uncertainty durable and defers recovery", async () => {
    const f = await fixture();
    f.provider.hooks.afterEffect = async () => {
      throw new Error("acknowledgement lost");
    };
    expect((await f.outcome(f.run({ command: "sleep 100" }))).ok).toBe(false);
    await f.db
      .updateTable("device_instances")
      .set({ status: "suspended" })
      .where("device_id", "=", f.deviceId)
      .execute();
    await reconcileJob().reconcile(f.operationId);
    expect((await f.task())?.launch_state).toBe("dispatched");
    expect((await f.intent())?.state).toBe("started-or-unknown");
    expect(f.jobs().some((j) => j.jobId.includes(`${f.operationId}-recover-1`))).toBe(true);
    expect(f.provider.calls).toHaveLength(1);
  });

  it("the same operation with changed input is rejected with zero further launches", async () => {
    const f = await fixture();
    await f.run({ command: "npm run dev" });
    await f.reclaim();
    await expect(f.run({ command: "rm -rf /" })).rejects.toThrow(/different command/);
    expect(f.provider.calls).toHaveLength(1);
    // at the facade, the same stable id with a changed start input is refused before effects
    const row = await f.task();
    if (!row?.retain_until) throw new Error("no reservation");
    const claim = await f.claimFor();
    const service = k.app.get(SandboxService);
    const changed = service.withOperations(
      {
        orgId: f.orgId,
        deviceId: f.deviceId,
        holderConversationId: f.conversationId,
        actor: { accountId: owner.id, conversationId: f.conversationId, runId: f.runId },
      },
      { claim, callId: f.callId, deadlineMs: Date.now() + 30_000 },
      async (h, p, _i, signal) =>
        p.backgroundStart?.(h, {
          command: "npm run dev",
          cwd: "/work",
          timeoutMs: 1000,
          maxOutputBytes: 1024,
          taskId: row.id,
          outputPath: row.output_path,
          retainUntilMs: row.retain_until?.getTime() ?? 0,
          signal,
        }),
      new AbortController().signal,
    );
    await expect(changed).rejects.toThrow(/different input/);
    expect(f.provider.calls).toHaveLength(1);
  });

  it("a stale invocation launches nothing and cannot settle the current claim's reservation", async () => {
    const f = await fixture();
    const stale = await f.claimFor();
    await f.reclaim();
    await expect(f.run({ command: "npm run dev" }, stale)).rejects.toThrow();
    expect(f.provider.calls).toHaveLength(0);
    expect(await f.task()).toMatchObject({ status: "running", launch_state: "pending" });
    expect(["pending", "admitted", undefined]).toContain((await f.intent())?.state);
    // the current claim's retry of the same call launches once from the same reservation
    const id = (await f.task())?.id;
    expect(textOf(await f.run({ command: "npm run dev" }))).toContain(`${id}`);
    expect(f.provider.launched.size).toBe(1);
  });

  it("a stop claimed before dispatch launches nothing and ends the reservation stopped", async () => {
    const f = await fixture();
    const intents = k.app.get(SandboxOperationIntents);
    const admit = intents.admit.bind(intents);
    const spy = vi.spyOn(intents, "admit").mockImplementation(async (ctx, invocation) => {
      const row = await f.task();
      if (row) await k.app.get(BackgroundTaskStore).claimStop(row.id);
      return admit(ctx, invocation);
    });
    try {
      await expect(f.run({ command: "npm run dev" })).rejects.toThrow(/not started/);
    } finally {
      spy.mockRestore();
    }
    expect(f.provider.calls).toHaveLength(0);
    expect(await f.task()).toMatchObject({ status: "stopped", launch_state: "terminal" });
    expect(await f.intent()).toMatchObject({ state: "revoked", outcome_unknown: false });
  });

  it("a stop claimed during an in-flight start attaches the ref to an owed exact cancellation", async () => {
    const f = await fixture();
    const entered = barrier();
    const release = barrier();
    f.provider.hooks.afterEffect = async () => {
      entered.resolve();
      await release.promise;
    };
    const work = f.outcome(f.run({ command: "npm run dev" }));
    await entered.promise;
    const row = await f.task();
    if (!row) throw new Error("no reservation");
    expect(await k.app.get(BackgroundTaskStore).claimStop(row.id)).toBe(true);
    release.resolve();
    const r = await work;
    expect(r.ok).toBe(false);
    expect(String((r as { error: unknown }).error)).toMatch(/is being stopped/);
    expect(await f.task()).toMatchObject({
      launch_state: "cancel-pending",
      status: "running",
      execution_ref: f.provider.launched.get(f.operationId),
    });
    expect(await f.intent()).toMatchObject({ state: "revoked" });
    expect(await f.revokeJobs()).toHaveLength(1);
    expect(f.provider.launched.size).toBe(1);
  });

  it("owner narrowing before the acknowledgement keeps the revocation and owes an exact cancellation", async () => {
    const f = await fixture();
    const entered = barrier();
    const release = barrier();
    f.provider.hooks.afterEffect = async () => {
      entered.resolve();
      await release.promise;
    };
    const work = f.outcome(f.run({ command: "npm run dev" }));
    await entered.promise;
    await narrow({ orgId: f.orgId, deviceId: f.deviceId }, "device");
    expect((await f.intent())?.state).toBe("revoked");
    release.resolve();
    const r = await work;
    expect(r.ok).toBe(false);
    // never resurrected as running authority
    expect(await f.intent()).toMatchObject({
      state: "revoked",
      execution_ref: f.provider.launched.get(f.operationId),
    });
    expect(await f.task()).toMatchObject({
      launch_state: "cancel-pending",
      execution_ref: f.provider.launched.get(f.operationId),
    });
    expect((await f.revokeJobs()).length).toBeGreaterThanOrEqual(1);
    await reconcileJob().revoke(f.operationId);
    // the ref is known: the exact stop of the task, not the operation revoke (8.4 B3)
    expect(f.provider.stops).toEqual([f.provider.launched.get(f.operationId)]);
    expect(f.provider.revoked).toEqual([]);
    expect(await f.intent()).toMatchObject({ revoke_acknowledged: true });
  });

  it("acknowledged authority survives a real profile change and launch-run completion, not owner narrowing", async () => {
    const f = await fixture();
    await f.run({ command: "npm run dev" });
    await f.db.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
    // the real profile writer only bumps the root epoch; started work keeps its starting envelope
    await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, owner.id, {
      profile: "request-approval",
      expectedRevision: 0,
    });
    expect((await f.intent())?.state).toBe("background-running");
    expect((await f.task())?.launch_state).toBe("acknowledged");
    await narrow({ orgId: f.orgId, deviceId: f.deviceId }, "device");
    expect((await f.intent())?.state).toBe("revoked");
    expect(await f.task()).toMatchObject({ launch_state: "cancel-pending", status: "running" });
    expect(await f.revokeJobs()).toHaveLength(1);
  });

  it("the reservation cap refuses a new launch with zero effects; a retry takes no second slot", async () => {
    const f = await fixture();
    await f.run({ command: "first" });
    await f.reclaim();
    // the same call again: the persisted reservation, not a second slot
    await f.run({ command: "first" });
    expect(
      await f.db
        .selectFrom("background_tasks")
        .select("id")
        .where("status", "=", "running")
        .execute(),
    ).toHaveLength(1);
    // fill the tree's remaining slot with another running task
    await f.db
      .insertInto("background_tasks")
      .values({
        id: "bt_aaaaaa",
        org_id: f.orgId,
        conversation_id: f.conversationId,
        sandbox_conversation_id: f.conversationId,
        device_id: f.deviceId,
        run_id: randomUUID(),
        call_id: randomUUID(),
        trigger_account_id: owner.id,
        description: "other",
        command: "other",
        sid: "123",
        output_path: "/work/.capybara/tasks/bt_aaaaaa.out",
        deadline_at: new Date(Date.now() + 60_000),
        sandbox_created_at: new Date(GENERATION),
      })
      .execute();
    const callId = randomUUID();
    const { last_seq } = await f.db
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", f.conversationId)
      .executeTakeFirstOrThrow();
    await f.db
      .insertInto("conversation_events")
      .values({
        conversation_id: f.conversationId,
        run_id: f.runId,
        seq: Number(last_seq) + 1,
        type: "tool_call_started",
        payload: JSON.stringify({ callId, toolKey: "Bash" }),
      })
      .execute();
    const deps = {
      sandbox: k.app.get(SandboxService),
      devices: k.app.get(ConversationDevices),
      background: k.app.get(BackgroundTaskStore),
      attachments: { listForConversation: async () => [], openForConversation: async () => null },
      storage: {},
      eventLog: k.app.get(EventLog),
      config: k.app.get(KernelConfigService),
    } as unknown as SandboxToolDeps;
    await expect(
      runInBackgroundManaged(
        deps,
        {
          orgId: f.orgId,
          accountId: owner.id,
          agentId: "a",
          conversationId: f.conversationId,
          callId,
          runId: f.runId,
          signal: new AbortController().signal,
          executionClaim: await f.claimFor(),
        },
        { command: "second", description: "second", run_in_background: true },
      ),
    ).rejects.toThrow(`${MAX_TASKS} background tasks are already running`);
    expect(f.provider.calls).toHaveLength(1);
    expect(
      await f.db
        .selectFrom("background_tasks")
        .select("id")
        .where("call_id", "=", callId)
        .execute(),
    ).toHaveLength(0);
  });

  it("clamps the task to the background maximum duration in the persisted deadline and start input", async () => {
    const f = await fixture();
    const max = backgroundMaxSeconds(k.app.get(KernelConfigService).get()) * 1000;
    const result = await f.run({ command: "npm run dev", timeout: max * 10 });
    const row = await f.task();
    if (!row) throw new Error("no task");
    expect(f.provider.calls[0]?.args.timeoutMs).toBe(max);
    expect(new Date(row.deadline_at).getTime() - new Date(row.started_at).getTime()).toBe(max);
    expect(textOf(result)).toContain("lowered");
  });

  it("places the artifact under a project outside the workspace when neither workspace nor tmp is writable", async () => {
    const project = "/home/owner/app";
    const f = await fixture({ project });
    await f.run({ command: "npm run dev" });
    const row = await f.task();
    if (!row) throw new Error("no task");
    const [call] = f.provider.calls;
    if (!call) throw new Error("no start");
    expect(call.scope.filesystem).toEqual({
      kind: "scoped",
      readRoots: [project],
      writeRoots: [project],
    });
    expect(call.args.cwd).toBe(project);
    expect(call.args.outputPath).toBe(`${project}/.capybara/tasks/${row.id}.out`);
    expect(row.output_path).toBe(call.args.outputPath);
    expect(JSON.stringify(call.args)).not.toMatch(/\/work|\/tmp/);
  });

  it("a denied or swapped artifact parent launches nothing, settles the task and adds no authority", async () => {
    const f = await fixture();
    f.provider.hooks.beforeEffect = async () => {
      throw new SandboxScopeDeniedError("The task directory parent is a symbolic link");
    };
    const r = await f.outcome(f.run({ command: "npm run dev" }));
    expect(r.ok).toBe(false);
    expect((r as { error: unknown }).error).toBeInstanceOf(ToolError);
    expect(String((r as { error: unknown }).error)).toMatch(/symbolic link/);
    expect(f.provider.launched.size).toBe(0);
    expect(f.provider.calls).toHaveLength(1);
    expect(await f.task()).toMatchObject({ status: "failed", launch_state: "terminal" });
    expect((await f.intent())?.state).toBe("completed");
    // no fallback location, no added grant, no retry under another identity
    expect(await f.db.selectFrom("permission_call_grants").select("id").execute()).toHaveLength(0);
    expect(
      await f.db.selectFrom("sandbox_operation_intents").select("operation_id").execute(),
    ).toHaveLength(1);
    expect(f.provider.calls[0]?.scope.filesystem).toEqual({
      kind: "scoped",
      readRoots: ["/work"],
      writeRoots: ["/work"],
    });
  });

  it("an abandoned pending reservation fails, but a dispatched launch is never failed as abandoned", async () => {
    const f = await fixture();
    f.provider.hooks.afterEffect = async () => {
      throw new Error("acknowledgement lost");
    };
    expect((await f.outcome(f.run({ command: "sleep 100" }))).ok).toBe(false);
    const failed = await k.app
      .get(BackgroundTaskStore)
      .failAbandonedLaunches(new Date(Date.now() + 60_000));
    expect(failed).toEqual([]);
    expect((await f.task())?.launch_state).toBe("dispatched");
  });

  it("deleting the conversation through the real writer revokes acknowledged authority and owes the exact cancellation", async () => {
    const f = await fixture();
    await f.run({ command: "npm run dev" });
    expect((await f.intent())?.state).toBe("background-running");
    await k.app.get(ConversationsService).remove(f.orgId, f.conversationId, owner.id);
    expect(await f.intent()).toMatchObject({ state: "revoked" });
    // the deletion's own stop applies the exact cancellation (phase 8.3), with no wake
    expect(await f.task()).toMatchObject({ launch_state: "terminal", status: "stopped" });
    const finished = await f.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", f.conversationId)
      .where("type", "=", "background_task_finished")
      .execute();
    expect(finished.map((e) => (e.payload as { stoppedBy?: string }).stoppedBy)).toEqual([
      "deletion",
    ]);
    expect((await f.revokeJobs()).length).toBeGreaterThanOrEqual(1);
    // the deletion's verified stop already settled it: the owed revoke is acknowledged as is
    await reconcileJob().revoke(f.operationId);
    expect(f.provider.stops).toHaveLength(1);
    expect(f.provider.revoked).toEqual([]);
    expect(await f.intent()).toMatchObject({ revoke_acknowledged: true });
  });

  it("the facade refuses an artifact outside the admitted write roots before dispatch, with zero launches", async () => {
    const project = "/home/owner/app";
    const f = await fixture({ project });
    const store = k.app.get(BackgroundTaskStore);
    // neither the device workspace nor tmp is writable: only the project is
    for (const root of ["/work", "/tmp"]) {
      await f.reclaim();
      const claim = await f.claimFor();
      const id = root === "/work" ? "bt_wwwwww" : "bt_tttttt";
      const startedAt = new Date();
      await f.db.deleteFrom("background_tasks").where("run_id", "=", f.runId).execute();
      await f.db
        .deleteFrom("sandbox_operation_intents")
        .where("operation_id", "=", f.operationId)
        .execute();
      const reserved = await store.reserveManaged(
        {
          id,
          orgId: f.orgId,
          conversationId: f.conversationId,
          sandboxConversationId: f.conversationId,
          deviceId: f.deviceId,
          runId: f.runId,
          callId: f.callId,
          triggerAccountId: owner.id,
          description: "d",
          command: "npm run dev",
          operationId: f.operationId,
          workingRoot: root,
          outputPath: `${root}/.capybara/tasks/${id}.out`,
          startedAt,
          deadlineAt: new Date(startedAt.getTime() + 60_000),
          retainUntil: new Date(startedAt.getTime() + 120_000),
        },
        MAX_TASKS,
      );
      expect(reserved.kind).toBe("reserved");
      const attempt = k.app.get(SandboxService).withOperations(
        {
          orgId: f.orgId,
          deviceId: f.deviceId,
          holderConversationId: f.conversationId,
          actor: { accountId: owner.id, conversationId: f.conversationId, runId: f.runId },
        },
        { claim, callId: f.callId, deadlineMs: Date.now() + 30_000 },
        async (h, p, _i, signal) =>
          p.backgroundStart?.(h, {
            command: "npm run dev",
            cwd: root,
            timeoutMs: 60_000,
            maxOutputBytes: 1024,
            taskId: id,
            outputPath: `${root}/.capybara/tasks/${id}.out`,
            retainUntilMs: startedAt.getTime() + 120_000,
            signal,
          }),
        new AbortController().signal,
      );
      await expect(attempt).rejects.toThrow(/outside the admitted write roots/);
      expect(f.provider.calls).toHaveLength(0);
      // never bound or dispatched: the refusal is recorded before any dispatch state
      expect(await f.task()).toMatchObject({
        status: "failed",
        launch_state: "terminal",
        run_execution_id: null,
      });
      expect((await f.intent())?.state).toBe("completed");
    }
    expect(await f.db.selectFrom("permission_call_grants").select("id").execute()).toHaveLength(0);
  });

  it("recovery never starts an artifact outside its recorded write roots", async () => {
    const f = await fixture();
    f.provider.hooks.beforeEffect = async () => {
      throw new Error("transport dropped before the device received the start");
    };
    expect((await f.outcome(f.run({ command: "sleep 100" }))).ok).toBe(false);
    f.provider.hooks.beforeEffect = undefined;
    expect((await f.intent())?.state).toBe("started-or-unknown");
    // an anomalous recorded scope whose write roots no longer cover the artifact
    await sql`UPDATE capybara.sandbox_operation_intents
      SET scope = jsonb_set(scope, '{filesystem,writeRoots}', '["/elsewhere"]'::jsonb)
      WHERE operation_id = ${f.operationId}`.execute(raw);
    await reconcileJob().reconcile(f.operationId);
    expect(f.provider.calls).toHaveLength(1);
    expect(f.provider.launched.size).toBe(0);
    // the uncertainty obligation stays owed while the slot is freed
    expect(await f.task()).toMatchObject({ launch_state: "terminal", status: "lost" });
    expect(await f.intent()).toMatchObject({ state: "revoked", outcome_unknown: true });
    expect((await f.revokeJobs()).length).toBeGreaterThanOrEqual(1);
  });

  it("recovery does not race an in-flight dispatch: one launch and no false unconfirmed report", async () => {
    const f = await fixture();
    const entered = barrier();
    const release = barrier();
    f.provider.hooks.beforeEffect = async () => {
      entered.resolve();
      await release.promise;
    };
    const second = barrier();
    f.provider.hooks.onCall = () => {
      if (f.provider.calls.length === 2) second.resolve();
    };
    const work = f.outcome(f.run({ command: "npm run dev" }));
    await entered.promise;
    expect((await f.intent())?.state).toBe("dispatching");
    // the admission-deadline reconcile fires while the first start is still in the provider
    const recovery = reconcileJob().reconcile(f.operationId);
    await Promise.race([recovery, second.promise]);
    release.resolve();
    await recovery;
    const r = await work;
    expect(r.ok).toBe(true);
    expect(f.provider.launched.size).toBe(1);
    expect(f.provider.calls).toHaveLength(1);
    expect((await f.task())?.launch_state).toBe("acknowledged");
    expect((await f.intent())?.state).toBe("background-running");
  });

  it("a stop claimed before the ref makes recovery owe the exact revoke instead of starting", async () => {
    const f = await fixture();
    f.provider.hooks.beforeEffect = async () => {
      throw new Error("transport dropped before the device received the start");
    };
    expect((await f.outcome(f.run({ command: "sleep 100" }))).ok).toBe(false);
    f.provider.hooks.beforeEffect = undefined;
    const row = await f.task();
    if (!row) throw new Error("no task");
    expect(row.launch_state).toBe("dispatched");
    expect(await k.app.get(BackgroundTaskStore).claimStop(row.id)).toBe(true);
    await reconcileJob().reconcile(f.operationId);
    expect(f.provider.calls).toHaveLength(1);
    expect(f.provider.launched.size).toBe(0);
    expect(await f.intent()).toMatchObject({ state: "revoked", outcome_unknown: true });
    expect(await f.task()).toMatchObject({ launch_state: "cancel-pending", execution_ref: null });
    expect((await f.revokeJobs()).length).toBeGreaterThanOrEqual(1);
    await reconcileJob().revoke(f.operationId);
    expect(f.provider.revoked).toEqual([f.operationId]);
  });

  it("a typed provider refusal during recovery settles as a pre-effect failure", async () => {
    const f = await fixture();
    f.provider.hooks.beforeEffect = async () => {
      throw new Error("transport dropped before the device received the start");
    };
    expect((await f.outcome(f.run({ command: "sleep 100" }))).ok).toBe(false);
    f.provider.hooks.beforeEffect = async () => {
      throw new SandboxScopeDeniedError("The task directory parent is a symbolic link");
    };
    await reconcileJob().reconcile(f.operationId);
    expect(f.provider.launched.size).toBe(0);
    expect(await f.task()).toMatchObject({ status: "failed", launch_state: "terminal" });
    expect((await f.intent())?.state).toBe("completed");
    expect(f.jobs().filter((j) => j.jobId.includes("-recover-"))).toHaveLength(0);
  });

  it("recovery backs off exponentially and skips a changed provider version", async () => {
    const f = await fixture();
    f.provider.hooks.afterEffect = async () => {
      throw new Error("acknowledgement lost");
    };
    expect((await f.outcome(f.run({ command: "sleep 100" }))).ok).toBe(false);
    f.provider.hooks.afterEffect = undefined;
    // the same plugin now runs another version: the recorded identity cannot be reconciled there
    k.app
      .get(SandboxProviders)
      .register({ plugin: PROVIDER, version: "test-2", impl: f.provider.impl });
    const delays: number[] = [];
    for (let i = 0; i < 2; i++) {
      const before = Date.now();
      await reconcileJob().reconcile(f.operationId);
      const job = await f.db
        .selectFrom("outbox")
        .select("run_at")
        .where("job_id", "like", `%${f.operationId}-recover-${i + 1}`)
        .executeTakeFirst();
      delays.push((job?.run_at?.getTime() ?? 0) - before);
    }
    expect(f.provider.calls).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(29_000);
    expect(delays[1]).toBeGreaterThanOrEqual(59_000);
    expect((await f.task())?.launch_state).toBe("dispatched");
  });

  it("at retention expiry an unknown launch becomes terminal, frees its slot and keeps the revoke owed", async () => {
    const f = await fixture();
    f.provider.hooks.afterEffect = async () => {
      throw new Error("acknowledgement lost");
    };
    expect((await f.outcome(f.run({ command: "sleep 100" }))).ok).toBe(false);
    await f.db
      .updateTable("sandbox_operation_intents")
      .set({ retain_until: new Date(Date.now() - 1000) })
      .where("operation_id", "=", f.operationId)
      .execute();
    await reconcileJob().reconcile(f.operationId);
    expect(await f.task()).toMatchObject({
      status: "lost",
      launch_state: "terminal",
      lost_reason: "launch_unknown",
    });
    expect(await k.app.get(BackgroundTaskStore).countRunning(f.conversationId)).toBe(0);
    expect(await f.intent()).toMatchObject({ state: "revoked", outcome_unknown: true });
    expect((await f.revokeJobs()).length).toBeGreaterThanOrEqual(1);
    await reconcileJob().revoke(f.operationId);
    expect(f.provider.revoked).toEqual([f.operationId]);
  });

  it("a ref attached after an acknowledged revocation makes the exact revoke run again", async () => {
    const f = await fixture();
    const entered = barrier();
    const release = barrier();
    f.provider.hooks.afterEffect = async () => {
      entered.resolve();
      await release.promise;
    };
    const work = f.outcome(f.run({ command: "npm run dev" }));
    await entered.promise;
    await narrow({ orgId: f.orgId, deviceId: f.deviceId }, "device");
    await reconcileJob().revoke(f.operationId);
    expect((await f.intent())?.revoke_acknowledged).toBe(true);
    release.resolve();
    await work;
    expect(await f.intent()).toMatchObject({ state: "revoked", revoke_acknowledged: false });
    await reconcileJob().revoke(f.operationId);
    // before the ref: the exact operation revoke; after it: the exact stop by that ref
    expect(f.provider.revoked).toEqual([f.operationId]);
    expect(f.provider.stops).toEqual([f.provider.launched.get(f.operationId)]);
  });

  it("a same-call retry in flight is left to its dispatcher by scheduled recovery (8.2 R1)", async () => {
    const f = await fixture();
    const entered = barrier();
    const release = barrier();
    // the first start never reaches the device; the retry's start is held in the provider
    f.provider.hooks.beforeEffect = async () => {
      if (f.provider.calls.length === 1)
        throw new Error("transport dropped before the device received the start");
      entered.resolve();
      await release.promise;
    };
    expect((await f.outcome(f.run({ command: "npm run dev" }))).ok).toBe(false);
    expect((await f.intent())?.state).toBe("started-or-unknown");
    await f.reclaim();
    const retry = f.outcome(f.run({ command: "npm run dev" }));
    await entered.promise;
    // the retry's dispatch is in flight under its own holder: recovery must not take it over
    expect((await f.intent())?.state).toBe("dispatching");
    const third = barrier();
    f.provider.hooks.onCall = () => {
      if (f.provider.calls.length === 3) third.resolve();
    };
    const recovery = reconcileJob().reconcile(f.operationId);
    await Promise.race([recovery, third.promise]);
    expect(f.provider.calls).toHaveLength(2);
    release.resolve();
    await recovery;
    const r = await retry;
    expect(r.ok).toBe(true);
    expect(f.provider.launched.size).toBe(1);
    expect((await f.task())?.launch_state).toBe("acknowledged");
    expect((await f.intent())?.state).toBe("background-running");
  });

  it("a same-call retry never starts a task whose stop was claimed, and owes the revoke (8.2 R2)", async () => {
    const f = await fixture();
    f.provider.hooks.beforeEffect = async () => {
      throw new Error("transport dropped before the device received the start");
    };
    expect((await f.outcome(f.run({ command: "sleep 100" }))).ok).toBe(false);
    f.provider.hooks.beforeEffect = undefined;
    const row = await f.task();
    if (!row) throw new Error("no task");
    expect(row.launch_state).toBe("dispatched");
    expect(await k.app.get(BackgroundTaskStore).claimStop(row.id)).toBe(true);
    await f.reclaim();
    const r = await f.outcome(f.run({ command: "sleep 100" }));
    expect(r.ok).toBe(false);
    expect(String((r as { error: unknown }).error)).toMatch(/stopped while it was starting/);
    expect(f.provider.calls).toHaveLength(1);
    expect(f.provider.launched.size).toBe(0);
    expect(await f.intent()).toMatchObject({ state: "revoked", outcome_unknown: true });
    expect(await f.task()).toMatchObject({ launch_state: "cancel-pending", execution_ref: null });
    expect((await f.revokeJobs()).some((j) => j.jobId.endsWith("-retry"))).toBe(true);
    await reconcileJob().revoke(f.operationId);
    expect(f.provider.revoked).toEqual([f.operationId]);
  });

  it("a stale dispatcher's unknown cannot clear the current dispatch marker (8.3 review M1)", async () => {
    const f = await fixture();
    const entered = barrier();
    const release = barrier();
    f.provider.hooks.beforeEffect = async () => {
      entered.resolve();
      await release.promise;
    };
    const work = f.outcome(f.run({ command: "npm run dev" }));
    await entered.promise;
    const intents = k.app.get(SandboxOperationIntents);
    await intents.unknown(f.operationId, "a-superseded-execution");
    expect((await f.intent())?.state).toBe("dispatching");
    release.resolve();
    expect((await work).ok).toBe(true);
  });
});

/** The poller as the worker builds it (this kernel is API-only). */
const poller = () =>
  new BackgroundTaskPollJob(
    k.app.get(BackgroundTaskStore),
    k.app.get(BackgroundTaskFinisher),
    k.app.get(EventLog),
    k.app.get(SandboxService),
    k.app.get(KernelConfigService),
    {} as LockService,
    createLogger("error", { write: () => {} }),
    k.app.get(BackgroundTaskStopper),
  );

describe("exact revocation of running background authority (8.4 B3)", () => {
  it("a pending exact cancellation stays owed and settles on a later delivery", async () => {
    const f = await fixture();
    await f.run({ command: "npm run dev" });
    f.provider.stopWith({ outcome: "cancel-pending" });
    await narrow({ orgId: f.orgId, deviceId: f.deviceId }, "device");
    await reconcileJob().revoke(f.operationId);
    expect(f.provider.stops).toHaveLength(1);
    expect(await f.task()).toMatchObject({ status: "running", launch_state: "cancel-pending" });
    expect(await f.intent()).toMatchObject({ state: "revoked", revoke_acknowledged: false });
    expect(f.jobs().map((j) => j.jobId)).toContain(`sandbox-operation-revoke-${f.operationId}-1`);
    f.provider.stopWith({ outcome: "stopped" });
    await reconcileJob().revoke(f.operationId);
    expect(await f.task()).toMatchObject({ status: "stopped", launch_state: "terminal" });
    expect(await f.intent()).toMatchObject({ revoke_acknowledged: true });
    expect(f.provider.revoked).toEqual([]);
  });

  it("a hard-deleted conversation keeps the exact cancellation owed by the start intent (8.3 M6)", async () => {
    const f = await fixture();
    await f.run({ command: "npm run dev" });
    const ref = f.provider.launched.get(f.operationId);
    await narrow({ orgId: f.orgId, deviceId: f.deviceId }, "device");
    // a hard delete cascades the task row; the intent has no conversation foreign key
    await sql`DELETE FROM capybara.conversations WHERE id = ${f.conversationId}`.execute(raw);
    expect(await f.task()).toBeUndefined();
    await reconcileJob().revoke(f.operationId);
    expect(f.provider.stops).toEqual([ref]);
    expect(f.provider.revoked).toEqual([]);
    expect(await f.intent()).toMatchObject({ state: "revoked", revoke_acknowledged: true });
  });

  it("a lost task's retained obligation becomes an owed exact cancellation, settled only by a verified stop (8.3 M6)", async () => {
    const f = await fixture();
    await f.run({ command: "npm run dev" });
    f.provider.statusWith({ state: "lost" });
    await poller().pollOnce();
    expect(await f.task()).toMatchObject({ status: "lost", launch_state: "cancel-pending" });
    // supervision loss is not proof the process is gone: the authority is retired, the stop owed
    expect(await f.intent()).toMatchObject({ state: "revoked", revoke_acknowledged: false });
    expect((await f.revokeJobs()).length).toBeGreaterThanOrEqual(1);
    f.provider.stopWith({ outcome: "lost" });
    await reconcileJob().revoke(f.operationId);
    expect(await f.intent()).toMatchObject({ revoke_acknowledged: false });
    expect((await f.task())?.launch_state).toBe("cancel-pending");
    f.provider.stopWith({ outcome: "stopped" });
    await reconcileJob().revoke(f.operationId);
    expect(await f.intent()).toMatchObject({ revoke_acknowledged: true });
    // the finish stays as it was; only the record is settled
    expect(await f.task()).toMatchObject({ status: "lost", launch_state: "terminal" });
    expect(f.provider.revoked).toEqual([]);
  });

  it("a retried start of an acknowledged operation gets its recorded starting authority back", async () => {
    const f = await fixture();
    await f.run({ command: "npm run dev" });
    const intents = k.app.get(SandboxOperationIntents);
    const row = await intents.read(f.operationId);
    expect(row.state).toBe("background-running");
    const input = await intents.input(row);
    // the same exact admission check as the first dispatch; it throws when the state is refused
    await k.app
      .get(PermissionCallGrants)
      .forExecution(
        f.operationId,
        f.deviceId,
        "backgroundStart",
        row.scope as SandboxOperationScope,
        input,
      );
  });

  it("a dispatcher released after recovery acknowledged gets the recorded authority and the same ref (8.4 M1)", async () => {
    const f = await fixture();
    // the real local-device adapter: every start resolves its exact starting authority first
    const launches = new Map<string, SandboxExecutionRef>();
    let deviceStarts = 0;
    const staged = k.app.get(LocalDeviceProvider).stagedOperations({
      async call(deviceId, op, args) {
        if (op !== "backgroundStart") throw new Error(`unexpected ${op}`);
        deviceStarts++;
        const scope = (args as { scope: { operationId: string } }).scope;
        const ref = launches.get(scope.operationId) ?? {
          executionId: `x-${scope.operationId.slice(0, 12)}`,
          operationId: scope.operationId,
          instanceId: deviceId,
          instanceGeneration: String(GENERATION),
        };
        launches.set(scope.operationId, ref);
        return ref;
      },
      async permissionSupport() {
        throw new Error("not used");
      },
    });
    const entered = barrier();
    const release = barrier();
    let starts = 0;
    const impl = f.provider.impl as unknown as { background: SandboxBackground };
    impl.background = {
      ...impl.background,
      async start(h, scope, args) {
        // the first dispatcher passed its claim and stalls before resolving its authority
        if (++starts === 1) {
          entered.resolve();
          await release.promise;
        }
        return staged.background.start(h, scope, args);
      },
    };
    const work = f.outcome(f.run({ command: "npm run dev" }));
    await entered.promise;
    const { execution_id } = await f.db
      .selectFrom("sandbox_operation_intents")
      .select("execution_id")
      .where("operation_id", "=", f.operationId)
      .executeTakeFirstOrThrow();
    // its holder is declared lost; recovery takes over and acknowledges the same identity
    await k.app.get(SandboxOperationIntents).unknown(f.operationId, execution_id);
    await reconcileJob().recoverBackground(f.operationId);
    expect((await f.intent())?.state).toBe("background-running");
    release.resolve();
    const r = await work;
    expect(r.ok && textOf(r.value)).toContain("Started background task");
    expect(starts).toBe(2);
    // its exact admission check accepted the running authority: the same start reached the
    // device again (an idempotent retry of the consumed operation), and one task was launched
    expect(deviceStarts).toBe(2);
    expect(launches.size).toBe(1);
    // the late dispatcher neither refused nor settled the acknowledged task
    expect(await f.task()).toMatchObject({ status: "running", launch_state: "acknowledged" });
    expect(await f.intent()).toMatchObject({
      state: "background-running",
      execution_ref: launches.get(f.operationId),
    });
  });
});
