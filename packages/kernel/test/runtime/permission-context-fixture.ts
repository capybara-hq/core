import { randomUUID } from "node:crypto";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxPermissionSupport,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import type { Kysely } from "kysely";
import type { PermissionContextV2 } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { PermissionContextRecorder } from "../../src/runtime/permission-context.service.js";
import { type ExecutionClaim, RunExecution } from "../../src/runtime/run-execution.js";
import type { AppliedLimits } from "../../src/sandbox/modes.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { PermissionRuntimeReports } from "../../src/sandbox/permission-runtime-reports.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import type { TestKernel } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

export const ROOTS = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/work" };
const RESTRICTED = {
  filesystem: true,
  network: true,
  native: true,
  concurrentScopes: true,
} as const;
export const REPORTS = {
  both: { version: 1, restricted: RESTRICTED, fullAccess: true, background: false },
  "restricted-only": { version: 1, restricted: RESTRICTED, fullAccess: false, background: false },
  "full-only": { version: 1, restricted: null, fullAccess: true, background: false },
  neither: {
    version: 1,
    restricted: null,
    fullAccess: false,
    background: false,
    unavailableReason: "No enforcement on this machine",
  },
} satisfies Record<string, SandboxPermissionSupport>;
export type ReportKind = keyof typeof REPORTS;

export const identityFor = (instanceGeneration: string, helper = "b") => ({
  runtimeHash: "a".repeat(64),
  helperHash: helper.repeat(64),
  imageFingerprint: "c".repeat(64),
  instanceGeneration,
});

/** Every provider method a context read must never reach: each call is recorded and throws. */
const PROVIDER_METHODS = [
  "create",
  "resume",
  "suspend",
  "destroy",
  "exec",
  "readFile",
  "writeFile",
  "stat",
  "list",
  "scan",
  "killAll",
  "killTagged",
  "createFileSystem",
  "destroyFileSystem",
  "prepare",
  "browse",
  "operation",
  "permissionSupport",
  "revokeOperation",
];
/**
 * Replaces the registered `@local` provider (or `opts.plugin`) with a recording, throwing one
 * (restore after).
 */
export function spyProvider(
  k: TestKernel,
  opts: { contract?: boolean; plugin?: string; version?: string } = {},
) {
  const plugin = opts.plugin ?? "@local";
  const providers = k.app.get(SandboxProviders);
  const previous = providers.forName(plugin);
  const calls: string[] = [];
  const impl: Record<string, unknown> = {};
  for (const name of PROVIDER_METHODS) {
    if (
      opts.contract === false &&
      ["operation", "permissionSupport", "revokeOperation"].includes(name)
    )
      continue;
    impl[name] = async () => {
      calls.push(name);
      throw new Error(`a permission context read called provider ${name}`);
    };
  }
  providers.register({
    plugin,
    ...(opts.version !== undefined && { version: opts.version }),
    impl: impl as unknown as SandboxProvider,
  });
  return {
    calls,
    restore: () => {
      if (previous) providers.register(previous);
    },
  };
}

/** The cloud provider of {@link toCloudDevice}: a recording, throwing spy (readers never probe). */
export const CLOUD_PROVIDER = "@cloud-context-test";
export const CLOUD_VERSION = "cloud-1";

/**
 * Turns the fixture's device into a cloud device of {@link CLOUD_PROVIDER} whose instance runs
 * the limits its effective policy wants (`limits` overrides them). `evidence`: records the
 * kernel-built cloud evidence under the device writer lock, as the lifecycle does after create or
 * resume (B-15). Returns the provider spy (its calls must stay empty: readers never probe).
 */
export async function toCloudDevice(
  k: TestKernel,
  f: { orgId: string; deviceId: string; db: KernelSchemaDb },
  opts: {
    evidence?: boolean;
    report?: ReportKind;
    limits?: (desired: AppliedLimits) => unknown;
    /** The device's narrowing switch: its desired mode is then `sandbox`. */
    sandboxMode?: boolean;
  } = {},
) {
  const spy = spyProvider(k, { plugin: CLOUD_PROVIDER, version: CLOUD_VERSION });
  await f.db
    .updateTable("devices")
    .set({
      source: "cloud",
      provider: CLOUD_PROVIDER,
      outer_network: JSON.stringify({ kind: "allowlist", hosts: [] }),
      ...(opts.sandboxMode && { mode: "sandbox" as const }),
    })
    .where("id", "=", f.deviceId)
    .execute();
  const policy = await k.app
    .get(PermissionFacts)
    .devicePolicy({ orgId: f.orgId, deviceId: f.deviceId });
  const desired: AppliedLimits = {
    mode: policy.mode,
    network: { kind: policy.network.kind, hosts: [...policy.network.hosts] },
  };
  await f.db
    .updateTable("device_instances")
    .set({
      provider: CLOUD_PROVIDER,
      instance_limits: JSON.stringify(opts.limits ? opts.limits(desired) : desired),
    })
    .where("device_id", "=", f.deviceId)
    .execute();
  if (opts.evidence)
    await k.app.get(TransactionHost).run(async () => {
      await k.app
        .get(PermissionAuthorityLock)
        .acquire({ orgId: f.orgId, deviceId: f.deviceId }, { kind: "write", level: "device" });
      await k.app
        .get(PermissionRuntimeReports)
        .recordCloud(f.deviceId, CLOUD_PROVIDER, CLOUD_VERSION, REPORTS[opts.report ?? "both"]);
    });
  return { spy, desired };
}

export interface ContextSeed {
  /** Null: no device selected. */
  device?: boolean | undefined;
  report?: ReportKind | null | undefined;
  binding?: "installed" | "awaiting" | "none" | undefined;
  status?: "running" | "suspended" | undefined;
  profile?: "request-approval" | "approve-for-me" | "full-access" | undefined;
  /** Full consent for the current scope (true), for a stale one (false); default true for Full. */
  consent?: boolean | undefined;
  /** The device belongs to another account (the run's actor is not its owner). */
  foreignDevice?: boolean | undefined;
  scheduledRoot?: boolean | undefined;
}

export type ContextFixture = Awaited<ReturnType<typeof seedContext>>;

/** One org, its owner, a root conversation bound to a local `@local` device and a claimed run. */
export async function seedContext(k: TestKernel, raw: Kysely<unknown>, seed: ContextSeed = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const s = await seedConversation(raw as Kysely<any>);
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const db = kernelDb(raw as Kysely<any>);
  await db
    .insertInto("memberships")
    .values({ org_id: s.orgId, account_id: s.accountId, role: "owner" })
    .execute();
  let deviceOwner = s.accountId;
  if (seed.foreignDevice) {
    deviceOwner = randomUUID();
    await db.insertInto("accounts").values({ id: deviceOwner, display_name: "Owner" }).execute();
    await db
      .insertInto("memberships")
      .values({ org_id: s.orgId, account_id: deviceOwner, role: "member" })
      .execute();
  }
  const deviceId = randomUUID();
  const generation = String(1_700_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const bindingId = randomUUID();
  let machineId: string | null = null;
  if (seed.device !== false) {
    await db
      .insertInto("devices")
      .values({
        id: deviceId,
        org_id: s.orgId,
        owner_kind: "personal",
        owner_account_id: deviceOwner,
        source: "local",
        provider: "@local",
        name: "Laptop",
      })
      .execute();
    machineId = (
      await db
        .insertInto("device_machines")
        .values({
          org_id: s.orgId,
          device_id: deviceId,
          account_id: deviceOwner,
          credential_hash: randomUUID(),
          name: "Laptop",
          os: "darwin",
          arch: "arm64",
          program_version: "0.1.0",
          features: ["mode", "projects"],
          roots: JSON.stringify(ROOTS),
          home: "/home/owner",
          local_policy: JSON.stringify({ mode: "auto", allowedDomains: [] }),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto("device_instances")
      .values({
        device_id: deviceId,
        org_id: s.orgId,
        provider: "@local",
        status: seed.status ?? "running",
        handle: JSON.stringify({ id: deviceId, roots: ROOTS }),
        permission_roots: JSON.stringify(ROOTS),
        created_at: new Date(Number(generation)),
        fs_status: "ready",
        had_instance: true,
      })
      .execute();
    const identity = identityFor(generation);
    if (seed.report !== null)
      await k.app.get(TransactionHost).run(async () => {
        await k.app
          .get(PermissionAuthorityLock)
          .acquire({ orgId: s.orgId, deviceId }, { kind: "write", level: "device" });
        await k.app
          .get(PermissionRuntimeReports)
          .record(deviceId, "@local", "0.1.0", identity, REPORTS[seed.report ?? "both"]);
      });
    if ((seed.binding ?? "installed") !== "none")
      await db
        .insertInto("device_instance_bindings")
        .values({
          device_id: deviceId,
          instance_generation: generation,
          binding_id: bindingId,
          provider: "@local",
          status: seed.binding === "awaiting" ? "awaiting-device" : "installed",
          machine_id: machineId,
          runtime_identity: seed.binding === "awaiting" ? null : JSON.stringify(identity),
        })
        .execute();
  }
  let taskId: string | null = null;
  if (seed.scheduledRoot) taskId = await seedTask(db, s);
  await db
    .updateTable("conversations")
    .set({
      device_id: seed.device === false ? null : deviceId,
      permission_profile: seed.profile ?? "request-approval",
      scheduled_task_id: taskId,
    })
    .where("id", "=", s.conversationId)
    .execute();
  if (seed.profile === "full-access" && seed.device !== false) {
    const preview = await k.app.get(PermissionFacts).scope(s.orgId, deviceId, null, null);
    await db
      .updateTable("conversations")
      .set({
        permission_consent: JSON.stringify({
          deviceId,
          scopeRevision: seed.consent === false ? "stale-consent" : preview.scopeRevision,
        }),
      })
      .where("id", "=", s.conversationId)
      .execute();
  }
  const run = await startRun(k, raw, s.conversationId, s.accountId);
  return {
    ...s,
    rootId: s.conversationId,
    deviceId,
    generation,
    bindingId,
    machineId,
    taskId,
    db,
    ...run,
  };
}

type Db = KernelSchemaDb;
export async function seedTask(
  db: Db,
  s: { orgId: string; accountId: string; agentId: string },
  grants: string[] = [],
): Promise<string> {
  const taskId = randomUUID();
  await db
    .insertInto("scheduled_tasks")
    .values({
      id: taskId,
      org_id: s.orgId,
      account_id: s.accountId,
      agent_id: s.agentId,
      name: "Nightly",
      prompt: "Check",
      trigger: JSON.stringify({ kind: "cron", cron: "0 3 * * *" }),
      mode: "new",
    })
    .execute();
  for (const host of grants)
    await db
      .insertInto("scheduled_task_grants")
      .values({ task_id: taskId, tool_key: `network:${host}`, spec_hash: "h" })
      .execute();
  return taskId;
}

/** A scheduled task run of `taskId` (not a trial): its id goes on the run it serves. */
export async function seedTaskRun(db: Db, orgId: string, taskId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("scheduled_task_runs")
    .values({ id, task_id: taskId, org_id: orgId, scheduled_for: new Date() })
    .execute();
  return id;
}

/** A running run of `conversationId` claimed through the real `RunExecution.claim`. */
export async function startRun(
  k: TestKernel,
  raw: Kysely<unknown>,
  conversationId: string,
  accountId: string,
  scheduledTaskRunId: string | null = null,
) {
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const db = kernelDb(raw as Kysely<any>);
  const runId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: conversationId,
      trigger_account_id: accountId,
      status: "running",
      agent_version: 1,
      trigger_seq: 0,
      scheduled_task_run_id: scheduledTaskRunId,
    })
    .execute();
  const claim = await k.app.get(RunExecution).claim(conversationId, runId, randomUUID());
  if (!claim) throw new Error("the run could not be claimed");
  return { runId, claim };
}

export const inputOf = (f: {
  orgId: string;
  accountId: string;
  claim: ExecutionClaim;
}): { orgId: string; conversationId: string; runId: string; accountId: string } => ({
  orgId: f.orgId,
  conversationId: f.claim.conversationId,
  runId: f.claim.runId,
  accountId: f.accountId,
});

/** `record` under the real inherited run fence of `claim`. */
export function recordUnder(
  k: TestKernel,
  claim: ExecutionClaim,
  input: { orgId: string; conversationId: string; runId: string; accountId: string },
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  return k.app.get(RunExecution).withClaim(
    claim,
    () => true,
    () => k.app.get(PermissionContextRecorder).record(input, signal),
  );
}

export async function contexts(
  raw: Kysely<unknown>,
  conversationId: string,
): Promise<{ seq: number; runId: string | null; payload: PermissionContextV2; idemKey: string }[]> {
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const rows = await kernelDb(raw as Kysely<any>)
    .selectFrom("conversation_events")
    .select(["seq", "run_id", "payload", "idem_key"])
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "permission_context")
    .orderBy("seq")
    .execute();
  return rows.map((r) => ({
    seq: Number(r.seq),
    runId: r.run_id,
    payload: r.payload as PermissionContextV2,
    idemKey: r.idem_key ?? "",
  }));
}
