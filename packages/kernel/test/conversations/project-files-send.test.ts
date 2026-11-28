import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { projectFileText } from "../../src/conversations/conversations.service.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DeviceProjectFilesService } from "../../src/devices/device-project-files.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { deviceLeaseKey } from "../../src/dial-in/keys.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { deviceNotRunning, SandboxService } from "../../src/sandbox/sandbox.service.js";
import { SkillInvoker } from "../../src/skills/invoke.js";
import { ConnectorContent } from "../../src/tools/connector-content.js";
import { legacyDbFor } from "../helpers/conversations.js";
import {
  type Answer,
  EnvelopeMachine as FakeMachine,
  type KernelReq,
} from "../helpers/dial-in-machine.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import {
  createAgent,
  createOrgWithProviders,
  eventsOf,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Referencing project files on send (composer menus §5): `projectFiles` on a message of a
 * conversation bound to a device project is checked with `stat` through the owner browse (outside
 * the message's transaction) and logged as one English text block per path, after the `@`
 * resources' bodies, with `payload.projectFiles`. A dial-in device on `fake-dial-in` answers each
 * relayed `stat` from {@link FILES}.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);

const HOME = "/home/u";
const ROOT = `${HOME}/p`;

/** The machine's files (absolute paths); {@link DIRS} are its directories. */
const FILES = new Set([`${ROOT}/src/a.ts`, `${ROOT}/README.md`]);
const DIRS = new Set([ROOT, `${ROOT}/src`]);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let sandboxRoot: string;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let machines: DialInMachines;
let devices: DevicesService;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;
let agentId: string;
let url: string;
const open: FakeMachine[] = [];

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-project-files-send-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "device-fake": { root: sandboxRoot } },
        devices: { dialIn: { reconnectGraceSeconds: 2, leaseTtlMs: 6000 } },
      },
    ),
    { bootstrap: { dir: bootstrap.dir }, bootstrapManifest: bootstrap.manifest },
  );
  await waitFor(async () => k.app.get(DeviceProviders).forDevice("fake-dial-in") ?? null);
  machines = k.app.get(DialInMachines);
  devices = k.app.get(DevicesService);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  agentId = await createAgent(owner, orgId);
  url = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterEach(() => {
  for (const m of open.splice(0)) m.close();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await bootstrap?.cleanup();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

const errOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string; details?: unknown[] } }).error;

/** A new member with a session and a dial-in device holding the project `app` at {@link ROOT}. */
async function owned() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Name ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const d = await txHost.run(async () => {
    const { id: deviceId } = await devices.createDialIn(orgId, accountId, "fake-dial-in", "Box");
    const issued = await machines.issue({
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
  await db
    .insertInto("device_projects")
    .values({ device_id: d.deviceId, name: "app", path: ROOT, created_by: accountId })
    .execute();
  return { accountId, req: await session(k, login), ...d };
}

function answering(req: KernelReq): Answer {
  const p = (req.args as { path?: string }).path as string;
  switch (req.op) {
    case "resume":
      return "resumed";
    case "browseStat":
      if (FILES.has(p)) return { size: 7, isDir: false };
      if (DIRS.has(p)) return { size: 0, isDir: true };
      return null;
    default:
      return null;
  }
}

/** Connects the machine (its hello reports `home`) and waits until its lease and report are stored. */
async function connect(d: { deviceId: string; credential: string }) {
  const machine = new FakeMachine(url, d.credential, answering, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.hello({ home: HOME });
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(d.deviceId))) !== null,
    10_000,
    "lease held",
  );
  await waitFor(
    async () =>
      (
        (
          await db
            .selectFrom("devices")
            .select("report")
            .where("id", "=", d.deviceId)
            .executeTakeFirst()
        )?.report as { home?: string } | null
      )?.home === HOME,
    10_000,
    "device report stored",
  );
  return machine;
}

const statPaths = (m: FakeMachine) =>
  m.frames
    .filter((f): f is KernelReq => f.type === "req" && f.op === "browseStat")
    .map((r) => (r.args as { path: string }).path);

type Owned = Awaited<ReturnType<typeof owned>>;

/** A conversation of `d` on its device, bound to the project `app` unless `project` is null. */
async function conversation(d: Owned, project: string | null = "app"): Promise<string> {
  const res = await d.req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations`,
    payload: { agentId, deviceId: d.deviceId, ...(project !== null && { project }) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { conversation: { id: string } }).conversation.id;
}

const send = (d: Owned, conv: string, payload: Record<string, unknown>) =>
  d.req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
    payload,
  });

type UserMessage = Extract<ConversationEvent, { type: "user_message" }>;
const userMessages = async (conv: string) =>
  (await eventsOf(db, conv)).filter((e): e is UserMessage => e.type === "user_message");

describe("projectFiles on send", () => {
  it("logs one English block per path after the text, normalized, with payload.projectFiles", async () => {
    const d = await owned();
    const machine = await connect(d);
    const conv = await conversation(d);
    const res = await send(d, conv, {
      text: "look at these",
      projectFiles: [{ path: "./src/a.ts" }, { path: "README.md" }],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(m?.payload.content).toEqual([
      { type: "text", text: "look at these" },
      {
        type: "text",
        text: "Referenced project file: src/a.ts (in the project root /home/u/p; read it with Read when needed).",
      },
      { type: "text", text: projectFileText("README.md", ROOT) },
    ]);
    expect(m?.payload.projectFiles).toEqual([{ path: "src/a.ts" }, { path: "README.md" }]);
    expect(statPaths(machine)).toEqual([`${ROOT}/src/a.ts`, `${ROOT}/README.md`]);
  });

  it("puts the project file blocks after the @ resources' bodies", async () => {
    const d = await owned();
    await connect(d);
    const conv = await conversation(d);
    const connectorId = randomUUID();
    vi.spyOn(k.app.get(ConnectorContent), "resolveAttachments").mockResolvedValue({
      blocks: [{ type: "text", text: "RESOURCE BODY" }],
      attachments: [{ appId: connectorId, appName: "Docs", uri: "doc://1", name: "One" }],
    });
    const res = await send(d, conv, {
      text: "both",
      attachments: [{ connectorId, uri: "doc://1" }],
      projectFiles: [{ path: "src/a.ts" }],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(m?.payload.content).toEqual([
      { type: "text", text: "both" },
      { type: "text", text: "RESOURCE BODY" },
      { type: "text", text: projectFileText("src/a.ts", ROOT) },
    ]);
    expect(m?.payload.attachments).toHaveLength(1);
    expect(m?.payload.projectFiles).toEqual([{ path: "src/a.ts" }]);
  });

  it("a missing path or a directory refuses the send with its path, nothing written", async () => {
    const d = await owned();
    await connect(d);
    const conv = await conversation(d);
    const res = await send(d, conv, {
      text: "hi",
      projectFiles: [{ path: "src/a.ts" }, { path: "gone.ts" }, { path: "src" }],
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(errOf(res)).toMatchObject({
      code: "conversation.project_file_unavailable",
      details: [{ path: "gone.ts" }, { path: "src" }],
    });
    expect(res.body).not.toContain(ROOT);
    expect(await userMessages(conv)).toEqual([]);
  });

  it("a path leaving the project is refused before the device is asked", async () => {
    const d = await owned();
    const machine = await connect(d);
    const conv = await conversation(d);
    for (const path of ["../x", "a/../../x", "/etc/passwd", "a\\b"]) {
      const res = await send(d, conv, { text: "hi", projectFiles: [{ path }] });
      expect(res.statusCode, `${path}: ${res.body}`).toBe(422);
      expect(errOf(res)?.code).toBe("device.path_outside_project");
    }
    expect(statPaths(machine)).toEqual([]);
    expect(await userMessages(conv)).toEqual([]);
  });

  it("a path naming the project root is refused, never with an empty path", async () => {
    const d = await owned();
    const machine = await connect(d);
    const conv = await conversation(d);
    for (const path of [".", "./", "a/.."]) {
      const res = await send(d, conv, { text: "hi", projectFiles: [{ path }] });
      expect(res.statusCode, `${path}: ${res.body}`).toBe(422);
      expect(errOf(res)).toMatchObject({
        code: "device.path_outside_project",
        message: "The project root is not a file; give the path of a file inside the project",
        details: [{ path }],
      });
    }
    expect(statPaths(machine)).toEqual([]);
    expect(await userMessages(conv)).toEqual([]);
  });

  it("a duplicate path (after normalization) is referenced once: the payload may be shorter than the body", async () => {
    const d = await owned();
    const machine = await connect(d);
    const conv = await conversation(d);
    const stat = vi.spyOn(k.app.get(DeviceProjectFilesService), "statAll");
    const res = await send(d, conv, {
      text: "twice",
      projectFiles: [{ path: "src/a.ts" }, { path: "./src//a.ts" }, { path: "README.md" }],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(m?.payload.projectFiles).toEqual([{ path: "src/a.ts" }, { path: "README.md" }]);
    expect(m?.payload.content).toEqual([
      { type: "text", text: "twice" },
      { type: "text", text: projectFileText("src/a.ts", ROOT) },
      { type: "text", text: projectFileText("README.md", ROOT) },
    ]);
    expect(statPaths(machine)).toEqual([`${ROOT}/src/a.ts`, `${ROOT}/README.md`]);
    // checked once each, with the request's signal (stops when the client hangs up)
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat.mock.calls[0]?.[2]).toEqual(["src/a.ts", "README.md"]);
    expect(stat.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
  });

  it("a retry with the same clientMessageId returns the written message without asking the device again", async () => {
    const d = await owned();
    const machine = await connect(d);
    const conv = await conversation(d);
    const body = {
      text: "once",
      clientMessageId: randomUUID(),
      projectFiles: [{ path: "README.md" }],
    };
    const first = await send(d, conv, body);
    expect(first.statusCode, first.body).toBe(202);
    const again = await send(d, conv, body);
    expect(again.statusCode, again.body).toBe(202);
    const idOf = (r: { json(): unknown }) => (r.json() as { event: { id: string } }).event.id;
    expect(idOf(again)).toBe(idOf(first));
    expect(statPaths(machine)).toEqual([`${ROOT}/README.md`]);
    expect(await userMessages(conv)).toHaveLength(1);
  });

  it("a skill invocation with empty text: the rendered skill is content[0], the file block follows", async () => {
    const d = await owned();
    await connect(d);
    const conv = await conversation(d);
    vi.spyOn(k.app.get(SkillInvoker), "prepare").mockResolvedValue({
      text: "RENDERED SKILL",
      skill: {
        id: randomUUID(),
        version: 1,
        source: "org",
        name: "review",
        arguments: "",
        mode: "inline",
      },
    });
    const res = await send(d, conv, {
      text: "",
      skill: { name: "review" },
      projectFiles: [{ path: "src/a.ts" }],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    const files = m?.payload.projectFiles ?? [];
    expect(files).toEqual([{ path: "src/a.ts" }]);
    expect(m?.payload.content[0]).toEqual({ type: "text", text: "RENDERED SKILL" });
    // project file i's block is content[1 + attachments.length + i]
    const at = 1 + (m?.payload.attachments?.length ?? 0);
    expect(m?.payload.content[at]).toEqual({
      type: "text",
      text: projectFileText("src/a.ts", ROOT),
    });
    expect(m?.payload.content).toHaveLength(2);
  });

  it("a conversation without a project refuses with reason no_project", async () => {
    const d = await owned();
    await connect(d);
    const conv = await conversation(d, null);
    const res = await send(d, conv, { text: "hi", projectFiles: [{ path: "src/a.ts" }] });
    expect(res.statusCode, res.body).toBe(422);
    expect(errOf(res)).toMatchObject({
      code: "conversation.project_file_unavailable",
      details: [{ reason: "no_project" }],
    });
    expect(await userMessages(conv)).toEqual([]);
  });

  it("the body is validated: text required, at most 10, strict entries", async () => {
    const d = await owned();
    await connect(d);
    const conv = await conversation(d);
    const cases: Record<string, unknown>[] = [
      { text: "", projectFiles: [{ path: "src/a.ts" }] },
      // files alone may go without text, not with project files
      { text: "", files: [randomUUID()], projectFiles: [{ path: "src/a.ts" }] },
      { text: "hi", projectFiles: Array.from({ length: 11 }, (_, i) => ({ path: `f${i}` })) },
      { text: "hi", projectFiles: [{ path: "" }] },
      { text: "hi", projectFiles: [{ path: "src/a.ts", extra: 1 }] },
    ];
    for (const payload of cases) {
      const res = await send(d, conv, payload);
      expect(res.statusCode, res.body).toBe(400);
    }
    expect(await userMessages(conv)).toEqual([]);
  });

  it("a start that fails (device.not_running) or an offline machine (device.offline) refuses with the device code, nothing written", async () => {
    const d = await owned();
    const machine = await connect(d);
    const conv = await conversation(d);
    const sandbox = k.app.get(SandboxService);
    const start = vi
      .spyOn(sandbox, "ensureRunningForOwner")
      .mockRejectedValueOnce(deviceNotRunning());
    const stopped = await send(d, conv, { text: "hi", projectFiles: [{ path: "src/a.ts" }] });
    expect(stopped.statusCode, stopped.body).toBe(409);
    expect(errOf(stopped)?.code).toBe("device.not_running");
    start.mockRestore();
    machine.close();
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(d.deviceId))) === null,
      15_000,
      "lease released",
    );
    const offline = await send(d, conv, { text: "hi", projectFiles: [{ path: "src/a.ts" }] });
    expect(offline.statusCode, offline.body).toBe(503);
    expect(errOf(offline)?.code).toBe("device.offline");
    expect(await userMessages(conv)).toEqual([]);
  });

  it("a suspended device is resumed for the send, which then goes through", async () => {
    const d = await owned();
    const machine = await connect(d);
    const conv = await conversation(d);
    const sandbox = k.app.get(SandboxService);
    const who = { orgId, deviceId: d.deviceId, accountId: d.accountId };
    await sandbox.ensureRunningForOwner(who, new AbortController().signal);
    const status = async () =>
      (
        await db
          .selectFrom("device_instances")
          .select("status")
          .where("device_id", "=", d.deviceId)
          .executeTakeFirst()
      )?.status;
    // the idle sweep as it runs a day later
    await sandbox.suspendIdle(new Date(Date.now() + 24 * 60 * 60_000));
    expect(await status()).toBe("suspended");
    const resumes = () => machine.frames.filter((f) => f.type === "req" && f.op === "resume");
    const before = resumes().length;
    const res = await send(d, conv, { text: "hi", projectFiles: [{ path: "src/a.ts" }] });
    expect(res.statusCode, res.body).toBe(202);
    expect(resumes().length).toBe(before + 1);
    expect(await status()).toBe("running");
    const [m] = await userMessages(conv);
    expect(m?.payload.projectFiles).toEqual([{ path: "src/a.ts" }]);
  });

  it("a project re-pointed while a new conversation's files are checked: 409 conflict, nothing created", async () => {
    const d = await owned();
    await connect(d);
    const files = k.app.get(DeviceProjectFilesService);
    const real = files.statAll.bind(files);
    // the project's path changes between the check and the write (no sleep: inside the check)
    vi.spyOn(files, "statAll").mockImplementationOnce(async (...args) => {
      await db
        .updateTable("device_projects")
        .set({ path: `${HOME}/q` })
        .where("device_id", "=", d.deviceId)
        .where("name", "=", "app")
        .execute();
      return real(...args);
    });
    const clientMessageId = randomUUID();
    const res = await d.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: {
        agentId,
        deviceId: d.deviceId,
        project: "app",
        message: { text: "start", clientMessageId, projectFiles: [{ path: "README.md" }] },
      },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(errOf(res)).toMatchObject({
      code: "conflict",
      message: "The project changed while the message was sent; retry",
    });
    const none = await db
      .selectFrom("conversations")
      .select("id")
      .where("create_request_id", "=", clientMessageId)
      .execute();
    expect(none).toEqual([]);
  });

  it("a project removed from the device after binding still resolves through the stored path", async () => {
    const d = await owned();
    const machine = await connect(d);
    const conv = await conversation(d);
    await db
      .deleteFrom("device_projects")
      .where("device_id", "=", d.deviceId)
      .where("name", "=", "app")
      .execute();
    const res = await send(d, conv, { text: "hi", projectFiles: [{ path: "src/a.ts" }] });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(m?.payload.content.at(-1)).toEqual({
      type: "text",
      text: projectFileText("src/a.ts", ROOT),
    });
    expect(statPaths(machine)).toEqual([`${ROOT}/src/a.ts`]);
  });

  it("create with a first message: with project the files are referenced, without it refused", async () => {
    const d = await owned();
    await connect(d);
    const created = await d.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: {
        agentId,
        deviceId: d.deviceId,
        project: "app",
        message: {
          text: "start here",
          clientMessageId: randomUUID(),
          projectFiles: [{ path: "README.md" }],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as {
      conversation: { id: string; project: { path: string } };
      event: UserMessage;
    };
    expect(body.conversation.project.path).toBe(ROOT);
    expect(body.event.payload.content).toEqual([
      { type: "text", text: "start here" },
      { type: "text", text: projectFileText("README.md", ROOT) },
    ]);
    expect(body.event.payload.projectFiles).toEqual([{ path: "README.md" }]);

    const clientMessageId = randomUUID();
    const refused = await d.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: {
        agentId,
        deviceId: d.deviceId,
        message: { text: "start", clientMessageId, projectFiles: [{ path: "README.md" }] },
      },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errOf(refused)).toMatchObject({
      code: "conversation.project_file_unavailable",
      details: [{ reason: "no_project" }],
    });
    const none = await db
      .selectFrom("conversations")
      .select("id")
      .where("create_request_id", "=", clientMessageId)
      .execute();
    expect(none).toEqual([]);
  });

  it("first-message (the new-conversation home): the files are referenced, a missing path refused", async () => {
    const d = await owned();
    const machine = await connect(d);
    const first = (message: Record<string, unknown>) =>
      d.req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/first-message`,
        payload: {
          agentId,
          deviceId: d.deviceId,
          project: "app",
          message,
          permission: { profile: "request-approval" },
        },
      });
    const created = await first({
      text: "start here",
      clientMessageId: randomUUID(),
      projectFiles: [{ path: "./src/a.ts" }, { path: "README.md" }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const conv = (created.json() as { conversation: { id: string } }).conversation.id;
    const [m] = await userMessages(conv);
    expect(m?.payload.content).toEqual([
      { type: "text", text: "start here" },
      { type: "text", text: projectFileText("src/a.ts", ROOT) },
      { type: "text", text: projectFileText("README.md", ROOT) },
    ]);
    expect(m?.payload.projectFiles).toEqual([{ path: "src/a.ts" }, { path: "README.md" }]);
    expect(statPaths(machine)).toEqual([`${ROOT}/src/a.ts`, `${ROOT}/README.md`]);

    const clientMessageId = randomUUID();
    const refused = await first({
      text: "start",
      clientMessageId,
      projectFiles: [{ path: "gone.ts" }],
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errOf(refused)).toMatchObject({
      code: "conversation.project_file_unavailable",
      details: [{ path: "gone.ts" }],
    });
    const none = await db
      .selectFrom("conversations")
      .select("id")
      .where("create_request_id", "=", clientMessageId)
      .execute();
    expect(none).toEqual([]);
  });
});
