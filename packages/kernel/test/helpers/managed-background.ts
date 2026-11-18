import { randomUUID } from "node:crypto";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxBackground,
  type SandboxExecutionRef,
  type SandboxExecutionStatus,
  type SandboxPermissionSupport,
  type SandboxProvider,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { expect } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { BackgroundTaskStopper } from "../../src/background/stop.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import type { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { ExecutionClaim } from "../../src/runtime/run-execution.js";
import { operationIdFor } from "../../src/sandbox/operation-intents.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { runInBackgroundManaged } from "../../src/tools/builtins/sandbox/bash.js";
import type { SandboxToolDeps } from "../../src/tools/builtins/sandbox/common.js";
import { taskOutputTool } from "../../src/tools/builtins/sandbox/task-output.js";
import { taskStopTool } from "../../src/tools/builtins/sandbox/task-stop.js";
import type { BuiltinCallContext, BuiltinResult } from "../../src/tools/registry.js";
import { asUser, cookieJar } from "./http.js";
import { seedInstalledEvidence } from "./installed-evidence.js";
import { enableModelProviders, type Req, type TestKernel } from "./runs.js";

/**
 * Managed background task fixtures (permission runtime cutover phase 8.3): a provider that owns
 * executions by exact ref with retained positional output, and one org / local device / root
 * conversation / running run whose Bash call launches through the real managed path.
 */

export const MANAGED_GENERATION = 1700000000000;
export const MANAGED_PROVIDER = "@managed-consumer-test";

export function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One execution as the provider owns it. */
export interface OwnedExecution {
  ref: SandboxExecutionRef;
  output: Uint8Array;
  status: SandboxExecutionStatus;
  /** What a stop answers while the execution runs (default `stopped`). */
  stopAs: "stopped" | "cancel-pending" | "lost";
  retained: "ok" | "lost" | "expired";
  /** The device applied a cancellation: the process exited, the claimed outcome is `stopped`. */
  cancelled?: boolean;
}

/**
 * A provider owning background executions by exact operation id, with retained append-only
 * output read by position (clamped to `capacity`, like the transport adapter). Every call is
 * counted; native operations, preparation, exec, create and resume are never expected here.
 */
export function managedOutputProvider() {
  const executions = new Map<string, OwnedExecution>();
  const calls = {
    start: 0,
    status: 0,
    readOutput: [] as { offset: number; maxBytes: number }[],
    tail: 0,
    stop: [] as { graceMs: number }[],
    forbidden: [] as string[],
  };
  const state = {
    capacity: 65_536,
    /** Throws on the next read (a dropped connection), once. */
    dropNextRead: false,
    beforeRead: undefined as (() => Promise<void>) | undefined,
    /** Runs before a new execution is launched (a start may be held or fail before its effect). */
    beforeStart: undefined as (() => Promise<void>) | undefined,
    /** Tail reads throw (a dropped connection after a stop). */
    failTail: false,
    /** Status reads of these operations throw. */
    statusFailsFor: new Set<string>(),
  };
  const owned = (ref: SandboxExecutionRef): OwnedExecution => {
    const e = executions.get(ref.operationId);
    if (
      !e ||
      e.ref.executionId !== ref.executionId ||
      e.ref.instanceId !== ref.instanceId ||
      e.ref.instanceGeneration !== ref.instanceGeneration
    )
      throw new SandboxScopeDeniedError("No execution with this exact reference");
    return e;
  };
  const inflight = new Map<string, Promise<SandboxExecutionRef>>();
  const launch = (h: { id: string }, operationId: string): SandboxExecutionRef => {
    const ref: SandboxExecutionRef = {
      executionId: `x-${operationId.slice(0, 12)}`,
      operationId,
      instanceId: h.id,
      instanceGeneration: String(MANAGED_GENERATION),
    };
    executions.set(operationId, {
      ref,
      output: new Uint8Array(),
      status: { state: "running" },
      stopAs: "stopped",
      retained: "ok",
    });
    return ref;
  };
  const background: SandboxBackground = {
    async start(h, scope) {
      calls.start++;
      const existing = executions.get(scope.operationId);
      if (existing) return existing.ref;
      const held = inflight.get(scope.operationId);
      if (held) return held;
      const launching = (async () => {
        await state.beforeStart?.();
        return launch(h, scope.operationId);
      })();
      inflight.set(scope.operationId, launching);
      launching.catch(() => inflight.delete(scope.operationId));
      return launching;
    },
    async status(_h, ref) {
      calls.status++;
      if (state.statusFailsFor.has(ref.operationId)) throw new Error("status read failed");
      return owned(ref).status;
    },
    async readOutput(_h, ref, opts) {
      calls.readOutput.push({ offset: opts.offset, maxBytes: opts.maxBytes });
      expect(opts.maxBytes).toBeLessThanOrEqual(65_536);
      const e = owned(ref);
      await state.beforeRead?.();
      if (state.dropNextRead) {
        state.dropNextRead = false;
        throw new Error("device connection closed");
      }
      if (e.retained !== "ok") return { unavailable: e.retained };
      const n = Math.max(0, Math.min(opts.maxBytes, state.capacity, e.output.length - opts.offset));
      const data = e.output.slice(opts.offset, opts.offset + n);
      return {
        data,
        offset: opts.offset,
        nextOffset: opts.offset + data.length,
        totalBytes: e.output.length,
      };
    },
    async tail(_h, ref, opts) {
      calls.tail++;
      const e = owned(ref);
      if (state.failTail) throw new Error("device connection closed during the tail");
      if (e.retained !== "ok") return { unavailable: e.retained };
      const text = Buffer.from(e.output).toString("utf8");
      const lines = text.replace(/\n$/, "").split("\n").slice(-20).join("\n");
      const data = Buffer.from(lines, "utf8");
      const cut = data.subarray(Math.max(0, data.length - opts.maxBytes));
      return { data: new Uint8Array(cut), truncated: cut.length < Buffer.byteLength(text) };
    },
    async stop(_h, ref, opts) {
      calls.stop.push({ graceMs: opts.graceMs });
      const e = owned(ref);
      // the atomically claimed outcome of an applied cancellation is kept on every retry
      if (e.cancelled) return { outcome: "stopped" };
      if (e.status.state === "exited")
        return {
          outcome: "already-exited",
          exitCode: e.status.exitCode,
          timedOut: e.status.timedOut,
        };
      if (e.status.state === "lost") return { outcome: "lost" };
      if (e.stopAs === "stopped") {
        e.status = { state: "exited", exitCode: 143, timedOut: false };
        e.cancelled = true;
        return { outcome: "stopped" };
      }
      if (e.stopAs === "lost") {
        e.status = { state: "lost" };
        return { outcome: "lost" };
      }
      // the device recorded the cancellation but could not apply it yet; the task keeps running
      return { outcome: "cancel-pending" };
    },
  };
  const forbid = (name: string) => () => {
    calls.forbidden.push(name);
    throw new Error(`${name} must not be called by a task consumer`);
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
      return forbid("operation")();
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
    exec: forbid("exec"),
    create: forbid("create"),
    resume: forbid("resume"),
    async revokeOperation() {},
    background,
  } as unknown as SandboxProvider;
  /** The single execution this fixture launched. */
  const only = (): OwnedExecution => {
    const [e] = [...executions.values()];
    if (!e) throw new Error("nothing launched");
    return e;
  };
  return {
    impl,
    calls,
    state,
    executions,
    only,
    write(text: string | Uint8Array) {
      const e = only();
      const more = typeof text === "string" ? new Uint8Array(Buffer.from(text, "utf8")) : text;
      const out = new Uint8Array(e.output.length + more.length);
      out.set(e.output);
      out.set(more, e.output.length);
      e.output = out;
    },
    exit(exitCode: number | null, timedOut = false) {
      only().status = { state: "exited", exitCode, timedOut };
    },
    /** The device applies the pending cancellation on its own (status then shows exit 143). */
    applyPendingCancel(e: OwnedExecution = only()) {
      e.status = { state: "exited", exitCode: 143, timedOut: false };
      e.cancelled = true;
    },
  };
}

export type ManagedOutputProvider = ReturnType<typeof managedOutputProvider>;

/** The HTTP calls the fixture's tests make, as the logged-in owner. */
export type OwnerHttp = (opts: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
}) => Promise<{ statusCode: number; json: () => unknown }>;

export const textOf = (r: unknown): string =>
  (r as { content: { type: string; text: string }[] }).content.map((c) => c.text).join("\n");

/**
 * One org (created over `k`'s HTTP API as `login`), one local device on a running instance of
 * `provider`, a root conversation with a running run and a Bash call that launched one managed
 * task through the real path. `kernels` are every replica that must know the provider.
 */
export async function managedTaskFixture(opts: {
  kernels: TestKernel[];
  raw: ReturnType<typeof createDb>;
  login: string;
  password: string;
  accountId: string;
  provider?: ManagedOutputProvider;
  launch?: boolean;
}) {
  const [k] = opts.kernels as [TestKernel];
  const db: KernelSchemaDb = kernelDb(opts.raw);
  const req: Req = asUser(k.http, cookieJar());
  expect(
    (
      await req({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { login: opts.login, password: opts.password },
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
  const conversationId = (conv.json() as { conversation: { id: string } }).conversation.id;
  const provider = opts.provider ?? managedOutputProvider();
  for (const kk of opts.kernels)
    kk.app
      .get(SandboxProviders)
      .register({ plugin: MANAGED_PROVIDER, version: "test-1", impl: provider.impl });
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: opts.accountId,
      source: "local",
      provider: MANAGED_PROVIDER,
      name: "Laptop",
    })
    .execute();
  await db
    .insertInto("device_machines")
    .values({
      org_id: orgId,
      device_id: deviceId,
      account_id: opts.accountId,
      credential_hash: randomUUID(),
      name: "Laptop",
      os: "darwin",
      arch: "arm64",
      features: ["mode", "projects"],
      // the machine reports every root the instance mounts (its handle's below)
      roots: JSON.stringify({ ...DEFAULT_SANDBOX_ROOTS, workspace: "/work" }),
      home: "/home/owner",
      local_policy: JSON.stringify({ mode: "auto", allowedDomains: [] }),
    })
    .execute();
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", conversationId)
    .execute();
  const roots = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/work" };
  await db
    .insertInto("device_instances")
    .values({
      device_id: deviceId,
      org_id: orgId,
      provider: MANAGED_PROVIDER,
      status: "running",
      handle: JSON.stringify({ id: deviceId, roots }),
      created_at: new Date(MANAGED_GENERATION),
      fs_status: "ready",
      had_instance: true,
      instance_limits: JSON.stringify({
        mode: "auto",
        network: { kind: "open-public", hosts: [] },
      }),
    })
    .execute();
  // admission proves the installed environment (B-16): the provider's report and its binding
  await seedInstalledEvidence(k, opts.raw, {
    orgId,
    deviceId,
    provider: MANAGED_PROVIDER,
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
      trigger_account_id: opts.accountId,
      status: "running",
      agent_version: 1,
      trigger_seq: 0,
    })
    .execute();
  let seq = 0;
  const event = async (type: string, payload: object) => {
    // the kernel may have appended events of its own since (a launch's notices)
    const conv = await db
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
    seq = Math.max(seq, Number(conv.last_seq)) + 1;
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
  const depsOf = (kk: TestKernel): SandboxToolDeps => ({
    sandbox: kk.app.get(SandboxService),
    devices: kk.app.get(ConversationDevices),
    background: kk.app.get(BackgroundTaskStore),
    tasks: {
      finisher: kk.app.get(BackgroundTaskFinisher),
      stopper: kk.app.get(BackgroundTaskStopper),
    },
    attachments: {
      listForConversation: async () => [],
      openForConversation: async () => {
        throw new Error("no attachments");
      },
    },
    storage: {} as SandboxToolDeps["storage"],
    eventLog: kk.app.get(EventLog),
    config: kk.app.get(KernelConfigService),
  });
  const ctxFor = async (over: Partial<BuiltinCallContext> = {}): Promise<BuiltinCallContext> => ({
    orgId,
    accountId: opts.accountId,
    agentId,
    conversationId,
    callId,
    runId,
    signal: new AbortController().signal,
    executionClaim: await claimFor(),
    ...over,
  });
  const operationId = operationIdFor({ claim: { runId }, callId, ordinal: 0 });
  const taskRow = () =>
    db
      .selectFrom("background_tasks")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirstOrThrow();
  const intent = () =>
    db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirstOrThrow();
  let taskId = "";
  if (opts.launch !== false) {
    await runInBackgroundManaged(depsOf(k), await ctxFor(), {
      command: "npm run dev",
      description: "Serve",
      run_in_background: true,
    });
    taskId = (await taskRow()).id;
  }
  /** Launches one more managed task in the same run, as a new Bash call. */
  const launchAnother = async (): Promise<string> => {
    const another = randomUUID();
    await event("tool_call_started", { callId: another, toolKey: "Bash" });
    await runInBackgroundManaged(depsOf(k), await ctxFor({ callId: another }), {
      command: "npm run worker",
      description: "Worker",
      run_in_background: true,
    });
    const row = await db
      .selectFrom("background_tasks")
      .select("id")
      .where("run_id", "=", runId)
      .where("call_id", "=", another)
      .executeTakeFirstOrThrow();
    return row.id;
  };
  const taskOutput = async (
    input: { block?: boolean; timeout?: number; task_id?: string },
    kk: TestKernel = k,
    over: Partial<BuiltinCallContext> = {},
  ): Promise<BuiltinResult> =>
    (await taskOutputTool(depsOf(kk)).run(
      { task_id: taskId, block: false, ...input },
      await ctxFor(over),
    )) as BuiltinResult;
  const taskStop = async (kk: TestKernel = k, over: Partial<BuiltinCallContext> = {}) =>
    (await taskStopTool(depsOf(kk)).run({ task_id: taskId }, await ctxFor(over))) as BuiltinResult;
  const finishedEvents = () =>
    db
      .selectFrom("conversation_events")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "background_task_finished")
      .execute();
  const http: OwnerHttp = (o) => req(o);
  return {
    req: http,
    db,
    orgId,
    agentId,
    conversationId,
    deviceId,
    runId,
    callId,
    operationId,
    provider,
    get taskId() {
      return taskId;
    },
    depsOf,
    ctxFor,
    claimFor,
    taskRow,
    intent,
    taskOutput,
    taskStop,
    launchAnother,
    finishedEvents,
  };
}
