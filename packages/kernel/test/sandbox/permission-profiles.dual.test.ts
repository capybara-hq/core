import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { admissionUnavailableText } from "../../src/tools/builtins/sandbox/common.js";
import {
  FAKE_INSTANCE_PERMISSION_SUPPORT,
  readFakeSandboxOps,
  setFakeSandboxPermissionSupport,
} from "../fixtures/plugins/device-fake/index.js";
import { type Answer, EnvelopeMachine, type KernelReq } from "../helpers/dial-in-machine.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
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

/**
 * Cross-runtime product acceptance, kernel side (permission profile delivery plan, Task 14): the
 * owner API, the policy, the fresh per-call facade and the provider, end to end on two kernel
 * replicas that share only PostgreSQL, Redis and the fake provider's backing directory. Replica A
 * runs the worker and the device gateway; replica B serves the API only, so every profile change
 * and every decision made through B reaches A's runs through the database, never process memory.
 *
 * The provider is `device-fake` (a real /bin/sh over a temporary directory that checks each
 * operation's scope) for cloud devices, and `fake-dial-in` (an operation-boundary provider whose
 * machine answers on a real WebSocket) for a dial-in device with a project outside its workspace.
 * Races, injected faults and replay are covered by the suites this file's header in the evidence
 * report maps (permission-approvals.dual, platform-revocation-e2e, permission-wiring,
 * operation-scopes.dual, evals/run-replay); this file adds the end-to-end matrix those suites take
 * as given.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);

type Profile = "request-approval" | "approve-for-me" | "full-access";
type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>;
type Scope = {
  profile: Profile;
  filesystem:
    | { kind: "device" }
    | { kind: "scoped"; projectRoot: string | null; writeRoots: string[] };
  network: { kind: string };
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let sandboxRoot: string;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
/** Replica A: api, worker and gateway (runs every job and holds the device sockets). */
let kA: TestKernel;
/** Replica B: api only. */
let kB: TestKernel;
let ownerA: Req;
let ownerB: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
const machines: EnvelopeMachine[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-profiles-dual-"));
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  const config = (roles: string[]) =>
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles,
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "device-fake": { root: sandboxRoot } },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        // every case makes its own device
        devices: { maxPersonal: 30, local: { reconnectGraceSeconds: 30, leaseTtlMs: 6000 } },
      },
    );
  const boot = { bootstrap: { dir: bootstrap.dir }, bootstrapManifest: bootstrap.manifest };
  kA = await startKernel(config(["api", "worker", "gateway"]), boot);
  kB = await startKernel(config(["api"]), boot);
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
          ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TaskOutput", "TaskStop"].map(
            (name) => ({
              kind: "builtin" as const,
              name,
            }),
          ),
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
  await bootstrap?.cleanup();
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

/** A new cloud device of the owner on device-fake, created through the API (two providers are on). */
async function cloudDevice(): Promise<string> {
  const res = await ownerA({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/devices`,
    payload: { name: `Cloud ${randomUUID().slice(0, 8)}`, provider: "device-fake" },
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

/** Approves an ask once through replica B. */
async function approveThrough(askId: string): Promise<void> {
  const res = await ownerB({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${askId}/decision`,
    payload: { decision: "approve", scope: "once" },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** A restricted scope whose project is `root` (a native read may get no write roots at all). */
const readsWithin = (root: string) =>
  expect.objectContaining({ kind: "scoped", projectRoot: root });

/** The restricted scope the provider gets for a conversation working in `root`. */
const scopedTo = (root: string) => expect.objectContaining({ kind: "scoped", writeRoots: [root] });

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
    // the sandbox is the same under every profile: Full access keeps the scoped filesystem
    expect(i.scope.filesystem, i.method).toEqual(scopedTo("/workspace"));
    expect(i.scope.network.kind, i.method).not.toBe("environment");
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

  // reads are the provider's rule (device-provider spec §6.1): a Read outside the scope proposes
  // no read root and asks no one; what it may read is the device's to decide
  it("an outside Read asks no one: the device's own read rule decides it", async () => {
    const deviceId = await cloudDevice();
    const conv = await conversation(deviceId);
    const bound = await call(conv, "Bash", { command: "echo bound", description: "Bind" }, 1);
    expect(bound.payload.isError, bound.payload.content).toBe(false);
    await setProfile(conv, "request-approval");
    await call(conv, "Read", { file_path: "/etc/capybara-read/note.txt" }, 2);
    expect(
      await db.selectFrom("approvals").select("id").where("conversation_id", "=", conv).execute(),
    ).toEqual([]);
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

    // a read of what Full wrote outside the project asks no one: reads are the provider's rule
    await call(conv, "Read", { file_path: outside }, 4);
    expect(
      await db.selectFrom("approvals").select("id").where("conversation_id", "=", conv).execute(),
    ).toEqual([]);
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

describe("a dial-in device's project outside its fixed workspace", () => {
  const HOME = "/home/me";
  const PROJECT = "/home/me/code/app";

  /**
   * A machine answer over the in-memory `files` and `dirs`: every relayed operation (raw,
   * operation-scoped, preparation and owner browse) reads and writes them; exec answers as Glob
   * and Grep expect (`find` / `grep` in the project root).
   */
  const machineAnswer =
    (files: Map<string, string>, dirs: Set<string>) =>
    (req: KernelReq): Answer => {
      const a = req.args as { path?: string; data?: string };
      const op = String(req.op).replace(/^(browse|prepare)(\w)/, (_, _p, c: string) =>
        c.toLowerCase(),
      );
      switch (op) {
        case "resume":
          return "resumed";
        case "stat": {
          if (a.path !== undefined && dirs.has(a.path)) return { size: 0, isDir: true };
          const f = a.path === undefined ? undefined : files.get(a.path);
          return f === undefined ? null : { size: f.length, isDir: false };
        }
        case "list":
          return a.path !== undefined && dirs.has(a.path)
            ? { entries: [], truncated: false }
            : null;
        case "readFile": {
          const f = a.path === undefined ? undefined : files.get(a.path);
          return f === undefined
            ? null
            : { data: Buffer.from(f).toString("base64"), truncated: false };
        }
        case "writeFile":
          if (a.path !== undefined && a.data !== undefined)
            files.set(a.path, Buffer.from(a.data, "base64").toString());
          return null;
        case "exec":
          return {
            exitCode: 0,
            stdout: "./README.md\0",
            stderr: "",
            truncated: false,
            timedOut: false,
          };
        default:
          return null;
      }
    };

  /**
   * A `fake-dial-in` machine of the owner whose home is {@link HOME} and whose provider support
   * runs outside the sandbox when `outsideSandbox`, answering with `answer`, with the project at
   * {@link PROJECT} added through replica B and a Request approval conversation bound to it.
   */
  async function homeProject(
    label: string,
    outsideSandbox: boolean,
    answer: (req: KernelReq) => Answer,
  ): Promise<{ deviceId: string; machine: EnvelopeMachine; conv: string }> {
    const { deviceId, credential } = await kA.app.get(TransactionHost).run(async () => {
      const { id } = await kA.app
        .get(DevicesService)
        .createDialIn(orgId, ownerId, "fake-dial-in", label);
      const issued = await kA.app.get(DialInMachines).issue({
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
    const machine = new EnvelopeMachine(
      `ws://127.0.0.1:${kA.port}/device/connect`,
      credential,
      answer,
      { hello: false },
    );
    machines.push(machine);
    await machine.opened;
    machine.hello({ outsideSandbox, home: HOME });
    await machine.ready;
    await waitFor(
      async () =>
        (
          (
            await db
              .selectFrom("devices")
              .select("report")
              .where("id", "=", deviceId)
              .executeTakeFirst()
          )?.report as { home?: string } | null
        )?.home === HOME,
      15_000,
      "the device report stored",
    );
    // the owner adds the project through replica B (relative to the reported home)
    const added = await ownerB({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/devices/${deviceId}/projects`,
      payload: { path: "code/app" },
    });
    expect(added.statusCode, added.body).toBe(201);
    const conv = await conversation(deviceId, "app");
    await setProfile(conv, "request-approval");
    return { deviceId, machine, conv };
  }

  /**
   * A project outside the workspace, read first in a restricted conversation. Whether the
   * provider runs calls outside the sandbox decides only whether a call may run outside it: it
   * must not change which paths the file tools accept inside the project.
   */
  async function firstProjectRead(outsideSandbox: boolean): Promise<void> {
    const files = new Map([[`${PROJECT}/README.md`, "hello app\n"]]);
    const { machine, conv } = await homeProject(
      `Laptop ${outsideSandbox ? "on" : "off"}`,
      outsideSandbox,
      machineAnswer(files, new Set([PROJECT])),
    );

    const read = await call(conv, "Read", { file_path: `${PROJECT}/README.md` }, 1);
    expect(read.payload.isError, read.payload.content).toBe(false);
    expect(read.payload.content).toContain("hello app");
    expect(await approvalsOf(conv)).toEqual([]);
    // the first operation-scoped request the machine got carries the project as the operation's
    // root: no earlier exec, and never the fixed device workspace instead
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
  }

  it("the first call of a restricted conversation is a Read of the project: the device gets the project as its root", async () => {
    await firstProjectRead(true);
  });

  // R3 Mac dogfood (2026-11-20): with outside-sandbox off (a new install's default) the file tools
  // kept the fixed roots and refused the project, while Bash in it ran
  it("the same first Read when the provider keeps every call in the sandbox (outside-sandbox off)", async () => {
    await firstProjectRead(false);
  });

  /**
   * The file tools while the provider keeps every call in the sandbox (outside-sandbox off):
   * bounded by the operation's admitted scope, as `Bash` is, never by that switch. Every file
   * tool works in the project outside the workspace with no ask; a directory crossing outside it
   * follows the profile and, once approved or auto-granted, runs with the granted directory; a
   * protected path stays denied.
   */
  async function fileToolsOutsideOff(profile: Profile): Promise<void> {
    const NOTES = "/home/me/notes";
    const SECRET = "/home/me/.ssh/id_ed25519";
    const files = new Map<string, string>([
      [`${PROJECT}/README.md`, "hello app\n"],
      [`${NOTES}/todo.txt`, "buy milk\n"],
    ]);
    const { machine, conv } = await homeProject(
      `Laptop off ${profile}`,
      false,
      machineAnswer(files, new Set([PROJECT, NOTES])),
    );
    if (profile !== "request-approval") await setProfile(conv, profile);
    const native = (op: string, path: string) =>
      machine.frames.filter(
        (f): f is KernelReq =>
          f.type === "req" && String(f.op) === op && (f.args as { path?: string }).path === path,
      );
    let n = 0;

    // every file tool works in the project, with no ask
    const read = await call(conv, "Read", { file_path: `${PROJECT}/README.md` }, ++n);
    expect(read.payload.isError, read.payload.content).toBe(false);
    expect(read.payload.content).toContain("hello app");
    const wrote = await call(
      conv,
      "Write",
      { file_path: `${PROJECT}/NEW.md`, content: "one\n" },
      ++n,
    );
    expect(wrote.payload.isError, wrote.payload.content).toBe(false);
    const edited = await call(
      conv,
      "Edit",
      { file_path: `${PROJECT}/NEW.md`, old_string: "one", new_string: "two" },
      ++n,
    );
    expect(edited.payload.isError, edited.payload.content).toBe(false);
    expect(files.get(`${PROJECT}/NEW.md`)).toBe("two\n");
    const globbed = await call(conv, "Glob", { pattern: "**/*.md" }, ++n);
    expect(globbed.payload.isError, globbed.payload.content).toBe(false);
    expect(globbed.payload.content).toContain(`${PROJECT}/README.md`);
    const grepped = await call(conv, "Grep", { pattern: "hello", path: PROJECT }, ++n);
    expect(grepped.payload.isError, grepped.payload.content).toBe(false);
    expect(grepped.payload.content).toContain(`${PROJECT}/README.md`);
    expect(await approvalsOf(conv)).toEqual([]);

    // a directory crossing: Request approval and Approve for me (no review model here) ask the
    // person, Full access grants it; then the call runs with the granted directory
    const crossing = async (key: string, input: unknown, kind: "write") => {
      await postMessage(ownerA, orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
      if (profile !== "full-access") {
        const ask = await pendingAsk(conv);
        expect(ask.detail as Record<string, unknown>).toMatchObject({ kind });
        await approveThrough(ask.id);
      }
      await waitForTerminal(db, conv, ++n, 60_000);
      const r = (await results(conv)).at(-1) as ToolResult;
      expect(r.payload.toolKey).toBe(key);
      expect(r.payload.isError, r.payload.content).toBe(false);
      return r;
    };
    // a read outside the project is no crossing: it asks no one and reaches the machine, whose own
    // read rule decides it (a scope names no read roots)
    const outsideRead = await call(conv, "Read", { file_path: `${NOTES}/todo.txt` }, ++n);
    expect(outsideRead.payload.content).toContain("buy milk");
    expect(await approvalsOf(conv)).toEqual([]);
    const readReq = native("readFile", `${NOTES}/todo.txt`).at(-1);
    expect(readReq).toBeDefined();
    const readScope = ((readReq as KernelReq).args as { scope: Scope }).scope.filesystem;
    expect(readScope).not.toHaveProperty("readRoots");
    expect(readScope).toEqual(expect.objectContaining({ kind: "scoped" }));
    expect(readScope.kind === "scoped" && readScope.writeRoots).not.toContain(NOTES);
    await crossing(
      "Edit",
      { file_path: `${NOTES}/todo.txt`, old_string: "milk", new_string: "tea" },
      "write",
    );
    expect(files.get(`${NOTES}/todo.txt`)).toBe("buy tea\n");
    await crossing("Write", { file_path: `${NOTES}/new.txt`, content: "x" }, "write");
    expect(files.get(`${NOTES}/new.txt`)).toBe("x");
    const writeReq = native("writeFile", `${NOTES}/new.txt`).at(-1);
    expect(((writeReq as KernelReq).args as { scope: Scope }).scope.filesystem).toMatchObject({
      kind: "scoped",
      writeRoots: expect.arrayContaining([NOTES]),
    });

    // a protected path stays denied under every profile: nothing asks and nothing reaches it
    const asks = (await approvalsOf(conv)).length;
    const secret = await call(conv, "Read", { file_path: SECRET }, ++n);
    expect(secret.payload.isError).toBe(true);
    expect(secret.payload.review).toMatchObject({ decision: "deny" });
    expect(await approvalsOf(conv)).toHaveLength(asks);
    expect(native("readFile", SECRET)).toEqual([]);
  }

  it("Request approval with outside-sandbox off: the file tools follow the admitted scope", async () => {
    await fileToolsOutsideOff("request-approval");
  });
  it("Approve for me with outside-sandbox off: the file tools follow the admitted scope", async () => {
    await fileToolsOutsideOff("approve-for-me");
  });
  it("Full access with outside-sandbox off: the file tools follow the admitted scope", async () => {
    await fileToolsOutsideOff("full-access");
  });
});

describe("a device whose runtime cannot enforce its sandbox", () => {
  const RUNTIME_TEXT = admissionUnavailableText({ kind: "runtime" });
  it("every profile stays selected and refuses device tools before any effect, naming the runtime", async () => {
    await setFakeSandboxPermissionSupport(sandboxRoot, {
      version: 2,
      restricted: null,
      boundary: "operation",
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: true,
      background: true,
      unavailableReason: "No restricted runtime on this test provider",
    });
    try {
      const deviceId = await cloudDevice();
      const conv = await conversation(deviceId);
      const execsBefore = (await readFakeSandboxOps(sandboxRoot)).filter(
        (o) => o[0] === "exec",
      ).length;
      // the default Approve for me: refused with the kernel's runtime text, nothing ran
      const refused = await call(
        conv,
        "Bash",
        { command: "echo must-not-run", description: "Try" },
        1,
      );
      expect(refused.payload.isError).toBe(true);
      expect(refused.payload.content).toBe(RUNTIME_TEXT);
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
      // the view names the verdict admission refuses with: unsupported, the runtime's cause
      expect(view.availability).toMatchObject({
        state: "unsupported",
        cause: { kind: "runtime" },
      });
      // a background start is refused by admission the same way, with the same cause
      const background = await call(
        conv,
        "Bash",
        { command: "echo must-not-run-bg", description: "Try", run_in_background: true },
        2,
      );
      expect(background.payload.isError).toBe(true);
      expect(background.payload.content).toBe(
        `The background task was not started. Calling Bash without run_in_background is refused the same way, so do not retry it that way. ${RUNTIME_TEXT}`,
      );
      // the same refusal for Request approval
      await setProfile(conv, "request-approval");
      const again = await call(conv, "Read", { file_path: "/workspace/x.txt" }, 3);
      expect(again.payload.content).toBe(RUNTIME_TEXT);
      // Auto stays selectable and keeps the sandbox: on a runtime that only runs outside it, a
      // call under Auto runs nothing either
      await setProfile(conv, "full-access");
      expect((await permissions(conv)).profile).toBe("full-access");
      const full = await call(conv, "Bash", { command: "echo full-ok", description: "Run" }, 4);
      expect(full.payload.isError).toBe(true);
      expect(full.payload.content).toBe(RUNTIME_TEXT);
      // admission refused every call: no operation intent was ever dispatched
      expect(await intentsOf(conv)).toEqual([]);
      // the recorded context keeps only the state and the reason, never the people's cause (R9)
      const contexts = await db
        .selectFrom("conversation_events")
        .select("payload")
        .where("conversation_id", "=", conv)
        .where("type", "=", "permission_context")
        .execute();
      const recorded = contexts.map(
        ({ payload }) => (payload as { availability: Record<string, unknown> }).availability,
      );
      expect(recorded.some((a) => a.state === "unsupported")).toBe(true);
      for (const availability of recorded.filter((a) => a.state === "unsupported")) {
        expect(Object.keys(availability).sort()).toEqual(["reason", "state"]);
        expect(availability).not.toHaveProperty("cause");
      }
    } finally {
      await setFakeSandboxPermissionSupport(sandboxRoot, null);
    }
  });
});

describe("a per-call sandbox escalation on an instance-boundary device", () => {
  // an instance-boundary provider has no outside of its sandbox (approval-only profiles design,
  // decision 1; its support says so): an escalation is refused before any effect, under every
  // profile; the cross-replica escalation flows run on an operation-boundary device (the
  // approval-only profiles dual matrix)
  it.each(["request-approval", "full-access"] as const)(
    "under %s it is refused before any effect and asks no one",
    async (profile) => {
      await setFakeSandboxPermissionSupport(sandboxRoot, FAKE_INSTANCE_PERMISSION_SUPPORT);
      onTestFinished(() => setFakeSandboxPermissionSupport(sandboxRoot, null));
      const deviceId = await cloudDevice();
      const conv = await conversation(deviceId);
      const bound = await call(conv, "Bash", { command: "echo bound", description: "Bind" }, 1);
      expect(bound.payload.isError, bound.payload.content).toBe(false);
      await setProfile(conv, profile);
      const refused = await call(
        conv,
        "Bash",
        {
          command: "echo escalated",
          description: "Escalate",
          sandbox: "escalated",
          justification: "The build writes the system cache outside the project.",
        },
        2,
      );
      expect(refused.payload.isError).toBe(true);
      expect(await approvalsOf(conv)).toEqual([]);
      expect((await intentsOf(conv)).filter((i) => i.scope.filesystem.kind === "device")).toEqual(
        [],
      );
      expect(
        (await readFakeSandboxOps(sandboxRoot)).filter(
          (o) => o[0] === "exec" && o.join(" ").includes("echo escalated"),
        ),
      ).toEqual([]);
    },
  );
});
