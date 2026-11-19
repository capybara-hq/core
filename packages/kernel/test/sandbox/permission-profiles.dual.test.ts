import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelReq, LegacyDeviceHello } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { PERMISSION_UNSUPPORTED_TOOL_TEXT } from "../../src/tools/builtins/sandbox/common.js";
import {
  readFakeSandboxOps,
  setFakeSandboxPermissionSupport,
} from "../fixtures/plugins/sandbox-fake/index.js";
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
import { FakeMachineV3, ownerReportFor } from "../local-devices/fake-machine-v3.js";
import type { Answer } from "../local-devices/test-holder.js";

/**
 * Cross-runtime product acceptance, kernel side (permission profile delivery plan, Task 14): the
 * owner API, the policy, the fresh per-call facade and the provider, end to end on two kernel
 * replicas that share only PostgreSQL, Redis and the fake provider's backing directory. Replica A
 * runs the worker and the device gateway; replica B serves the API only, so every profile change
 * and every decision made through B reaches A's runs through the database, never process memory.
 *
 * The provider is `sandbox-fake` (a real /bin/sh over a temporary directory that checks each
 * operation's scope) for cloud devices, and a protocol 3 fake machine on a real WebSocket for the
 * local device. Races, injected faults and replay are covered by the suites this file's header in
 * the evidence report maps (permission-approvals.dual, platform-revocation-e2e,
 * revocation-reconnect.dual, permission-wiring, operation-scopes.dual, evals/run-replay); this file
 * adds the end-to-end matrix those suites take as given.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

type Profile = "request-approval" | "approve-for-me" | "full-access";
type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>;
type Scope = {
  profile: Profile;
  filesystem: { kind: "device" } | { kind: "scoped"; readRoots: string[]; writeRoots: string[] };
  network: { kind: string };
};

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
let orgId: string;
let agentId: string;
const machines: FakeMachineV3[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-profiles-dual-"));
  const config = (roles: string[]) =>
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles,
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root: sandboxRoot } },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        devices: { local: { reconnectGraceSeconds: 30, leaseTtlMs: 6000 } },
      },
    );
  kA = await startKernel(config(["api", "worker", "gateway"]));
  kB = await startKernel(config(["api"]));
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  ownerA = await session(kA, "owner");
  ownerB = await session(kB, "owner");
  orgId = await createOrgWithProviders(kA, ownerA);
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
  agentId = (created.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  for (const m of machines.splice(0)) m.close();
  await kA?.close();
  await kB?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

const results = async (conv: string): Promise<ToolResult[]> =>
  (await eventsOf(db, conv)).filter((e): e is ToolResult => e.type === "tool_result");

/** Posts one tool call on replica A and waits for the conversation's `n`th terminal event. */
async function call(conv: string, key: string, input: unknown, n: number): Promise<ToolResult> {
  await postMessage(ownerA, orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 60_000);
  const r = (await results(conv)).at(-1);
  expect(r?.payload.toolKey).toBe(key);
  return r as ToolResult;
}

/** A new cloud device of the owner on sandbox-fake, created through the API. */
async function cloudDevice(): Promise<string> {
  const res = await ownerA({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/devices`,
    payload: { name: `Cloud ${randomUUID().slice(0, 8)}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { device: { id: string } }).device.id;
}

/** A conversation on `deviceId` (optionally bound to one of its projects), created on replica A. */
async function conversation(deviceId: string, project?: string): Promise<string> {
  const res = await ownerA({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations`,
    payload: { agentId, deviceId, ...(project !== undefined && { project }) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { conversation: { id: string } }).conversation.id;
}

interface PermissionsBody {
  profile: Profile;
  revision: number;
  scopeRevision: string | null;
  availability: { state: string; reason?: string; report?: { restricted: unknown } };
}

/** The owner's permissions view, read through replica B. */
async function permissions(conv: string): Promise<PermissionsBody> {
  const res = await ownerB({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/permissions`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as PermissionsBody;
}

/** Changes the profile through replica B's owner API (Full access with the displayed consent). */
async function setProfile(conv: string, profile: Profile): Promise<PermissionsBody> {
  const view = await permissions(conv);
  const res = await ownerB({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/permissions`,
    payload: {
      profile,
      expectedRevision: view.revision,
      ...(profile === "full-access" && view.scopeRevision !== null
        ? { consentScopeRevision: view.scopeRevision }
        : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const after = await permissions(conv);
  expect(after.profile).toBe(profile);
  expect(after.revision).toBe(view.revision + 1);
  return after;
}

const approvalsOf = (conv: string) =>
  db
    .selectFrom("approvals")
    .select(["id", "status", "detail"])
    .where("conversation_id", "=", conv)
    .orderBy("created_at")
    .execute();

const intentsOf = async (conv: string) =>
  (
    await db
      .selectFrom("sandbox_operation_intents")
      .select(["method", "scope", "permission_grant_id", "created_at"])
      .where("conversation_id", "=", conv)
      .orderBy("created_at")
      .execute()
  ).map((i) => ({ ...i, scope: i.scope as unknown as Scope }));

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

/** Denies an ask through replica B, then waits for the run A parked on it to end. */
async function denyThrough(conv: string, askId: string, terminal: number): Promise<ToolResult> {
  const res = await ownerB({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${askId}/decision`,
    payload: { decision: "deny", reason: "Not in this test." },
  });
  expect(res.statusCode, res.body).toBe(200);
  await waitForTerminal(db, conv, terminal, 60_000);
  return (await results(conv)).at(-1) as ToolResult;
}

/** A restricted scope that can read `root` (a native read may get no write roots at all). */
const readsWithin = (root: string) =>
  expect.objectContaining({ kind: "scoped", readRoots: expect.arrayContaining([root]) });

/** The restricted scope the provider gets for a conversation working in `root`. */
const scopedTo = (root: string) =>
  expect.objectContaining({
    kind: "scoped",
    writeRoots: [root],
    readRoots: expect.arrayContaining([root]),
  });

/**
 * One profile through the matrix: in-project Bash, Read, Write, Edit and a background start and
 * stop run with the profile's scope and ask no one; an outside write follows the profile.
 */
async function matrix(profile: Profile): Promise<void> {
  const deviceId = await cloudDevice();
  const conv = await conversation(deviceId);
  // the first call starts the device under the default profile
  const bound = await call(conv, "Bash", { command: "echo bound", description: "Bind" }, 1);
  expect(bound.payload.isError, bound.payload.content).toBe(false);
  if (profile !== "approve-for-me") await setProfile(conv, profile);
  const before = (await intentsOf(conv)).length;
  const file = `/workspace/matrix-${profile}.txt`;
  let n = 1;

  const write = await call(conv, "Write", { file_path: file, content: "alpha\n" }, ++n);
  expect(write.payload.isError, write.payload.content).toBe(false);
  const read = await call(conv, "Read", { file_path: file }, ++n);
  expect(read.payload.isError, read.payload.content).toBe(false);
  expect(read.payload.content).toContain("alpha");
  const edit = await call(
    conv,
    "Edit",
    { file_path: file, old_string: "alpha", new_string: "beta" },
    ++n,
  );
  expect(edit.payload.isError, edit.payload.content).toBe(false);
  const bash = await call(conv, "Bash", { command: `cat ${file}`, description: "Show" }, ++n);
  expect(bash.payload.isError, bash.payload.content).toBe(false);
  expect(bash.payload.content).toContain("beta");
  const started = await call(
    conv,
    "Bash",
    { command: "sleep 120", description: "Wait", run_in_background: true },
    ++n,
  );
  expect(started.payload.isError, started.payload.content).toBe(false);
  const task = await waitFor(
    async () =>
      db
        .selectFrom("background_tasks")
        .select(["id", "status", "operation_id", "profile_revision"])
        .where("conversation_id", "=", conv)
        .where("status", "=", "running")
        .executeTakeFirst(),
    30_000,
    "the running background task",
  );
  const stopped = await call(conv, "TaskStop", { task_id: task.id }, ++n);
  expect(stopped.payload.isError, stopped.payload.content).toBe(false);
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("background_tasks")
          .select("status")
          .where("id", "=", task.id)
          .executeTakeFirstOrThrow()
      ).status === "stopped",
    30_000,
    "the task stopped by its ref",
  );

  // none of the in-project work asked anyone, under any profile
  expect(await approvalsOf(conv)).toEqual([]);
  const ran = (await intentsOf(conv)).slice(before);
  expect(new Set(ran.map((i) => i.method))).toEqual(
    new Set(["writeFile", "readFile", "exec", "backgroundStart", "stat"]),
  );
  for (const i of ran) {
    expect(i.scope.profile, i.method).toBe(profile);
    if (profile === "full-access") {
      expect(i.scope.filesystem, i.method).toEqual({ kind: "device" });
      expect(i.scope.network, i.method).toEqual({ kind: "environment" });
    } else expect(i.scope.filesystem, i.method).toEqual(scopedTo("/workspace"));
    expect(i.permission_grant_id, i.method).toBeNull();
  }

  // outside the project: Request approval asks the person; Approve for me has no review model
  // here, so it asks too; Full access writes with the device's authority and asks no one
  const writesBefore = (await intentsOf(conv)).filter((i) => i.method === "writeFile").length;
  const outside = `/etc/capybara-matrix-${profile}/note.txt`;
  await postMessage(
    ownerA,
    orgId,
    conv,
    `tool:Write:${JSON.stringify({ file_path: outside, content: "x" })}`,
  );
  if (profile === "full-access") {
    await waitForTerminal(db, conv, ++n, 60_000);
    const r = (await results(conv)).at(-1) as ToolResult;
    expect(r.payload.isError, r.payload.content).toBe(false);
    expect(r.payload.content).toContain(`Created ${outside}`);
    expect(r.payload.review).toMatchObject({ decisionSource: "full-access" });
    expect(await approvalsOf(conv)).toEqual([]);
  } else {
    const ask = await pendingAsk(conv);
    expect(ask.detail as Record<string, unknown>).toMatchObject({
      kind: "write",
      targetPath: outside,
      permissionScope: { writeDirectories: [`/etc/capybara-matrix-${profile}`] },
    });
    const denied = await denyThrough(conv, ask.id, ++n);
    expect(denied.payload.isError).toBe(true);
    expect(denied.payload.review).toMatchObject({ decision: "deny", by: "person" });
    // the refused write never reached the provider
    expect((await intentsOf(conv)).filter((i) => i.method === "writeFile")).toHaveLength(
      writesBefore,
    );
  }
}

describe("profile × operation matrix through the owner API on two replicas", () => {
  it("Request approval: in-project work runs with its scope; outside work follows the profile", async () => {
    await matrix("request-approval");
  });
  it("Approve for me: in-project work runs with its scope; outside work follows the profile", async () => {
    await matrix("approve-for-me");
  });
  it("Full access: in-project work runs with its scope; outside work follows the profile", async () => {
    await matrix("full-access");
  });
});

describe("a profile change applies to following operations only", () => {
  it("Full → Request approval: started work keeps its grant, new reads and writes get the narrow scope", async () => {
    const deviceId = await cloudDevice();
    const conv = await conversation(deviceId);
    expect(
      (await call(conv, "Bash", { command: "echo bound", description: "Bind" }, 1)).payload.isError,
    ).toBe(false);
    const full = await setProfile(conv, "full-access");
    const started = await call(
      conv,
      "Bash",
      { command: "sleep 120", description: "Wait", run_in_background: true },
      2,
    );
    expect(started.payload.isError, started.payload.content).toBe(false);
    const task = await waitFor(
      async () =>
        db
          .selectFrom("background_tasks")
          .select(["id", "status", "profile_revision"])
          .where("conversation_id", "=", conv)
          .where("status", "=", "running")
          .executeTakeFirst(),
      30_000,
      "the Full background task",
    );
    expect(task.profile_revision).toBe(full.revision);
    const stopsBefore = (await readFakeSandboxOps(sandboxRoot)).filter(
      (o) => o[0] === "bg-stop" || o[0] === "revoke",
    ).length;
    const outside = "/etc/capybara-change/before.txt";
    const wrote = await call(conv, "Write", { file_path: outside, content: "full" }, 3);
    expect(wrote.payload.isError, wrote.payload.content).toBe(false);

    const narrow = await setProfile(conv, "request-approval");
    // narrowing alone cancels nothing: the started task still runs with its starting revision
    expect(
      await db
        .selectFrom("background_tasks")
        .select(["status", "profile_revision"])
        .where("id", "=", task.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "running", profile_revision: full.revision });
    expect(
      (await readFakeSandboxOps(sandboxRoot)).filter(
        (o) => o[0] === "bg-stop" || o[0] === "revoke",
      ),
    ).toHaveLength(stopsBefore);

    // a read of what Full wrote outside the project is now outside the scope: it asks
    await postMessage(ownerA, orgId, conv, `tool:Read:${JSON.stringify({ file_path: outside })}`);
    const readAsk = await pendingAsk(conv);
    expect(readAsk.detail as Record<string, unknown>).toMatchObject({
      permissionScope: { readDirectories: ["/etc/capybara-change"] },
    });
    await denyThrough(conv, readAsk.id, 4);
    // an outside write asks as well, and in-project work runs at once under the new revision
    await postMessage(
      ownerA,
      orgId,
      conv,
      `tool:Write:${JSON.stringify({ file_path: "/etc/capybara-change/after.txt", content: "x" })}`,
    );
    const writeAsk = await pendingAsk(conv);
    await denyThrough(conv, writeAsk.id, 5);
    const inside = await call(
      conv,
      "Write",
      { file_path: "/workspace/after.txt", content: "inside" },
      6,
    );
    expect(inside.payload.isError, inside.payload.content).toBe(false);
    const read = await call(conv, "Read", { file_path: "/workspace/after.txt" }, 7);
    expect(read.payload.content).toContain("inside");
    const latest = (await intentsOf(conv)).filter((i) =>
      ["writeFile", "readFile"].includes(i.method),
    );
    expect(latest.at(-1)?.scope).toMatchObject({
      profile: "request-approval",
      filesystem: scopedTo("/workspace"),
    });
    expect(narrow.revision).toBe(full.revision + 1);

    // the person can still stop the started task by its exact reference
    const stopped = await call(conv, "TaskStop", { task_id: task.id }, 8);
    expect(stopped.payload.isError, stopped.payload.content).toBe(false);
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("background_tasks")
            .select("status")
            .where("id", "=", task.id)
            .executeTakeFirstOrThrow()
        ).status === "stopped",
      30_000,
      "the Full task stopped",
    );
  });
});

describe("a local device's project outside its fixed workspace", () => {
  const HOME = "/home/me";
  const ROOTS = {
    workspace: "/home/me/.capybara/box/workspace",
    skills: "/home/me/.capybara/box/skills",
    tmp: "/home/me/.capybara/box/tmp",
  };
  const PROJECT = "/home/me/code/app";

  it("the first call of a restricted conversation is a Read of the project: the device gets the project as its root", async () => {
    const { deviceId, credential } = await kA.app.get(TransactionHost).run(async () => {
      const { id } = await kA.app.get(DevicesService).createLocal(orgId, ownerId, "Laptop");
      const issued = await kA.app.get(MachinesService).issue({
        orgId,
        deviceId: id,
        accountId: ownerId,
        name: "laptop",
        os: "linux",
        arch: "x64",
        programVersion: "0.1.0",
      });
      return { deviceId: id, credential: issued.credential };
    });
    const answer = (req: KernelReq): Answer => {
      const a = req.args as { path?: string };
      const op = String(req.op).replace(/^browse(\w)/, (_, c: string) => c.toLowerCase());
      switch (op) {
        case "create":
          return { ok: true, result: { roots: ROOTS } };
        case "stat":
          if (a.path === PROJECT) return { ok: true, result: { size: 0, isDir: true } };
          if (a.path === `${PROJECT}/README.md`)
            return { ok: true, result: { size: 11, isDir: false } };
          return { ok: true, result: null };
        case "list":
          return { ok: true, result: { entries: [], truncated: false } };
        case "readFile":
          return a.path === `${PROJECT}/README.md`
            ? {
                ok: true,
                result: {
                  dataB64: Buffer.from("hello app\n").toString("base64"),
                  truncated: false,
                },
              }
            : { ok: true, result: null };
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
      features: ["networkReport", "policyOp", "policyOpId", "mode", "projects"],
      policy: { mode: "auto", allowedDomains: [] },
    };
    machine.hello({
      ...hello,
      ownerCeiling: ownerReportFor(
        { allowedDomains: [] },
        { fullAccess: true, restrictedProjectReach: "os-user" },
      ),
    });
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
    // the owner adds the project through replica B (relative to the home in auto mode)
    const added = await ownerB({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/devices/${deviceId}/projects`,
      payload: { path: "code/app" },
    });
    expect(added.statusCode, added.body).toBe(201);
    const conv = await conversation(deviceId, "app");
    await setProfile(conv, "request-approval");

    const read = await call(conv, "Read", { file_path: `${PROJECT}/README.md` }, 1);
    expect(read.payload.isError, read.payload.content).toBe(false);
    expect(read.payload.content).toContain("hello app");
    expect(await approvalsOf(conv)).toEqual([]);
    // the first native request the machine got carries the project as the operation's root: no
    // earlier exec, and never the fixed device workspace instead
    const first = machine.frames.find(
      (f): f is KernelReq =>
        f.type === "req" &&
        ["readFile", "stat"].includes(String(f.op)) &&
        String((f.args as { path?: string }).path).startsWith(PROJECT),
    );
    expect(first).toBeDefined();
    const scope = ((first as KernelReq).args as { scope: Scope }).scope;
    expect(scope).toMatchObject({ profile: "request-approval", rootConversationId: conv });
    expect(scope.filesystem).toEqual(readsWithin(PROJECT));
    expect(
      machine.frames.some(
        (f) =>
          f.type === "req" &&
          String(f.op) === "exec" &&
          machine.frames.indexOf(f) < machine.frames.indexOf(first as KernelReq),
      ),
    ).toBe(false);
    // a write in the project needs no ask either
    const wrote = await call(conv, "Write", { file_path: `${PROJECT}/NEW.md`, content: "x" }, 2);
    expect(wrote.payload.isError, wrote.payload.content).toBe(false);
    const write = machine.frames.find(
      (f): f is KernelReq =>
        f.type === "req" &&
        String(f.op) === "writeFile" &&
        (f.args as { path?: string }).path === `${PROJECT}/NEW.md`,
    );
    expect(write).toBeDefined();
    expect(((write as KernelReq).args as { scope: Scope }).scope.filesystem).toEqual(
      scopedTo(PROJECT),
    );
  });
});

describe("a device whose runtime cannot enforce the restricted profiles", () => {
  it("restricted profiles refuse truthfully before any effect; Full access still runs", async () => {
    await setFakeSandboxPermissionSupport(sandboxRoot, {
      version: 1,
      restricted: null,
      fullAccess: true,
      background: true,
      unavailableReason: "No restricted runtime on this test provider",
    });
    try {
      const deviceId = await cloudDevice();
      const conv = await conversation(deviceId);
      const execsBefore = (await readFakeSandboxOps(sandboxRoot)).filter(
        (o) => o[0] === "exec",
      ).length;
      // the default Approve for me is restricted: refused with the actionable text, nothing ran
      const refused = await call(
        conv,
        "Bash",
        { command: "echo must-not-run", description: "Try" },
        1,
      );
      expect(refused.payload.isError).toBe(true);
      expect(refused.payload.content).toBe(PERMISSION_UNSUPPORTED_TOOL_TEXT);
      expect((await intentsOf(conv)).filter((i) => i.method === "exec")).toEqual([]);
      expect(
        (await readFakeSandboxOps(sandboxRoot)).filter(
          (o) => o[0] === "exec" && o.join(" ").includes("must-not-run"),
        ),
      ).toEqual([]);
      expect(
        (await readFakeSandboxOps(sandboxRoot)).filter((o) => o[0] === "exec").length,
      ).toBeLessThanOrEqual(execsBefore + 1);
      // the view tells the truth: restricted unavailable, the profile left as chosen (no widening)
      const view = await permissions(conv);
      expect(view.profile).toBe("approve-for-me");
      expect(view.availability.report?.restricted ?? null).toBeNull();
      // the same refusal for Request approval
      await setProfile(conv, "request-approval");
      const again = await call(conv, "Read", { file_path: "/workspace/x.txt" }, 2);
      expect(again.payload.content).toBe(PERMISSION_UNSUPPORTED_TOOL_TEXT);
      // Full access, explicitly chosen with its consent, runs
      await setProfile(conv, "full-access");
      const full = await call(conv, "Bash", { command: "echo full-ok", description: "Run" }, 3);
      expect(full.payload.isError, full.payload.content).toBe(false);
      expect(full.payload.content).toContain("full-ok");
      expect((await intentsOf(conv)).at(-1)?.scope.filesystem).toEqual({ kind: "device" });
    } finally {
      await setFakeSandboxPermissionSupport(sandboxRoot, null);
    }
  });
});

describe("a per-call sandbox escalation across replicas", () => {
  it("approved on replica B, it runs on replica A outside the sandbox once; the next call is sandboxed", async () => {
    const deviceId = await cloudDevice();
    const conv = await conversation(deviceId);
    const bound = await call(conv, "Bash", { command: "echo bound", description: "Bind" }, 1);
    expect(bound.payload.isError, bound.payload.content).toBe(false);
    await setProfile(conv, "request-approval");
    const justification = "The build writes the system cache outside the project.";
    await postMessage(
      ownerA,
      orgId,
      conv,
      `tool:Bash:${JSON.stringify({
        command: "echo escalated",
        description: "Escalate",
        sandbox: "escalated",
        justification,
      })}`,
    );
    const ask = await pendingAsk(conv);
    expect(ask.detail as Record<string, unknown>).toMatchObject({
      kind: "command",
      command: "echo escalated",
      escalation: { justification },
      workingRoot: "/workspace",
    });
    const res = await ownerB({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${ask.id}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, conv, 2, 60_000);
    const ran = (await results(conv)).at(-1) as ToolResult;
    expect(ran.payload.isError, ran.payload.content).toBe(false);
    expect(ran.payload.content).toContain("escalated");
    expect(ran.payload.review).toMatchObject({ by: "person", sandbox: "escalated" });
    const execs = (await intentsOf(conv)).filter((i) => i.method === "exec");
    const escalatedExec = execs.at(-1);
    expect(escalatedExec?.scope).toMatchObject({
      profile: "request-approval",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    });
    expect(escalatedExec?.permission_grant_id).not.toBeNull();
    // the next call of the conversation runs in the sandbox again: the grant was that call's only
    const next = await call(conv, "Bash", { command: "echo again", description: "Again" }, 3);
    expect(next.payload.isError, next.payload.content).toBe(false);
    const last = (await intentsOf(conv)).filter((i) => i.method === "exec").at(-1);
    expect(last?.scope.filesystem).toEqual(scopedTo("/workspace"));
    expect(last?.permission_grant_id).toBeNull();
    expect((await approvalsOf(conv)).filter((a) => a.status === "pending")).toEqual([]);
  });
});
