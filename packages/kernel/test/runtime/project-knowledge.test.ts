import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { DeviceProjectsService } from "../../src/devices/device-projects.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { createLogger } from "../../src/log.js";
import {
  AGENTS_MD_TRUNCATED_MARKER,
  projectRootIdemKey,
} from "../../src/runtime/project/knowledge.js";
import {
  PROJECT_KNOWLEDGE_TIMEOUT,
  ProjectKnowledgeService,
} from "../../src/runtime/project/knowledge.service.js";
import { RunExecution } from "../../src/runtime/run-execution.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { skillLoadOfferedIn } from "../../src/skills/catalog.js";
import {
  SANDBOX_FILES_RESET_NOTICE,
  SANDBOX_RESTARTED_NOTICE,
} from "../../src/tools/builtins/sandbox/common.js";
import {
  removeFakeSandbox,
  setFakeSandboxDelays,
  setFakeSandboxFault,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { startClaimedRun } from "../helpers/managed-calls.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrgWithProviders,
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

type Line = { level: string; msg: string; timedOut?: boolean };

const SANDBOX_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Deliver"];
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
/** An agent with the sandbox tools on. */
let coderId: string;
/** The owner's default cloud device. */
let ownerDevice: string;
/** The run-start read's time limit (the seam); tests shorten it. */
let readTimeoutMs = 30_000;
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
    {
      logger: createLogger("warn", { write: (l) => lines.push(JSON.parse(l) as Line) }),
      overrides: [{ provide: PROJECT_KNOWLEDGE_TIMEOUT, useValue: () => readTimeoutMs }],
    },
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  agentId = await newAgent(owner);
  coderId = await newAgent(owner, SANDBOX_TOOLS);
  ownerDevice = await deviceOf(await createConv(owner, orgId, agentId));
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

async function newAgent(req: Req, tools?: string[]): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Be brief.",
        model: { provider: "model-fake", model: "fake-1" },
        ...(tools !== undefined && {
          disabledTools: onlyBuiltins(tools.map((name) => ({ kind: "builtin", name }))),
        }),
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

/**
 * A conversation inserted already bound (a binding is fixed at creation; inserting it directly
 * also makes bindings the create route refuses, such as a root outside the mode). The device keeps
 * the project under that name and path (the run start checks it is still there), replacing an
 * earlier test's path for the name.
 */
async function insertBound(opts: {
  accountId?: string;
  deviceId?: string;
  agent?: string;
  name?: string;
  path: string;
}): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("device_projects")
    .values({
      device_id: opts.deviceId ?? ownerDevice,
      name: opts.name ?? "app",
      path: opts.path,
      created_by: opts.accountId ?? ownerId,
    })
    .onConflict((c) => c.columns(["device_id", "name"]).doUpdateSet({ path: opts.path }))
    .execute();
  await db
    .insertInto("conversations")
    .values({
      id,
      org_id: orgId,
      agent_id: opts.agent ?? agentId,
      account_id: opts.accountId ?? ownerId,
      device_id: opts.deviceId ?? ownerDevice,
      project_name: opts.name ?? "app",
      project_path: opts.path,
      source: "web",
    })
    .execute();
  return id;
}

/** A new conversation of the owner bound to `/workspace/<dir>` as the project `app`. */
async function boundConversation(dir: string): Promise<{ convId: string; deviceId: string }> {
  const convId = await insertBound({ path: `/workspace/${dir}` });
  return { convId, deviceId: ownerDevice };
}

/** A new member of the org with a session and a default cloud device of their own. */
async function newMember(): Promise<{ id: string; req: Req; deviceId: string }> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: "M" })).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  const req = await session(k, login);
  const deviceId = await deviceOf(await createConv(req, orgId, agentId));
  return { id, req, deviceId };
}

/** A local device of the owner whose machine signed in (never connected), as `features` says. */
async function localDevice(machine: { features?: string[]; localPolicy?: unknown } = {}) {
  const deviceId = await k.app.get(TransactionHost).run(async () => {
    const { id } = await k.app
      .get(DevicesService)
      .createLocal(orgId, ownerId, `Box ${randomUUID().slice(0, 8)}`);
    await k.app.get(MachinesService).issue({
      orgId,
      deviceId: id,
      accountId: ownerId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return id;
  });
  if (machine.features !== undefined || machine.localPolicy !== undefined) {
    await db
      .updateTable("device_machines")
      .set({
        ...(machine.features !== undefined && { features: machine.features }),
        ...(machine.localPolicy !== undefined && {
          local_policy: JSON.stringify(machine.localPolicy),
        }),
      })
      .where("device_id", "=", deviceId)
      .execute();
  }
  return deviceId;
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
async function run(
  convId: string,
  n: number,
  req: Req = owner,
  text = `hello ${n}`,
): Promise<ConversationEvent[]> {
  await postMessage(req, orgId, convId, text);
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
    const convId = await insertBound({ name: "etc", path: "/etc" });
    const roots = projectRoots(await run(convId, 1));
    expect(roots).toHaveLength(1);
    expect(roots[0]?.payload.unavailable?.reason).toBe("outside_mode");
    expect(roots[0]?.payload.unavailable?.message).toMatch(/outside what the device can read/);
  });

  it("records a project removed from the device as removed, and usable again once re-added", async () => {
    const dir = `p-${randomUUID().slice(0, 8)}`;
    const name = `rm-${randomUUID().slice(0, 8)}`;
    const convId = await insertBound({ name, path: `/workspace/${dir}` });
    await put(ownerDevice, {
      [`${dir}/AGENTS.md`]: "rules",
      [`${dir}/.agents/skills/fix/SKILL.md`]: skill("fix", "Fix it."),
    });
    expect(projectRoots(await run(convId, 1))[0]?.payload.unavailable).toBeUndefined();
    const projects = k.app.get(DeviceProjectsService);
    await projects.remove(orgId, ownerId, ownerDevice, name);
    const removed = projectRoots(await run(convId, 2));
    expect(removed).toHaveLength(2);
    expect(removed[1]?.payload).toEqual({
      project: name,
      root: `/workspace/${dir}`,
      unavailable: { reason: "removed", message: expect.stringMatching(/removed/) as string },
      skills: [],
    });
    // everything that follows the latest usable snapshot falls back
    const facts = await k.app.get(ConversationDevices).reviewFacts(orgId, convId);
    expect(facts?.workingRoot).toBe("/workspace");
    const invoked = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: { text: "", skill: { name: "project:fix" } },
    });
    expect(invoked.statusCode, invoked.body).toBe(422);
    expect(invoked.json().error).toMatchObject({
      code: "skill.project_unavailable",
      details: [{ reason: "removed" }],
    });
    // re-added under the same name with another path: the binding (name + path) is still gone
    await db
      .insertInto("device_projects")
      .values({ device_id: ownerDevice, name, path: "/workspace", created_by: ownerId })
      .execute();
    expect(projectRoots(await run(convId, 3))).toHaveLength(2);
    // re-added with the same path: usable again
    await projects.remove(orgId, ownerId, ownerDevice, name);
    await db
      .insertInto("device_projects")
      .values({ device_id: ownerDevice, name, path: `/workspace/${dir}`, created_by: ownerId })
      .execute();
    const back = projectRoots(await run(convId, 4));
    expect(back).toHaveLength(3);
    expect(back[2]?.payload).toMatchObject({ project: name, agentsMd: "rules" });
    expect(back[2]?.payload.unavailable).toBeUndefined();
    expect((await k.app.get(ConversationDevices).reviewFacts(orgId, convId))?.workingRoot).toBe(
      `/workspace/${dir}`,
    );
  });

  it("records a root above the owner's home as outside_mode, as the working root would refuse it", async () => {
    const projects = k.app.get(DeviceProjectsService);
    let read = 0;
    // a machine in auto mode with a reported home: its scope reads anything the owner can
    const service = new ProjectKnowledgeService(
      k.app.get(KernelDb),
      k.app.get(EventLog),
      k.app.get(TransactionHost),
      k.app.get(ConversationDevices),
      {
        scopeFor: async () => ({
          source: "local" as const,
          mode: "auto" as const,
          reach: "os-user" as const,
          workspace: "/Users/u/capybara-device/d/workspace",
          home: "/Users/u",
          supported: true,
          widerThanAllowed: false,
        }),
        keeps: (...args: Parameters<DeviceProjectsService["keeps"]>) => projects.keeps(...args),
      },
      {
        // activated: the kernel read route only (its callback checks the root before any read)
        withSandbox: () => Promise.reject(new Error("no raw device use once activated")),
        withKernelRead: (async (_opts: unknown, _read: unknown, fn: (...a: unknown[]) => unknown) =>
          fn(
            {},
            {
              stat: async () => {
                read++;
                return { size: 0, isDir: true };
              },
              readFile: async () => null,
            },
            { roots: { workspace: "/Users/u/capybara-device/d/workspace" } },
            new AbortController().signal,
          )) as never,
      },
      createLogger("warn", { write: () => {} }),
    );
    for (const root of ["/Users", "/"]) {
      const convId = await insertBound({ name: `top-${randomUUID().slice(0, 8)}`, path: root });
      // a run start reads under its run's current execution claim
      const { runId, claim } = await startClaimedRun(k, raw, convId, ownerId);
      const ok = await k.app.get(RunExecution).withClaim(
        claim,
        () => true,
        () =>
          service.record({
            orgId,
            conversationId: convId,
            runId,
            kind: "chat",
            signal: new AbortController().signal,
          }),
      );
      expect(ok).toBe(true);
      const roots = projectRoots(await eventsOf(db, convId));
      expect(
        roots.map((e) => e.payload.unavailable?.reason),
        root,
      ).toEqual(["outside_mode"]);
    }
    expect(read).toBe(0);
  });

  it("records a machine that does not announce projects as unavailable (unsupported), asking it nothing", async () => {
    const deviceId = await localDevice();
    const convId = await insertBound({ deviceId, path: "/home/me/app" });
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
    // the run has ended: it has no execution claim, so nothing is read or appended
    await put(deviceId, { [`${dir}/AGENTS.md`]: "second" });
    await service.record(input);
    expect(projectRoots(await eventsOf(db, convId))).toHaveLength(1);
    // the same run starting again (a crash retry, under a new claim): the content changed, the
    // idem key holds
    await db.updateTable("runs").set({ status: "running" }).where("id", "=", runId).execute();
    try {
      const claim = await k.app.get(RunExecution).claim(convId, runId, randomUUID());
      if (!claim) throw new Error("the run could not be claimed");
      expect(
        await k.app.get(RunExecution).withClaim(
          claim,
          () => true,
          () => service.record(input),
        ),
      ).toBe(true);
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

  it("a retried sub-agent run start copies its root's snapshot once, the first content kept", async () => {
    const dir = `p-${randomUUID().slice(0, 8)}`;
    const { convId } = await boundConversation(dir);
    await put(ownerDevice, { [`${dir}/AGENTS.md`]: "A" });
    await run(convId, 1);
    const child = randomUUID();
    await db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: orgId,
        agent_id: agentId,
        account_id: ownerId,
        title: "Child",
        kind: "subagent",
        source: "subagent",
        parent_conversation_id: convId,
        subagent_type: "general-purpose",
        subagent_depth: 1,
      })
      .execute();
    const service = k.app.get(ProjectKnowledgeService);
    const input = {
      orgId,
      conversationId: child,
      rootConversationId: convId,
      runId: randomUUID(),
      kind: "subagent" as const,
      signal: new AbortController().signal,
    };
    expect(await service.record(input)).toBe(true);
    // the root records a newer snapshot, then the same child run start is retried
    await put(ownerDevice, { [`${dir}/AGENTS.md`]: "B" });
    await run(convId, 2);
    expect(projectRoots(await eventsOf(db, convId)).at(-1)?.payload.agentsMd).toBe("B");
    expect(await service.record(input)).toBe(true);
    const copies = projectRoots(await eventsOf(db, child));
    expect(copies).toHaveLength(1);
    expect(copies[0]?.payload.agentsMd).toBe("A");
    expect(copies[0]?.runId).toBe(input.runId);
  });

  it("records a machine that runs a wider mode than the organization allows as outside_mode, asking it nothing", async () => {
    const deviceId = await localDevice({
      features: ["mode", "projects"],
      localPolicy: { mode: "auto", allowedDomains: [] },
    });
    const convId = await insertBound({ deviceId, path: "/home/me/app" });
    // the organization allows only sandbox mode, the machine's own policy says auto
    const { settings } = await db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ ...(settings as object), fullAccess: "off" }) })
      .where("id", "=", orgId)
      .execute();
    let roots: ProjectRootEvent[];
    try {
      roots = projectRoots(await run(convId, 1));
    } finally {
      await db
        .updateTable("orgs")
        .set({ settings: JSON.stringify(settings) })
        .where("id", "=", orgId)
        .execute();
    }
    expect(roots).toHaveLength(1);
    expect(roots[0]?.payload).toEqual({
      project: "app",
      root: "/home/me/app",
      unavailable: {
        reason: "outside_mode",
        message: expect.stringMatching(/wider mode than the organization allows/) as string,
      },
      skills: [],
    });
    const instance = await db
      .selectFrom("device_instances")
      .select("handle")
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    expect(instance?.handle ?? null).toBeNull();
  });

  it("records a cloud device whose provider cannot list as unsupported, asking it nothing", async () => {
    const dir = `p-${randomUUID().slice(0, 8)}`;
    const { convId, deviceId } = await boundConversation(dir);
    await put(deviceId, { [`${dir}/AGENTS.md`]: "rules" });
    const projects = k.app.get(DeviceProjectsService);
    let asked = 0;
    // the same service over a provider without list / scan: its scope says so
    const service = new ProjectKnowledgeService(
      k.app.get(KernelDb),
      k.app.get(EventLog),
      k.app.get(TransactionHost),
      k.app.get(ConversationDevices),
      {
        scopeFor: async (...args: Parameters<DeviceProjectsService["scopeFor"]>) => ({
          ...(await projects.scopeFor(...args)),
          supported: false,
        }),
        keeps: (...args: Parameters<DeviceProjectsService["keeps"]>) => projects.keeps(...args),
      },
      {
        withSandbox: async () => {
          asked++;
          throw new Error("the device must not be asked");
        },
        withKernelRead: async () => {
          asked++;
          throw new Error("the device must not be asked");
        },
      },
      createLogger("warn", { write: () => {} }),
    );
    const ok = await service.record({
      orgId,
      conversationId: convId,
      runId: randomUUID(),
      kind: "chat",
      signal: new AbortController().signal,
    });
    expect(ok).toBe(true);
    expect(asked).toBe(0);
    const roots = projectRoots(await eventsOf(db, convId));
    expect(roots).toHaveLength(1);
    expect(roots[0]?.payload.unavailable?.reason).toBe("unsupported");
  });

  it("gives up a read past its time limit, records nothing and finishes the run", async () => {
    const member = await newMember();
    const convId = await insertBound({
      accountId: member.id,
      deviceId: member.deviceId,
      path: "/workspace/app",
    });
    lines.length = 0;
    // the member's device has no instance yet: the read's create waits until the limit aborts it
    await setFakeSandboxDelays(root, { create: 120_000 });
    readTimeoutMs = 200;
    try {
      const events = await run(convId, 1, member.req);
      expect(events.find((e) => e.type === "run_finished")).toBeDefined();
      expect(projectRoots(events)).toEqual([]);
    } finally {
      readTimeoutMs = 30_000;
      await setFakeSandboxDelays(root, {});
    }
    expect(lines.some((l) => l.msg.includes("project knowledge") && l.timedOut === true)).toBe(
      true,
    );
  });

  it("offers Skill from the log only for a project skill it can be called with", async () => {
    const convId = await createConv(owner, orgId, agentId);
    const offered = () => skillLoadOfferedIn(db, k.app.get(EventLog), convId);
    const overlong = { name: "x".repeat(57), description: "Too long a name.", digest: "d" };
    await k.app
      .get(EventLog)
      .append(convId, [
        { type: "project_root", payload: { project: "app", root: "/w", skills: [overlong] } },
      ]);
    expect(await offered()).toBe(false);
    await k.app.get(EventLog).append(convId, [
      {
        type: "project_root",
        payload: { project: "app", root: "/w", skills: [{ ...overlong, name: "x".repeat(56) }] },
      },
    ]);
    expect(await offered()).toBe(true);
  });

  describe("the model's device notices survive the run-start read", () => {
    const bash = (command: string) =>
      `tool:Bash:${JSON.stringify({ description: "Test step", command })}`;
    const firstToolResult = (events: ConversationEvent[], runId: string) =>
      events.find(
        (e): e is Extract<ConversationEvent, { type: "tool_result" }> =>
          e.type === "tool_result" && e.runId === runId,
      );
    const lastRunId = (events: ConversationEvent[]) =>
      events.filter((e) => e.type === "run_started").at(-1)?.runId as string;

    it("a fresh device's first tool call says it started, and a recreated one that it restarted", async () => {
      const member = await newMember();
      const convId = await insertBound({
        accountId: member.id,
        deviceId: member.deviceId,
        agent: coderId,
        path: "/workspace",
      });
      const first = await run(convId, 1, member.req, bash("echo one"));
      expect(projectRoots(first)).toHaveLength(1);
      const r1 = firstToolResult(first, lastRunId(first));
      expect(r1?.payload.content, JSON.stringify(r1?.payload)).toMatch(/^Device started/);
      // the provider loses the instance between the runs: the read of run 2 recreates it
      const row = await db
        .selectFrom("device_instances")
        .select("handle")
        .where("device_id", "=", member.deviceId)
        .executeTakeFirst();
      await removeFakeSandbox(root, (row?.handle as { id: string } | undefined)?.id as string);
      const second = await run(convId, 2, member.req, bash("echo two"));
      const r2 = firstToolResult(second, lastRunId(second));
      expect(r2?.payload.content).toContain(SANDBOX_RESTARTED_NOTICE);
    });

    it("a files reset between runs is still told at the next run's first tool call", async () => {
      const member = await newMember();
      const convId = await insertBound({
        accountId: member.id,
        deviceId: member.deviceId,
        agent: coderId,
        path: "/workspace",
      });
      await run(convId, 1, member.req, bash("echo one > /workspace/r.txt"));
      await k.app.get(SandboxService).resetFileSystem(member.deviceId);
      const second = await run(convId, 2, member.req, bash("ls -A /workspace; echo done"));
      const r2 = firstToolResult(second, lastRunId(second));
      expect(r2?.payload.content.startsWith(SANDBOX_FILES_RESET_NOTICE), r2?.payload.content).toBe(
        true,
      );
    });
  });
});
