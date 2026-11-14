import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { createLogger } from "../../src/log.js";
import {
  AGENTS_MD_TRUNCATED_MARKER,
  projectRootIdemKey,
} from "../../src/runtime/project/knowledge.js";
import { ProjectKnowledgeService } from "../../src/runtime/project/knowledge.service.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { setFakeSandboxFault } from "../fixtures/plugins/sandbox-fake/index.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
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
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Project root spec §4.4, §4.7: a run of a conversation bound to a project reads the project's
 * `AGENTS.md` and `.agents/skills/*\/SKILL.md` before its first model call and records one
 * `project_root` event, again only when something changed; a free conversation reads nothing and
 * starts its device lazily; a failure never fails the run. A cloud device on the fake sandbox,
 * with `list` switched on, holds the project's files.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

type Line = { level: string; msg: string };
type ProjectRootEvent = Extract<ConversationEvent, { type: "project_root" }>;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
const lines: Line[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-project-knowledge-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root, list: true } },
      },
    ),
    { logger: createLogger("warn", { write: (l) => lines.push(JSON.parse(l) as Line) }) },
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await newAgent(owner);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

async function newAgent(req: Req): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Be brief.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

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

/** A new conversation of the owner bound to `/workspace/<dir>` as the project `app`. */
async function boundConversation(dir: string): Promise<{ convId: string; deviceId: string }> {
  const convId = await createConv(owner, orgId, agentId);
  await db
    .updateTable("conversations")
    .set({ project_name: "app", project_path: `/workspace/${dir}` })
    .where("id", "=", convId)
    .execute();
  return { convId, deviceId: await deviceOf(convId) };
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

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nThe body of ${name}.\n`;

/** Sends a message and waits for the conversation's `n`-th terminal event. */
async function run(convId: string, n: number, req: Req = owner): Promise<ConversationEvent[]> {
  await postMessage(req, orgId, convId, `hello ${n}`);
  await waitForTerminal(db, convId, n, 30_000);
  return eventsOf(db, convId);
}

const projectRoots = (events: ConversationEvent[]) =>
  events.filter((e): e is ProjectRootEvent => e.type === "project_root");

describe("project knowledge at run start", () => {
  it("records AGENTS.md and the skills before the run's first model call, never the bodies", async () => {
    const dir = `p-${randomUUID().slice(0, 8)}`;
    const { convId, deviceId } = await boundConversation(dir);
    await put(deviceId, {
      [`${dir}/AGENTS.md`]: "# Rules\nUse pnpm.\n",
      [`${dir}/.agents/skills/fix-issue/SKILL.md`]: skill("fix-issue", "Fix one issue."),
      [`${dir}/.agents/skills/review/SKILL.md`]: skill("review", "Review a PR."),
    });
    const events = await run(convId, 1);
    expect(events.find((e) => e.type === "run_finished")).toBeDefined();
    const roots = projectRoots(events);
    expect(roots).toHaveLength(1);
    const event = roots[0] as ProjectRootEvent;
    expect(event.payload).toMatchObject({
      project: "app",
      root: `/workspace/${dir}`,
      agentsMd: "# Rules\nUse pnpm.\n",
      skills: [
        { name: "fix-issue", description: "Fix one issue." },
        { name: "review", description: "Review a PR." },
      ],
    });
    expect(event.payload.unavailable).toBeUndefined();
    expect(JSON.stringify(event.payload)).not.toContain("The body of");
    const firstCall = events.find((e) => e.type === "model_call");
    expect(firstCall).toBeDefined();
    expect(event.seq).toBeLessThan((firstCall as ConversationEvent).seq);
    expect(event.runId).toBe(firstCall?.runId);
  });

  it("appends nothing on a later run while nothing changed, and a new snapshot once a digest does", async () => {
    const dir = `p-${randomUUID().slice(0, 8)}`;
    const { convId, deviceId } = await boundConversation(dir);
    await put(deviceId, {
      [`${dir}/AGENTS.md`]: "v1",
      [`${dir}/.agents/skills/good/SKILL.md`]: skill("good", "Fine."),
    });
    await run(convId, 1);
    expect(projectRoots(await run(convId, 2))).toHaveLength(1);
    // a skill's file changes, its description does not: the digest tells
    await put(deviceId, {
      [`${dir}/.agents/skills/good/SKILL.md`]: `${skill("good", "Fine.")}\nMore.\n`,
    });
    const roots = projectRoots(await run(convId, 3));
    expect(roots).toHaveLength(2);
    expect(roots[1]?.payload.skills[0]?.digest).not.toBe(roots[0]?.payload.skills[0]?.digest);
    await put(deviceId, { [`${dir}/AGENTS.md`]: "x".repeat(70_000) });
    const cut = projectRoots(await run(convId, 4));
    expect(cut).toHaveLength(3);
    expect(cut[2]?.payload.agentsMdTruncated).toBe(true);
    expect(cut[2]?.payload.agentsMd?.endsWith(AGENTS_MD_TRUNCATED_MARKER)).toBe(true);
  });

  it("records a root that does not exist as unavailable (gone) and finishes the run", async () => {
    const { convId } = await boundConversation(`missing-${randomUUID().slice(0, 8)}`);
    const events = await run(convId, 1);
    expect(events.find((e) => e.type === "run_finished")).toBeDefined();
    const roots = projectRoots(events);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.payload.unavailable).toEqual({
      reason: "gone",
      message: expect.stringMatching(/no longer exists/) as string,
    });
    expect(roots[0]?.payload.skills).toEqual([]);
    expect(roots[0]?.payload.agentsMd).toBeUndefined();
  });

  it("records a root outside the workspace a cloud device reads as unavailable (outside_mode)", async () => {
    const convId = await createConv(owner, orgId, agentId);
    await db
      .updateTable("conversations")
      .set({ project_name: "etc", project_path: "/etc" })
      .where("id", "=", convId)
      .execute();
    const roots = projectRoots(await run(convId, 1));
    expect(roots).toHaveLength(1);
    expect(roots[0]?.payload.unavailable?.reason).toBe("outside_mode");
    expect(roots[0]?.payload.unavailable?.message).toMatch(/outside what the device can read/);
  });

  it("records a machine that does not announce projects as unavailable (unsupported), asking it nothing", async () => {
    const txHost = k.app.get(TransactionHost);
    const deviceId = await txHost.run(async () => {
      const { id } = await k.app.get(DevicesService).createLocal(orgId, ownerId, "Old box");
      await k.app.get(MachinesService).issue({
        orgId,
        deviceId: id,
        accountId: ownerId,
        name: "old-box",
        os: "linux",
        arch: "x64",
        programVersion: "0.1.0",
      });
      return id;
    });
    const convId = await createConv(owner, orgId, agentId);
    await db
      .updateTable("conversations")
      .set({ device_id: deviceId, project_name: "app", project_path: "/home/me/app" })
      .where("id", "=", convId)
      .execute();
    const events = await run(convId, 1);
    const roots = projectRoots(events);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.payload).toEqual({
      project: "app",
      root: "/home/me/app",
      unavailable: { reason: "unsupported", message: expect.any(String) as string },
      skills: [],
    });
    // the machine was never asked: no instance for the device
    const instance = await db
      .selectFrom("device_instances")
      .select("handle")
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    expect(instance?.handle ?? null).toBeNull();
  });

  it("reads nothing for a free conversation and leaves its device unstarted", async () => {
    const login = `m-${randomUUID().slice(0, 8)}`;
    const memberId = (await accountsFor(db).createLocal({ login, password: PW, displayName: "M" }))
      .id;
    await testMembers(db).add(orgId, memberId, "member", ownerId);
    const member = await session(k, login);
    const convId = await createConv(member, orgId, agentId);
    const deviceId = await deviceOf(convId);
    const events = await run(convId, 1, member);
    expect(events.find((e) => e.type === "run_finished")).toBeDefined();
    expect(projectRoots(events)).toEqual([]);
    const instance = await db
      .selectFrom("device_instances")
      .select("handle")
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    expect(instance?.handle ?? null).toBeNull();
  });

  it("runs as before when the device cannot be reached, recording nothing", async () => {
    const dir = `p-${randomUUID().slice(0, 8)}`;
    const { convId, deviceId } = await boundConversation(dir);
    await put(deviceId, { [`${dir}/AGENTS.md`]: "rules" });
    lines.length = 0;
    await setFakeSandboxFault(root, { code: "ECONNREFUSED" });
    try {
      const events = await run(convId, 1);
      expect(events.find((e) => e.type === "run_finished")).toBeDefined();
      expect(projectRoots(events)).toEqual([]);
    } finally {
      await setFakeSandboxFault(root, null);
    }
    expect(lines.some((l) => l.msg.includes("project knowledge"))).toBe(true);
  });

  it("a retried run start appends its snapshot once, and an ended run gets none", async () => {
    const dir = `p-${randomUUID().slice(0, 8)}`;
    const { convId, deviceId } = await boundConversation(dir);
    await put(deviceId, { [`${dir}/AGENTS.md`]: "first" });
    const events = await run(convId, 1);
    const runId = projectRoots(events)[0]?.runId as string;
    expect(runId).toBeTruthy();
    const service = k.app.get(ProjectKnowledgeService);
    const input = {
      orgId,
      conversationId: convId,
      runId,
      kind: "chat" as const,
      signal: new AbortController().signal,
    };
    // the run has ended: nothing is appended and the start must not go on
    await put(deviceId, { [`${dir}/AGENTS.md`]: "second" });
    expect(await service.record(input)).toBe(false);
    expect(projectRoots(await eventsOf(db, convId))).toHaveLength(1);
    // the same run starting again (a crash retry): the content changed, the idem key holds
    await db.updateTable("runs").set({ status: "running" }).where("id", "=", runId).execute();
    try {
      expect(await service.record(input)).toBe(true);
    } finally {
      await db.updateTable("runs").set({ status: "completed" }).where("id", "=", runId).execute();
    }
    const after = projectRoots(await eventsOf(db, convId));
    expect(after).toHaveLength(1);
    expect(after[0]?.payload.agentsMd).toBe("first");
    const idem = await db
      .selectFrom("conversation_events")
      .select("idem_key")
      .where("conversation_id", "=", convId)
      .where("type", "=", "project_root")
      .execute();
    expect(idem.map((r) => r.idem_key)).toEqual([projectRootIdemKey(runId)]);
  });
});
