import { randomUUID } from "node:crypto";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxBackground,
  type SandboxExecutionRef,
  type SandboxOperationScope,
  type SandboxProvider,
  SandboxScopeDeniedError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundMaxSeconds } from "../../src/background/launch.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { createLogger } from "../../src/log.js";
import type { ExecutionClaim } from "../../src/runtime/run-execution.js";
import { operationIdFor, SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { SandboxOperationReconcileJob } from "../../src/sandbox/operation-reconcile.job.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { runInBackgroundManaged } from "../../src/tools/builtins/sandbox/bash.js";
import type { SandboxToolDeps } from "../../src/tools/builtins/sandbox/common.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

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
  const revoked: string[] = [];
  const hooks: {
    beforeEffect?: ((c: StartCall) => Promise<void>) | undefined;
    afterEffect?: ((c: StartCall) => Promise<void>) | undefined;
  } = {};
  const background: SandboxBackground = {
    async start(h, scope, args) {
      const call = { scope, args };
      calls.push(call);
      const known = launched.get(scope.operationId);
      if (known) return known;
      await hooks.beforeEffect?.(call);
      const ref: SandboxExecutionRef = {
        executionId: `x-${scope.operationId.slice(0, 12)}`,
        operationId: scope.operationId,
        instanceId: h.id,
        instanceGeneration: String(GENERATION),
      };
      launched.set(scope.operationId, ref);
      await hooks.afterEffect?.(call);
      return ref;
    },
    async status() {
      return { state: "running" };
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
    async stop() {
      return { outcome: "stopped" };
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
  return { impl, calls, launched, revoked, hooks };
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
  let seq = 0;
  const event = async (type: string, payload: object) => {
    seq++;
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

  it("a stale invocation launches nothing and settles its reservation before any effect", async () => {
    const f = await fixture();
    const stale = await f.claimFor();
    await f.reclaim();
    await expect(f.run({ command: "npm run dev" }, stale)).rejects.toThrow();
    expect(f.provider.calls).toHaveLength(0);
    const row = await f.task();
    expect(row).toMatchObject({ status: "failed", launch_state: "terminal", execution_ref: null });
    expect(["pending", "admitted", undefined]).toContain((await f.intent())?.state);
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
    expect(String((r as { error: unknown }).error)).toMatch(/stopped while it was starting/);
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
    expect(f.provider.revoked).toEqual([f.operationId]);
  });

  it("acknowledged authority survives a profile-only change and launch-run completion, not owner narrowing", async () => {
    const f = await fixture();
    await f.run({ command: "npm run dev" });
    await f.db.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
    await narrow(
      { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId },
      "root",
    );
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
});
