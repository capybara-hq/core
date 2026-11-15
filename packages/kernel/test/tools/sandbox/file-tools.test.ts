import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { ConversationDevices } from "../../../src/devices/conversation-devices.js";
import { SandboxService } from "../../../src/sandbox/sandbox.service.js";
import { checkToolPath, checkToolWritable } from "../../../src/tools/builtins/sandbox/common.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
import { accountsFor } from "../../helpers/identity.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
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
} from "../../helpers/runs.js";

/**
 * Auto mode spec §4.1 (decision 1): in auto mode `Read` / `Write` / `Edit` / `Glob` / `Grep`
 * accept any absolute path (shape checks only); sandbox mode keeps the device roots; the skills
 * directory stays read-only; and a write outside the workspace passes the command review first,
 * after which the existing read-before-write guard still applies.
 *
 * Project root spec §4.3: a bound conversation works in its project's root. `Bash` runs there, a
 * relative `Read` resolves there, and the command review takes it as its `workspace` fact: a write
 * outside the project root asks even inside the device's workspace. The review's facts take the
 * root conversation's latest usable `project_root`, else the device's workspace. The fake's `list`
 * is on, so a run start of a bound conversation reads its project from the device.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-file-tools-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root, list: true } },
      },
    ),
  );
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  ownerId = (
    await accountsFor(db).createLocal({
      login: "owner",
      password: PW,
      displayName: "O",
    })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the device.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins(
          ["Bash", "Read", "Write", "Edit", "Glob", "Grep"].map((name) => ({
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
  expect(ownerId).toBeTruthy();
});

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>;

const results = async (conv: string): Promise<ToolResult[]> =>
  (await eventsOf(db, conv)).filter((e): e is ToolResult => e.type === "tool_result");

/** Runs the call; a command ask it raises is approved once (the test's writes outside the workspace). */
async function callAllowed(
  conv: string,
  key: string,
  input: unknown,
  n: number,
): Promise<ToolResult> {
  await postMessage(owner, orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
  const ask = await waitFor(
    async () =>
      db
        .selectFrom("approvals")
        .select("id")
        .where("conversation_id", "=", conv)
        .where("kind", "=", "command")
        .where("status", "=", "pending")
        .executeTakeFirst(),
    20_000,
    "the command ask",
  );
  const decided = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${ask.id}/decision`,
    payload: { decision: "approve", scope: "once" },
  });
  expect(decided.statusCode, decided.body).toBe(200);
  await waitForTerminal(db, conv, n, 30_000);
  return (await results(conv)).at(-1) as ToolResult;
}

/** Runs a call that is not expected to ask (reads inside/outside the roots, sandbox-mode refusals). */
async function call(conv: string, key: string, input: unknown, n: number): Promise<ToolResult> {
  await postMessage(owner, orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 30_000);
  return (await results(conv)).at(-1) as ToolResult;
}

describe("file tool paths in the device's mode", () => {
  it("auto mode: a write outside the workspace is approved once, then read anywhere", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const written = await callAllowed(
      conv,
      "Write",
      { file_path: "/etc/capybara-t7/note.txt", content: "hello\n" },
      1,
    );
    expect(written.payload.isError).toBe(false);
    expect(written.payload.content).toContain("Created /etc/capybara-t7/note.txt");
    // a Read outside the workspace needs no review and reaches the machine's file
    const read = await call(conv, "Read", { file_path: "/etc/capybara-t7/note.txt" }, 2);
    expect(read.payload.isError).toBe(false);
    expect(read.payload.content).toContain("hello");
    expect(read.payload.view).toMatchObject({ kind: "read", path: "/etc/capybara-t7/note.txt" });
  });

  it("auto mode: an Edit of a file outside the workspace that was never read hits the guard after the review", async () => {
    const conv = await createConv(owner, orgId, agentId);
    // the file lives on the device's machine (another conversation wrote it)
    const edit = await callAllowed(
      conv,
      "Edit",
      { file_path: "/etc/capybara-t7/note.txt", old_string: "hello", new_string: "bye" },
      1,
    );
    expect(edit.payload.isError).toBe(true);
    expect(edit.payload.content).toContain("File has not been read yet");
    expect(edit.payload.view).toMatchObject({ kind: "guard", reason: "not_read" });
    // the review record is still the person's allow: the guard refused after it
    expect(edit.payload.review).toMatchObject({ decision: "allow", by: "person" });
    // reading it first makes the edit succeed (the write outside the workspace asks again)
    await call(conv, "Read", { file_path: "/etc/capybara-t7/note.txt" }, 2);
    const ok = await callAllowed(
      conv,
      "Edit",
      { file_path: "/etc/capybara-t7/note.txt", old_string: "hello", new_string: "bye" },
      3,
    );
    expect(ok.payload.isError).toBe(false);
    expect(ok.payload.content).toContain("Edited /etc/capybara-t7/note.txt");
  });

  it("auto mode: the skills directory stays read-only", async () => {
    const conv = await createConv(owner, orgId, agentId);
    // the write is outside the workspace, so the review asks first; then the tool refuses it
    const r = await callAllowed(conv, "Write", { file_path: "/skills/x.md", content: "x" }, 1);
    expect(r.payload.isError).toBe(true);
    expect(r.payload.content).toContain("read-only");
    expect(r.payload.content).toContain("/skills");
  });

  it("sandbox mode keeps the device roots", async () => {
    const off = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { autoMode: "off" },
    });
    expect(off.statusCode, off.body).toBe(200);
    const conv = await createConv(owner, orgId, agentId);
    const read = await call(conv, "Read", { file_path: "/etc/passwd" }, 1);
    expect(read.payload.isError).toBe(true);
    expect(read.payload.content).toContain("/workspace");
    const write = await call(conv, "Write", { file_path: "/etc/x", content: "x" }, 2);
    expect(write.payload.isError).toBe(true);
    expect(write.payload.content).toContain("/workspace");
    // inside the roots it works as before
    const ok = await call(conv, "Write", { file_path: "/workspace/a.txt", content: "a" }, 3);
    expect(ok.payload.isError).toBe(false);
  });

  it("the path checks are pure over the mode", () => {
    const roots = { workspace: "/workspace", skills: "/skills", tmp: "/tmp" };
    expect(checkToolPath("/etc/hosts", { roots, mode: "auto" })).toBe("/etc/hosts");
    expect(() => checkToolPath("/etc/../etc/hosts", { roots, mode: "auto" })).toThrow(/\.\./);
    expect(() => checkToolPath("relative/x", { roots, mode: "auto" })).toThrow(/absolute/);
    expect(() => checkToolPath("/etc/hosts", { roots, mode: "sandbox" })).toThrow(
      /under \/workspace/,
    );
    expect(checkToolPath("/workspace/./a.txt", { roots, mode: "sandbox" })).toBe(
      "/workspace/./a.txt",
    );
    const workingRoot = roots.workspace;
    expect(() => checkToolWritable("/skills/x.md", { roots, mode: "auto", workingRoot })).toThrow(
      /read-only/,
    );
    expect(() =>
      checkToolWritable("/skills/x.md", { roots, mode: "sandbox", workingRoot }),
    ).toThrow(/read-only/);
  });
});

/** The device a conversation is bound to. */
async function deviceOf(convId: string): Promise<string> {
  const r = await db
    .selectFrom("conversations")
    .select("device_id")
    .where("id", "=", convId)
    .executeTakeFirstOrThrow();
  if (r.device_id === null) throw new Error(`conversation ${convId} has no device`);
  return r.device_id;
}

/** Binds a new conversation to the project `app` at `path` (the binding is set at creation). */
async function boundConversation(path: string): Promise<string> {
  const convId = await createConv(owner, orgId, agentId);
  await db
    .updateTable("conversations")
    // biome-ignore lint/suspicious/noExplicitAny: the binding columns are insert-only in the schema
    .set({ project_name: "app", project_path: path } as any)
    .where("id", "=", convId)
    .execute();
  return convId;
}

/** Writes files into the device's file system (paths relative to `/workspace`). */
async function put(deviceId: string, files: Record<string, string>): Promise<void> {
  await k.app.get(SandboxService).withSandbox(
    {
      orgId,
      deviceId,
      holderConversationId: "test-setup",
      actor: { accountId: ownerId, conversationId: "test-setup" },
    },
    async (h, p, _info, signal) => {
      for (const [path, text] of Object.entries(files)) {
        await p.writeFile(h, `/workspace/${path}`, new TextEncoder().encode(text), signal);
      }
    },
    new AbortController().signal,
  );
}

/** The org follows the platform's mode again (auto): an earlier test switched auto mode off. */
async function followPlatformMode(): Promise<void> {
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: { autoMode: null },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const appendProjectRoot = (convId: string, payload: Record<string, unknown>) =>
  k.app.get(EventLog).append(convId, [{ type: "project_root", payload } as never]);

describe("a bound conversation works in its project's root", () => {
  beforeAll(followPlatformMode);

  it("Bash runs in the project root, a relative Read resolves there, a relative Write is allowed", async () => {
    const dir = `p-${randomUUID().slice(0, 8)}`;
    const conv = await boundConversation(`/workspace/${dir}`);
    await put(await deviceOf(conv), { [`${dir}/notes.txt`]: "hello project\n" });
    const pwd = await call(conv, "Bash", { command: "pwd", description: "Where" }, 1);
    expect(pwd.payload.isError).toBe(false);
    expect(pwd.payload.content).toContain(`/workspace/${dir}`);
    const roots = (await eventsOf(db, conv)).filter((e) => e.type === "project_root");
    expect(roots.map((e) => (e.payload as { root: string }).root)).toEqual([`/workspace/${dir}`]);
    const read = await call(conv, "Read", { file_path: "notes.txt" }, 2);
    expect(read.payload.isError).toBe(false);
    expect(read.payload.content).toContain("hello project");
    const wrote = await call(conv, "Write", { file_path: "out.txt", content: "x" }, 3);
    expect(wrote.payload.isError).toBe(false);
    expect(wrote.payload.content).toContain(`Created /workspace/${dir}/out.txt`);
    expect(wrote.payload.review).toMatchObject({
      decision: "allow",
      rule: "allow.workspace-write",
    });
  });

  it("the review judges a write against the project root: outside it asks, even in the device's workspace", async () => {
    const dir = `p-${randomUUID().slice(0, 8)}`;
    const conv = await boundConversation(`/workspace/${dir}`);
    await put(await deviceOf(conv), { [`${dir}/notes.txt`]: "x\n" });
    const touch = { command: "touch /workspace/elsewhere.txt", description: "Touch" };
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(touch)}`);
    const ask = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .select(["id", "detail"])
          .where("conversation_id", "=", conv)
          .where("kind", "=", "command")
          .where("status", "=", "pending")
          .executeTakeFirst(),
      30_000,
      "the command ask",
    );
    expect(ask.detail as Record<string, unknown>).toMatchObject({ rule: "ask.outside-write" });
    const declined = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${ask.id}/decision`,
      payload: { decision: "deny" },
    });
    expect(declined.statusCode, declined.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);

    // the same command in a free conversation writes inside its workspace: allowed
    const free = await createConv(owner, orgId, agentId);
    const r = await call(free, "Bash", touch, 1);
    expect(r.payload.review).toMatchObject({ decision: "allow", rule: "allow.workspace-write" });
  });
});

describe("the review's facts name the working root", () => {
  beforeAll(followPlatformMode);

  const facts = (convId: string) => k.app.get(ConversationDevices).reviewFacts(orgId, convId);

  it("the root conversation's latest usable project root, else the device's workspace", async () => {
    // free: the device's workspace
    const free = await createConv(owner, orgId, agentId);
    await deviceOf(free);
    expect(await facts(free)).toMatchObject({
      mode: "auto",
      workspace: "/workspace",
      workingRoot: "/workspace",
    });

    // bound, before its first run start: no snapshot yet
    const conv = await boundConversation("/srv/app");
    expect((await facts(conv))?.workingRoot).toBe("/workspace");

    // a usable snapshot outside the device's workspace (auto mode): the project root
    await appendProjectRoot(conv, { project: "app", root: "/srv/app", skills: [] });
    expect(await facts(conv)).toMatchObject({ workspace: "/workspace", workingRoot: "/srv/app" });
    // a sub-agent's call reads the root conversation's
    expect(
      (await k.app.get(ConversationDevices).reviewFacts(orgId, conv, randomUUID()))?.workingRoot,
    ).toBe("/srv/app");

    // the latest one says the project is unavailable: the device's workspace again
    await appendProjectRoot(conv, {
      project: "app",
      root: "/srv/app",
      unavailable: { reason: "gone", message: "The project's root /srv/app no longer exists." },
      skills: [],
    });
    expect((await facts(conv))?.workingRoot).toBe("/workspace");

    // a project covering a home directory never widens the review
    const home = await boundConversation("/home/owner");
    await appendProjectRoot(home, { project: "app", root: "/home/owner", skills: [] });
    expect((await facts(home))?.workingRoot).toBe("/workspace");
  });
});
