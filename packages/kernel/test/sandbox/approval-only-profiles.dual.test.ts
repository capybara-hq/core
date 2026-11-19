import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DeviceOwnerCeiling,
  KernelReq,
  LegacyDeviceHello,
  SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import {
  PERMISSION_AUTO_GRANT_HOOKS,
  type PermissionAutoGrantHooks,
} from "../../src/sandbox/permission-auto-grants.js";
import { REVIEW_SYSTEM_PROMPT } from "../../src/sandbox/review/index.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { setFakeSandboxPermissionSupport } from "../fixtures/plugins/sandbox-fake/index.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
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
import { bindAnswer, FakeMachineV3, ownerReportFor } from "../local-devices/fake-machine-v3.js";
import type { Answer } from "../local-devices/test-holder.js";

/**
 * Approval-only profiles across two replicas (approval-only profiles design; plan task T12). A
 * profile only chooses who approves a crossing (the person, the review model, nobody); the sandbox
 * is the device's and the same under every profile. Replica A runs the worker and the device
 * gateway, replica B serves the API only: every profile change, approval and ceiling write goes
 * through B and reaches A's runs only through PostgreSQL and Redis.
 *
 * The crossings run on a local device (a protocol 4 fake machine on a real WebSocket; a cloud
 * device has no outside of its sandbox), whose runtime reports the open network and running
 * outside the sandbox. The review model is the `model-script` extension mapped to the `review`
 * purpose, answering what each test scripts. `sandbox-fake` backs the cloud device of the replay
 * context case.
 *
 * Covered elsewhere and taken as given here: the service-level auto-grant race on one binding
 * (permission-approvals.dual), the in-project profile × operation matrix and the cloud escalation
 * refusal (permission-profiles.dual), the platform ceiling revocation (permission-wiring).
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const SANDBOX_FAKE = fixture("sandbox-fake");
const MODEL_SCRIPT = fixture("model-script");

type Profile = "request-approval" | "approve-for-me" | "full-access";
type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>;
type Scope = {
  operationId: string;
  profile: Profile;
  filesystem: { kind: "device" } | { kind: "scoped"; readRoots: string[]; writeRoots: string[] };
  network: { kind: string; hosts?: string[] };
};

const HOME = "/home/me";
const ROOTS = {
  workspace: "/home/me/.capybara/box/workspace",
  skills: "/home/me/.capybara/box/skills",
  tmp: "/home/me/.capybara/box/tmp",
};
/** The host the matrix device's owner allows and the org's lists do not name: a host crossing. */
const HOST = "api.example.org";
const JUSTIFICATION = "The build writes the system cache outside the project.";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let sandboxRoot: string;
/** Replica A: api, worker and gateway (runs every job and holds the device sockets). */
let kA: TestKernel;
/** Replica B: api only. */
let kB: TestKernel;
let ownerA: Req;
let ownerB: Req;
let ownerId: string;
const machines: FakeMachineV3[] = [];
/** Armed by the race test: replica A's auto-grant waits here after its precheck. */
let autoGrantBarrier: (() => Promise<void>) | undefined;
const autoGrantHooks: PermissionAutoGrantHooks = {
  afterPrecheck: async () => {
    await autoGrantBarrier?.();
  },
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-approval-only-dual-"));
  const config = (roles: string[]) =>
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles,
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root: sandboxRoot } },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        devices: { local: { reconnectGraceSeconds: 30, leaseTtlMs: 6000 } },
      },
    );
  kA = await startKernel(config(["api", "worker", "gateway"]), {
    overrides: [{ provide: PERMISSION_AUTO_GRANT_HOOKS, useValue: autoGrantHooks }],
  });
  kB = await startKernel(config(["api"]));
  raw = createDb(pgc.url, 4);
  db = kernelDb(raw);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  ownerA = await session(kA, "owner");
  ownerB = await session(kB, "owner");
  // the review model: every org's `review` purpose is the scripted model
  await db
    .insertInto("model_purpose_mappings")
    .values({
      org_id: null,
      purpose: "review",
      provider: "model-script",
      model: "script-2",
      params: "{}",
    })
    .execute();
});

afterEach(() => {
  scriptRules([]);
  autoGrantBarrier = undefined;
});

afterAll(async () => {
  for (const m of machines.splice(0)) m.close();
  await kA?.close();
  await kB?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

/** Scripts the review model's answer to every review it is asked for. */
const reviewModelAnswers = (decision: "allow" | "ask" | "deny") =>
  scriptRules([
    {
      when: { systemIncludes: REVIEW_SYSTEM_PROMPT },
      reply: {
        text: JSON.stringify({ decision, reason: `Scripted ${decision}.` }),
        usage: { inputTokens: 11, outputTokens: 3 },
      },
    },
  ] as ScriptRule[]);

/** The review model's calls in `conv` so far (its `usage` events with purpose `review`). */
const reviewModelCalls = async (conv: string) =>
  (await eventsOf(db, conv)).filter(
    (e) => e.type === "usage" && (e.payload as { purpose?: string }).purpose === "review",
  ).length;

interface Scene {
  orgId: string;
  agentId: string;
}

/** A fresh org (so org ceiling writes stay within one test) with an agent that uses the device. */
async function scene(): Promise<Scene> {
  const orgId = await createOrgWithProviders(kA, ownerA, `Org ${randomUUID().slice(0, 8)}`);
  const created = await ownerA({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the device.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins(
          ["Bash", "Read", "Write", "Edit", "TaskOutput", "TaskStop"].map((name) => ({
            kind: "builtin" as const,
            name,
          })),
        ),
      },
      visibility: "org",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return { orgId, agentId: (created.json() as { agent: { id: string } }).agent.id };
}

interface LocalDevice {
  deviceId: string;
  machine: FakeMachineV3;
  /** The requests of `op` the machine received, oldest first. */
  reqs(op: string): KernelReq[];
}

/**
 * A local device of the owner on a protocol 4 fake machine: its runtime enforces the open network,
 * allowlists, per-call hosts, running outside the sandbox and background tasks; its owner allows
 * running outside the sandbox and broad project reach, with the sandbox network `network`.
 * Commands succeed; background tasks run until the kernel stops or revokes them.
 */
async function localDevice(
  s: Scene,
  owner: { network: "open" | "allowlist"; allowedDomains?: string[] },
): Promise<LocalDevice> {
  const { deviceId, credential } = await kA.app.get(TransactionHost).run(async () => {
    const { id } = await kA.app
      .get(DevicesService)
      .createLocal(s.orgId, ownerId, `Laptop ${randomUUID().slice(0, 6)}`);
    const issued = await kA.app.get(MachinesService).issue({
      orgId: s.orgId,
      deviceId: id,
      accountId: ownerId,
      name: "laptop",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { deviceId: id, credential: issued.credential };
  });
  const allowedDomains = owner.allowedDomains ?? [];
  const ceiling: DeviceOwnerCeiling = ownerReportFor(
    { allowedDomains },
    { outsideSandbox: true, restrictedProjectReach: "os-user", network: owner.network },
  );
  const support: SandboxPermissionSupport = {
    version: 2,
    restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
    boundary: "operation",
    network: { openPublic: true, allowlist: true, perOperationHosts: true },
    outsideSandbox: true,
    background: true,
  };
  let bound: { instanceId: string; instanceGeneration: string } | undefined;
  /** Background executions by operation id; a revoked or stopped one is lost. */
  const executions = new Map<string, { ref: Record<string, string>; state: "running" | "lost" }>();
  const answer = (req: KernelReq): Answer => {
    const a = req.args as Record<string, unknown>;
    const op = String(req.op).replace(/^(browse|prepare)(\w)/, (_, _p, c: string) =>
      c.toLowerCase(),
    );
    switch (op) {
      case "create":
        return { ok: true, result: { roots: ROOTS } };
      case "bindInstance": {
        bound = {
          instanceId: String(a.instanceId),
          instanceGeneration: String(a.instanceGeneration),
        };
        const evidence = bindAnswer(req) as { ok: true; result: Record<string, unknown> };
        return {
          ok: true,
          result: { ...evidence.result, permissionSupport: support, ownerCeiling: ceiling },
        } as NonNullable<Answer>;
      }
      case "exec":
        return {
          ok: true,
          result: {
            exitCode: 0,
            stdout: `ran: ${String(a.command)}\n`,
            stderr: "",
            truncated: false,
            timedOut: false,
          },
        };
      case "backgroundStart": {
        const scope = a.scope as Scope;
        const ref = {
          executionId: randomUUID(),
          operationId: scope.operationId,
          instanceId: bound?.instanceId ?? deviceId,
          instanceGeneration: bound?.instanceGeneration ?? "test-instance-1",
        };
        executions.set(scope.operationId, { ref, state: "running" });
        return { ok: true, result: ref } as NonNullable<Answer>;
      }
      case "backgroundStatus": {
        const ref = a.ref as { operationId: string };
        return {
          ok: true,
          result: { state: executions.get(ref.operationId)?.state ?? "lost" },
        } as NonNullable<Answer>;
      }
      case "backgroundStop": {
        const ref = a.ref as { operationId: string };
        const e = executions.get(ref.operationId);
        if (e) e.state = "lost";
        return { ok: true, result: { outcome: "stopped" } } as NonNullable<Answer>;
      }
      case "backgroundTail":
        return { ok: true, result: { dataB64: "", truncated: false } } as NonNullable<Answer>;
      case "backgroundReadOutput": {
        const offset = Number(a.offset ?? 0);
        return {
          ok: true,
          result: { dataB64: "", offset, nextOffset: offset, totalBytes: offset },
        } as NonNullable<Answer>;
      }
      case "revokeOperation": {
        const ref = a.ref as { operationId: string };
        const e = executions.get(ref.operationId);
        if (e) e.state = "lost";
        return { ok: true, result: null };
      }
      case "list":
        return { ok: true, result: { entries: [], truncated: false } };
      default:
        return { ok: true, result: null };
    }
  };
  const machine = new FakeMachineV3(
    `ws://127.0.0.1:${kA.port}/device/connect`,
    credential,
    answer,
    { hello: false },
  );
  machines.push(machine);
  await machine.opened;
  const hello: Partial<LegacyDeviceHello> = {
    roots: ROOTS,
    home: HOME,
    features: ["networkReport", "policyOp", "policyOpId", "projects"],
    policy: { allowedDomains },
  };
  machine.hello({ ...hello, ownerCeiling: ceiling });
  await machine.ready;
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("roots")
          .where("device_id", "=", deviceId)
          .where("revoked_at", "is", null)
          .executeTakeFirst()
      )?.roots != null,
    15_000,
    "hello recorded",
  );
  return {
    deviceId,
    machine,
    reqs: (op) =>
      machine.frames.filter((f): f is KernelReq => f.type === "req" && String(f.op) === op),
  };
}

/** A conversation of `s`'s agent on `deviceId`, created on replica A. */
async function conversation(s: Scene, deviceId: string): Promise<string> {
  const res = await ownerA({
    method: "POST",
    url: `/api/v1/orgs/${s.orgId}/conversations`,
    payload: { agentId: s.agentId, deviceId },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { conversation: { id: string } }).conversation.id;
}

interface PermissionsBody {
  profile: Profile;
  revision: number;
  scopeRevision: string | null;
}

/** The owner's permissions view, read through replica B. */
async function permissions(s: Scene, conv: string): Promise<PermissionsBody> {
  const res = await ownerB({
    method: "GET",
    url: `/api/v1/orgs/${s.orgId}/conversations/${conv}/permissions`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as PermissionsBody;
}

/** Changes the profile through replica B's owner API (Full access with the displayed consent). */
async function setProfile(s: Scene, conv: string, profile: Profile): Promise<PermissionsBody> {
  const view = await permissions(s, conv);
  const res = await ownerB({
    method: "PATCH",
    url: `/api/v1/orgs/${s.orgId}/conversations/${conv}/permissions`,
    payload: {
      profile,
      expectedRevision: view.revision,
      ...(profile === "full-access" && view.scopeRevision !== null
        ? { consentScopeRevision: view.scopeRevision }
        : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const after = await permissions(s, conv);
  expect(after.profile).toBe(profile);
  return after;
}

/** Writes the org's settings through replica B (an org admin in a web session). */
async function orgSettings(s: Scene, patch: Record<string, unknown>): Promise<void> {
  const res = await ownerB({
    method: "PATCH",
    url: `/api/v1/orgs/${s.orgId}/settings`,
    payload: patch,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const results = async (conv: string): Promise<ToolResult[]> =>
  (await eventsOf(db, conv)).filter((e): e is ToolResult => e.type === "tool_result");

/** Posts one tool call on replica A and waits for the conversation's `n`th terminal event. */
async function call(
  s: Scene,
  conv: string,
  key: string,
  input: unknown,
  n: number,
): Promise<ToolResult> {
  await postMessage(ownerA, s.orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 60_000);
  const r = (await results(conv)).at(-1);
  expect(r?.payload.toolKey).toBe(key);
  return r as ToolResult;
}

const pendingAsk = (conv: string) =>
  waitFor(
    async () =>
      db
        .selectFrom("approvals")
        .select(["id", "detail"])
        .where("conversation_id", "=", conv)
        .where("status", "=", "pending")
        .executeTakeFirst(),
    30_000,
    "the pending ask",
  );

/** Approves an ask through replica B, then waits for the run A parked on it to end. */
async function approveThrough(
  s: Scene,
  conv: string,
  askId: string,
  terminal: number,
): Promise<ToolResult> {
  const res = await ownerB({
    method: "POST",
    url: `/api/v1/orgs/${s.orgId}/approvals/${askId}/decision`,
    payload: { decision: "approve", scope: "once" },
  });
  expect(res.statusCode, res.body).toBe(200);
  await waitForTerminal(db, conv, terminal, 60_000);
  return (await results(conv)).at(-1) as ToolResult;
}

const grantsOf = (conv: string) =>
  db
    .selectFrom("permission_call_grants")
    .select(["source", "scope_kind", "expansion", "approval_id", "call_id", "review_event_seq"])
    .where("conversation_id", "=", conv)
    .orderBy("created_at")
    .execute();

const autoGrantAudits = (deviceId: string) =>
  db
    .selectFrom("audit_events")
    .select(["detail", "actor_account_id"])
    .where("action", "=", "permission.crossing_auto_granted")
    .where("target", "=", deviceId)
    .orderBy("at")
    .execute();

const reviewedEvents = async (conv: string) =>
  (
    await db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", conv)
      .where("type", "=", "permission_reviewed")
      .orderBy("seq")
      .execute()
  ).map((e) => e.payload as Record<string, unknown>);

const scopeOf = (req: KernelReq) => (req.args as { scope: Scope }).scope;
const commandOf = (req: KernelReq) => String((req.args as { command?: unknown }).command);

/** One call per crossing kind (approval-only profiles design, "Profiles" table). */
const CROSSINGS = (tag: string) =>
  ({
    directory: {
      key: "Write",
      input: { file_path: `/srv/cap-${tag}/note.txt`, content: "x" },
    },
    host: {
      key: "Bash",
      input: { command: `curl https://${HOST}/${tag}`, description: "Fetch" },
    },
    "outside-sandbox": {
      key: "Bash",
      input: {
        command: `echo escalated-${tag}`,
        description: "Escalate",
        sandbox: "escalated",
        justification: JUSTIFICATION,
      },
    },
    sensitive: {
      key: "Bash",
      input: { command: `sudo echo sensitive-${tag}`, description: "Elevate" },
    },
  }) as const;
type Crossing = keyof ReturnType<typeof CROSSINGS>;
const KINDS: Crossing[] = ["directory", "host", "outside-sandbox", "sensitive"];

/** Checks what the device ran for `crossing`: once, with the sandbox (or outside it, escalated). */
function expectRanOnce(d: LocalDevice, crossing: Crossing, tag: string): void {
  const command = (CROSSINGS(tag)[crossing].input as { command?: string }).command;
  if (crossing === "directory") {
    const writes = d
      .reqs("writeFile")
      .filter((r) => (r.args as { path?: string }).path === `/srv/cap-${tag}/note.txt`);
    expect(writes).toHaveLength(1);
    const fs = scopeOf(writes[0] as KernelReq).filesystem;
    expect(fs).toMatchObject({
      kind: "scoped",
      writeRoots: expect.arrayContaining([`/srv/cap-${tag}`]),
    });
    return;
  }
  const execs = d.reqs("exec").filter((r) => commandOf(r) === command);
  expect(execs).toHaveLength(1);
  const exec = execs[0] as KernelReq;
  const scope = scopeOf(exec);
  if (crossing === "outside-sandbox") {
    // only an escalated call runs outside the sandbox: the device filesystem and environment
    expect(scope.filesystem).toEqual({ kind: "device" });
    expect(scope.network.kind).toBe("environment");
    return;
  }
  // every other call keeps the sandbox, Full access included
  expect(scope.filesystem.kind).toBe("scoped");
  expect(scope.network.kind).not.toBe("environment");
  if (crossing === "host")
    expect((exec.args as { grants?: { hosts?: string[] } }).grants?.hosts).toEqual([HOST]);
}

describe("profile × crossing on a local device: approvals through replica B, runs on replica A", () => {
  /**
   * Runs the four crossings in one conversation under `profile` on a device whose owner network is
   * the allowlist (so a new host is a crossing). Request approval: every crossing asks the person,
   * approved through replica B, and runs once. Approve for me: the review model allows each. Full
   * access: nobody is asked; each crossing is auto-granted once, recorded and audited, and the
   * sensitive command runs, recorded.
   */
  async function matrix(profile: Profile): Promise<void> {
    const s = await scene();
    const d = await localDevice(s, { network: "allowlist", allowedDomains: [HOST] });
    const conv = await conversation(s, d.deviceId);
    // the first call starts the device (Full access chosen before the first start: the separate
    // case below)
    const bound = await call(s, conv, "Bash", { command: "echo bound", description: "Bind" }, 1);
    expect(bound.payload.isError, bound.payload.content).toBe(false);
    if (profile !== "approve-for-me") await setProfile(s, conv, profile);
    reviewModelAnswers("allow");
    const crossings = CROSSINGS(profile);
    let n = 1;
    for (const kind of KINDS) {
      const { key, input } = crossings[kind];
      let r: ToolResult;
      if (profile === "request-approval") {
        const effects = () => d.reqs("exec").length + d.reqs("writeFile").length;
        const before = effects();
        await postMessage(ownerA, s.orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
        const ask = await pendingAsk(conv);
        // nothing ran while the ask waited
        expect(effects()).toBe(before);
        if (kind === "outside-sandbox")
          expect(ask.detail).toMatchObject({ escalation: { justification: JUSTIFICATION } });
        if (kind === "host")
          expect(ask.detail).toMatchObject({ permissionScope: { hosts: [HOST] } });
        if (kind === "directory")
          expect(ask.detail).toMatchObject({
            permissionScope: { writeDirectories: [`/srv/cap-${profile}`] },
          });
        r = await approveThrough(s, conv, ask.id, ++n);
        expect(r.payload.review).toMatchObject({ decision: "allow", by: "person" });
      } else {
        r = await call(s, conv, key, input, ++n);
        expect(r.payload.review).toMatchObject({
          decision: "allow",
          decisionSource: profile === "full-access" ? "full-access" : "review-model",
          crossing: kind,
        });
      }
      expect(r.payload.isError, r.payload.content).toBe(false);
      expectRanOnce(d, kind, profile);
    }

    const grants = await grantsOf(conv);
    // a grant per crossing; the sensitive command has no reach to grant
    expect(grants.map((g) => g.scope_kind)).toEqual([
      "directories-and-hosts",
      "directories-and-hosts",
      "sandbox-escalation",
    ]);
    const source =
      profile === "request-approval"
        ? "human"
        : profile === "approve-for-me"
          ? "review-model"
          : "full-access";
    expect(grants.map((g) => g.source)).toEqual([source, source, source]);
    const audits = await autoGrantAudits(d.deviceId);
    const approvals = await db
      .selectFrom("approvals")
      .select("status")
      .where("conversation_id", "=", conv)
      .execute();
    if (profile === "full-access") {
      // recorded exactly once each: the grant, its permission_reviewed event and the audit row
      expect(audits.map((a) => (a.detail as { kind: string }).kind)).toEqual([
        "directory",
        "host",
        "outside-sandbox",
      ]);
      expect(audits.every((a) => a.actor_account_id === ownerId)).toBe(true);
      const reviewed = await reviewedEvents(conv);
      expect(reviewed.map((e) => [e.decisionSource, e.crossing])).toEqual([
        ["full-access", "directory"],
        ["full-access", "host"],
        ["full-access", "outside-sandbox"],
      ]);
      expect(grants.map((g) => g.review_event_seq)).toEqual(
        expect.arrayContaining([expect.any(Number)]),
      );
      expect(approvals).toEqual([]);
      // nobody decided: the review model was never asked
      expect(await reviewModelCalls(conv)).toBe(0);
    } else {
      expect(audits).toEqual([]);
      expect(approvals.map((a) => a.status)).toEqual(
        profile === "request-approval" ? ["approved", "approved", "approved", "approved"] : [],
      );
      if (profile === "approve-for-me") expect(await reviewModelCalls(conv)).toBe(4);
    }
  }

  it("Request approval: every crossing asks the person (approved on B) and runs once on A", async () => {
    await matrix("request-approval");
  });
  it("Approve for me: the review model decides every crossing", async () => {
    await matrix("approve-for-me");
  });
  it("Full access: every crossing is auto-granted once, recorded and audited; the sandbox stays", async () => {
    await matrix("full-access");
  });

  it("Full access: an escalation carrying a credential consent goes to the review model", async () => {
    const s = await scene();
    const d = await localDevice(s, { network: "open" });
    const conv = await conversation(s, d.deviceId);
    await call(s, conv, "Bash", { command: "echo bound", description: "Bind" }, 1);
    await setProfile(s, conv, "full-access");
    reviewModelAnswers("allow");
    const r = await call(
      s,
      conv,
      "Bash",
      {
        command: "gh auth token",
        description: "Token",
        sandbox: "escalated",
        justification: JUSTIFICATION,
      },
      2,
    );
    expect(r.payload.isError, r.payload.content).toBe(false);
    expect(r.payload.review).toMatchObject({ decisionSource: "review-model", by: "classifier" });
    expect(await reviewModelCalls(conv)).toBe(1);
    // not an auto-grant: the review model's grant, no auto-grant audit row
    expect((await grantsOf(conv)).map((g) => g.source)).toEqual(["review-model"]);
    expect(await autoGrantAudits(d.deviceId)).toEqual([]);
    const exec = d.reqs("exec").find((x) => commandOf(x) === "gh auth token");
    expect(exec && scopeOf(exec).filesystem).toEqual({ kind: "device" });
  });
});

describe("a profile change while a card waits", () => {
  it("Approve for me → Full access: the card is superseded, the crossing auto-granted and run once", async () => {
    const s = await scene();
    const d = await localDevice(s, { network: "open" });
    const conv = await conversation(s, d.deviceId);
    // the review model is unsure: the crossing falls back to the person
    reviewModelAnswers("ask");
    const target = "/srv/cap-switch/note.txt";
    await postMessage(
      ownerA,
      s.orgId,
      conv,
      `tool:Write:${JSON.stringify({ file_path: target, content: "x" })}`,
    );
    const ask = await pendingAsk(conv);
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("runs")
            .select("status")
            .where("conversation_id", "=", conv)
            .executeTakeFirst()
        )?.status === "waiting",
      30_000,
      "the run waiting on the card",
    );
    await setProfile(s, conv, "full-access");
    await waitForTerminal(db, conv, 1, 60_000);
    const r = (await results(conv)).at(-1) as ToolResult;
    expect(r.payload.isError, r.payload.content).toBe(false);
    expect(r.payload.review).toMatchObject({
      decisionSource: "full-access",
      crossing: "directory",
    });
    const card = await db
      .selectFrom("approvals")
      .select("status")
      .where("id", "=", ask.id)
      .executeTakeFirstOrThrow();
    expect(card.status).toBe("superseded");
    expect((await grantsOf(conv)).map((g) => g.source)).toEqual(["full-access"]);
    expect(await autoGrantAudits(d.deviceId)).toHaveLength(1);
    expect(
      d.reqs("writeFile").filter((x) => (x.args as { path?: string }).path === target),
    ).toHaveLength(1);
  });
});

/** Waits until a session of the database is blocked on a lock (advisory or row). */
const lockWaiter = () =>
  waitFor(
    async () =>
      Number(
        (
          await sql<{ n: string }>`SELECT count(*) AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'`.execute(raw)
        ).rows[0]?.n ?? 0,
      ) > 0,
    30_000,
    "a writer blocked on the authority lock",
  );

describe("a ceiling narrowing racing a Full access auto-grant", () => {
  it("outside-sandbox off while the auto-grant is being written: the escalation never runs after it", async () => {
    const s = await scene();
    const d = await localDevice(s, { network: "open" });
    const conv = await conversation(s, d.deviceId);
    // bind the device first so the race is only the grant and the narrowing
    const bound = await call(s, conv, "Bash", { command: "echo bound", description: "Bind" }, 1);
    expect(bound.payload.isError, bound.payload.content).toBe(false);
    await setProfile(s, conv, "full-access");
    let arrive!: () => void;
    const arrived = new Promise<void>((r) => {
      arrive = r;
    });
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    autoGrantBarrier = async () => {
      arrive();
      await released;
    };
    await postMessage(
      ownerA,
      s.orgId,
      conv,
      `tool:Bash:${JSON.stringify({
        command: "echo raced",
        description: "Escalate",
        sandbox: "escalated",
        justification: JUSTIFICATION,
      })}`,
    );
    // replica A holds the authority lock inside the auto-grant's transaction
    await arrived;
    const narrowing = orgSettings(s, { outsideSandbox: "off" });
    // replica B's ceiling writer waits on that lock
    await lockWaiter();
    release();
    await narrowing;
    const narrowedAt = new Date();
    await waitForTerminal(db, conv, 2, 60_000);
    const r = (await results(conv)).at(-1) as ToolResult;
    // either the auto-grant won (and its admission is refused or revoked) or it was refused: the
    // escalated command never runs once the narrowing committed
    expect(r.payload.isError).toBe(true);
    expect(d.reqs("exec").filter((x) => commandOf(x) === "echo raced")).toEqual([]);
    const escalated = await db
      .selectFrom("sandbox_operation_intents")
      .select(["state", "scope", "created_at"])
      .where("conversation_id", "=", conv)
      .execute();
    for (const i of escalated) {
      const scope = i.scope as unknown as Scope;
      if (scope.filesystem.kind !== "device") continue;
      // admitted before the narrowing at most, and then revoked
      expect(new Date(i.created_at as unknown as string) <= narrowedAt).toBe(true);
      expect(i.state).toBe("revoked");
    }
    // an auto-grant that won is recorded exactly once
    const audits = await autoGrantAudits(d.deviceId);
    expect(audits.length).toBeLessThanOrEqual(1);
    expect((await grantsOf(conv)).length).toBe(audits.length);
  });
});

/** The background task of `conv` whose command is `command`, once it runs. */
const runningTask = (conv: string, command: string) =>
  waitFor(
    async () =>
      db
        .selectFrom("background_tasks")
        .select(["id", "status", "operation_id"])
        .where("conversation_id", "=", conv)
        .where("command", "=", command)
        .where("status", "=", "running")
        .executeTakeFirst(),
    30_000,
    `the running task ${command}`,
  );

/** The operation ids of the background tasks the device was told to stop or revoke. */
const stopsOf = (d: LocalDevice) =>
  [...d.reqs("backgroundStop"), ...d.reqs("revokeOperation")].map(
    (r) => (r.args as { ref: { operationId: string } }).ref.operationId,
  );

const taskStatus = async (id: string) =>
  (
    await db
      .selectFrom("background_tasks")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).status;

/** Waits until the device stopped `task` by its exact reference and the task is stopped. */
async function stoppedOnDevice(
  d: LocalDevice,
  _conv: string,
  task: { id: string; operation_id: string | null },
): Promise<void> {
  await waitFor(
    async () =>
      stopsOf(d).includes(task.operation_id as string) && (await taskStatus(task.id)) === "stopped",
    30_000,
    `the task ${task.id} stopped on the device`,
  );
}

/**
 * Waits until the run woken by `task`'s finish (a revocation's stop has no `stoppedBy`, so it
 * wakes the conversation) has ended and the conversation is idle; returns its terminal count. The
 * wake run and a message posted meanwhile may or may not share a run, so a following {@link call}
 * counts its terminal from here.
 */
async function wakeSettled(conv: string, task: { id: string }): Promise<number> {
  return waitFor(
    async () => {
      const events = await eventsOf(db, conv);
      const finished = events.find(
        (e) =>
          e.type === "background_task_finished" &&
          (e.payload as { taskId?: string }).taskId === task.id,
      );
      if (!finished) return null;
      const started = events.filter((e) => e.type === "run_started");
      const ended = events.filter((e) =>
        ["run_finished", "run_failed", "run_aborted"].includes(e.type),
      );
      const woken = started.some((e) => e.seq > finished.seq);
      return woken && started.length === ended.length ? ended.length : null;
    },
    30_000,
    `the wake run of the task ${task.id} ended`,
  );
}

const intentState = async (operationId: string | null) =>
  (
    await db
      .selectFrom("sandbox_operation_intents")
      .select("state")
      .where("operation_id", "=", operationId as string)
      .executeTakeFirstOrThrow()
  ).state;

describe("ceiling narrowings revoke exactly the work they take", () => {
  it("outside-sandbox off revokes an escalated background task and keeps its sandboxed sibling", async () => {
    const s = await scene();
    const d = await localDevice(s, { network: "open" });
    const conv = await conversation(s, d.deviceId);
    await call(s, conv, "Bash", { command: "echo bound", description: "Bind" }, 1);
    await setProfile(s, conv, "full-access");
    const escalated = await call(
      s,
      conv,
      "Bash",
      {
        command: "sleep 301",
        description: "Serve",
        run_in_background: true,
        sandbox: "escalated",
        justification: JUSTIFICATION,
      },
      2,
    );
    expect(escalated.payload.isError, escalated.payload.content).toBe(false);
    const sibling = await call(
      s,
      conv,
      "Bash",
      { command: "sleep 302", description: "Watch", run_in_background: true },
      3,
    );
    expect(sibling.payload.isError, sibling.payload.content).toBe(false);
    const outside = await runningTask(conv, "sleep 301");
    const inside = await runningTask(conv, "sleep 302");
    expect(await autoGrantAudits(d.deviceId)).toHaveLength(1);

    await orgSettings(s, { outsideSandbox: "off" });
    expect(await intentState(outside.operation_id)).toBe("revoked");
    expect(await intentState(inside.operation_id)).toBe("background-running");
    // the device stops exactly the escalated task by its reference; the sibling keeps running
    await stoppedOnDevice(d, conv, outside);
    expect(stopsOf(d)).not.toContain(inside.operation_id);
    expect(await taskStatus(inside.id)).toBe("running");
    // a narrowing keeps Full consent
    expect((await permissions(s, conv)).profile).toBe("full-access");
  });

  it("open → allowlist revokes running open-network work while an allowlist sibling survives; consent survives the narrowing and resets on the widening", async () => {
    const s = await scene();
    const open = await localDevice(s, { network: "open" });
    // the owner's allowlist names a host of the platform's default list
    const listed = await localDevice(s, {
      network: "allowlist",
      allowedDomains: ["registry.npmjs.org"],
    });
    const convOpen = await conversation(s, open.deviceId);
    const convListed = await conversation(s, listed.deviceId);
    await call(s, convOpen, "Bash", { command: "echo bound", description: "Bind" }, 1);
    await setProfile(s, convOpen, "full-access");
    const a = await call(
      s,
      convOpen,
      "Bash",
      { command: "sleep 303", description: "Install", run_in_background: true },
      2,
    );
    expect(a.payload.isError, a.payload.content).toBe(false);
    const b = await call(
      s,
      convListed,
      "Bash",
      { command: "sleep 304", description: "Watch", run_in_background: true },
      1,
    );
    expect(b.payload.isError, b.payload.content).toBe(false);
    const onOpen = await runningTask(convOpen, "sleep 303");
    const onList = await runningTask(convListed, "sleep 304");
    const openStart = open.reqs("backgroundStart").at(-1) as KernelReq;
    expect(scopeOf(openStart).network.kind).toBe("open-public");
    expect(scopeOf(listed.reqs("backgroundStart").at(-1) as KernelReq).network.kind).toBe(
      "allowlist",
    );

    // the org's ceiling narrows to the allowlist (through replica B)
    await orgSettings(s, { deviceNetwork: { ceiling: "allowlist" } });
    expect(await intentState(onOpen.operation_id)).toBe("revoked");
    expect(await intentState(onList.operation_id)).toBe("background-running");
    await stoppedOnDevice(open, convOpen, onOpen);
    expect(stopsOf(listed)).toEqual([]);
    expect(await taskStatus(onList.id)).toBe("running");
    // the narrowing keeps Full consent: Full access would now approve less
    expect((await permissions(s, convOpen)).profile).toBe("full-access");
    // the next call runs on the allowlist (after the wake run the stop's finish started)
    const ended = await wakeSettled(convOpen, onOpen);
    const next = await call(
      s,
      convOpen,
      "Bash",
      { command: "echo after", description: "Run" },
      ended + 1,
    );
    expect(next.payload.isError, next.payload.content).toBe(false);
    expect(
      scopeOf(open.reqs("exec").find((x) => commandOf(x) === "echo after") as KernelReq).network
        .kind,
    ).toBe("allowlist");

    // widening the ceiling again resets Full consent with a recorded profile change
    await orgSettings(s, { deviceNetwork: { ceiling: "open" } });
    expect((await permissions(s, convOpen)).profile).toBe("approve-for-me");
    const changed = (await eventsOf(db, convOpen)).filter(
      (e) => e.type === "permission_profile_changed",
    );
    expect(changed.at(-1)?.payload).toMatchObject({
      oldProfile: "full-access",
      newProfile: "approve-for-me",
    });
  });
});

describe("a stored version 1 permission context", () => {
  it("is read as version 2 by the worker replica: the run goes on and records one new snapshot", async () => {
    await setFakeSandboxPermissionSupport(sandboxRoot, null);
    const s = await scene();
    const created = await ownerA({
      method: "POST",
      url: `/api/v1/orgs/${s.orgId}/devices`,
      payload: { name: `Cloud ${randomUUID().slice(0, 8)}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const deviceId = (created.json() as { device: { id: string } }).device.id;
    const conv = await conversation(s, deviceId);
    // the first run starts the device; the second records the supported context with its block
    await setProfile(s, conv, "request-approval");
    for (const [n, command] of [
      [1, "echo one"],
      [2, "echo two"],
    ] as const) {
      const r = await call(s, conv, "Bash", { command, description: "Run" }, n);
      expect(r.payload.isError, r.payload.content).toBe(false);
    }
    const contexts = () =>
      db
        .selectFrom("conversation_events")
        .select(["seq", "payload", "idem_key"])
        .where("conversation_id", "=", conv)
        .where("type", "=", "permission_context")
        .orderBy("seq")
        .execute();
    const recorded = (await contexts()).at(-1);
    if (!recorded) throw new Error("no permission context recorded");
    const v2 = recorded.payload as Record<string, unknown>;
    expect(v2).toMatchObject({ version: 2, sandbox: { location: "cloud" } });
    const before = (await contexts()).length;
    // an older replica's row: version 1, no sandbox block (the kernel never rewrites the log; the
    // test stands in for the older writer)
    const { sandbox: _sandbox, ...rest } = v2;
    await db
      .updateTable("conversation_events")
      .set({ payload: JSON.stringify({ ...rest, version: 1 }) })
      .where("conversation_id", "=", conv)
      .where("seq", "=", recorded.seq)
      .execute();
    // the profile view is still served by the API replica
    expect((await permissions(s, conv)).profile).toBe("request-approval");
    const third = await call(s, conv, "Bash", { command: "echo three", description: "Run" }, 3);
    expect(third.payload.isError, third.payload.content).toBe(false);
    // the v1 prior reads as v2 with no block: the run records the block once, after it
    const after = await contexts();
    expect(after).toHaveLength(before + 1);
    const latest = after.at(-1) as (typeof after)[number];
    expect(latest.payload).toEqual(v2);
    expect(String(latest.idem_key).endsWith(`:${recorded.seq}`)).toBe(true);
    const runs = await db
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", conv)
      .execute();
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
  });
});

describe("Full access chosen before a device's first start", () => {
  // approval-only profiles design, "Consent fingerprint": a runtime report arriving only narrows
  // what the consent covers, so the device's first start never resets it
  it("keeps the consent when the device starts with the roots its machine reported", async () => {
    const s = await scene();
    const d = await localDevice(s, { network: "open" });
    const conv = await conversation(s, d.deviceId);
    await setProfile(s, conv, "full-access");
    const first = await call(s, conv, "Bash", { command: "echo first", description: "Run" }, 1);
    expect(first.payload.isError, first.payload.content).toBe(false);
    expect((await permissions(s, conv)).profile).toBe("full-access");
    expect(
      (await eventsOf(db, conv)).filter((e) => e.type === "permission_profile_changed"),
    ).toHaveLength(1);
  });

  it("keeps the consent when a cloud device's first instance has the roots the consent covered", async () => {
    await setFakeSandboxPermissionSupport(sandboxRoot, null);
    const s = await scene();
    const created = await ownerA({
      method: "POST",
      url: `/api/v1/orgs/${s.orgId}/devices`,
      payload: { name: `Cloud ${randomUUID().slice(0, 8)}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const deviceId = (created.json() as { device: { id: string } }).device.id;
    const conv = await conversation(s, deviceId);
    await setProfile(s, conv, "full-access");
    const first = await call(s, conv, "Bash", { command: "echo first", description: "Run" }, 1);
    expect(first.payload.isError, first.payload.content).toBe(false);
    expect((await permissions(s, conv)).profile).toBe("full-access");
  });
});
