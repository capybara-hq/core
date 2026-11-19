import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxExecutionRef,
  type SandboxProvider,
  SandboxScopeDeniedError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import {
  FAKE_PNG_BASE64,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskFinisher } from "../../../src/background/finish.js";
import { BackgroundTaskStopper } from "../../../src/background/stop.js";
import { BackgroundTaskStore } from "../../../src/background/store.js";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import { EventLog } from "../../../src/conversations/event-log.js";
import { kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { ConversationDevices } from "../../../src/devices/conversation-devices.js";
import { KernelConfigService } from "../../../src/infra/config/kernel-config.service.js";
import { createLogger } from "../../../src/log.js";
import { RunExecution } from "../../../src/runtime/run-execution.js";
import { StepLog } from "../../../src/runtime/step-log.js";
import {
  MANAGED_DEVICE_CONTEXT_STALE_TEXT,
  ManagedDeviceContextRecorder,
} from "../../../src/sandbox/managed-device-context.js";
import { SandboxProviders } from "../../../src/sandbox/providers.js";
import { SandboxService } from "../../../src/sandbox/sandbox.service.js";
import { generateImageTool } from "../../../src/tools/builtins/image/index.js";
import type { SandboxToolDeps } from "../../../src/tools/builtins/sandbox/common.js";
import { sandboxTools } from "../../../src/tools/builtins/sandbox/index.js";
import { type SkillLoadDeps, skillLoadTool } from "../../../src/tools/builtins/skill-load.js";
import type { BuiltinCallContext, BuiltinTool } from "../../../src/tools/registry.js";
import { createFakeSandbox } from "../../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../../helpers/runs.js";
import { seedConversation } from "../../helpers/tool-fixtures.js";
import { startRun } from "../../runtime/permission-context-fixture.js";

/**
 * B-17 / B-18 (permission activation W3-K): with the one activation gate on, every builtin that
 * enters a device (Read, Write, Edit, Glob, Grep, Deliver, foreground and background Bash,
 * FetchAttachment, Skill and GenerateImage's device copy) goes through the managed operation route: the managed writer records
 * the marked `device_paths` before the tool's first provider operation, every operation is a
 * managed one, and the legacy `withSandbox` route is never entered. A call reviewed against
 * another working root than the held evidence's fails as stale before its callback. With the gate
 * off the legacy route stays.
 */

const CLOUD = "@managed-builtins-test";
const ROOTS = DEFAULT_SANDBOX_ROOTS;

let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
let root: string;
/** Every provider entry the tools reached, with the marked paths recorded at that moment. */
const reached: { method: string; marked: number }[] = [];
/** The conversation whose marked paths `reached` counts, and its device. */
let watched = "";
let watchedDevice = "";
/** Set: the provider refuses a background start with its own words. */
let startRefuses = false;

const markedCount = async (conversationId: string): Promise<number> => {
  const rows = await kernelDb(raw)
    .selectFrom("conversation_events")
    .select("payload")
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "device_paths")
    .execute();
  return rows.filter(
    (r) => (r.payload as { permissionContextVersion?: number }).permissionContextVersion === 1,
  ).length;
};
const reach = async (method: string) => {
  reached.push({ method, marked: await markedCount(watched) });
};

beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 8 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pg.url, 5);
  root = await mkdtemp(join(tmpdir(), "managed-builtins-"));
  const base = createFakeSandbox(root);
  const facade = base;
  const impl: SandboxProvider = {
    ...facade,
    async permissionSupport() {
      return {
        version: 1,
        restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        fullAccess: true,
        background: true,
      };
    },
    // the fixture enforces no scope: what matters here is which route reached the provider
    async operation(h, scope) {
      return {
        exec: async (args) => {
          await reach("exec");
          return base.exec(h, { ...args, actor: scope.actor, tag: scope.tag });
        },
        readFile: async (path, opts) => {
          await reach("readFile");
          return base.readFile(h, path, opts);
        },
        writeFile: async (path, data, signal) => {
          await reach("writeFile");
          return base.writeFile(h, path, data, signal);
        },
        stat: async (path, signal) => {
          await reach("stat");
          return base.stat(h, path, signal);
        },
      };
    },
    async prepare(h, scope, signal) {
      await reach("prepare");
      return (facade.prepare as NonNullable<SandboxProvider["prepare"]>)(h, scope, signal);
    },
    background: {
      async start(h, scope) {
        await reach("backgroundStart");
        if (startRefuses)
          throw new SandboxScopeDeniedError("provider secret: /etc/provider/config denied");
        const row = await kernelDb(raw)
          .selectFrom("device_instances")
          .select("created_at")
          .where("device_id", "=", watchedDevice)
          .executeTakeFirstOrThrow();
        return {
          executionId: `x-${scope.operationId.slice(0, 12)}`,
          operationId: scope.operationId,
          instanceId: h.id,
          instanceGeneration: String(row.created_at.getTime()),
        } satisfies SandboxExecutionRef;
      },
      async status() {
        return { state: "running" };
      },
      async readOutput() {
        return { unavailable: "lost" };
      },
      async tail() {
        return { unavailable: "lost" };
      },
      async stop() {
        return { outcome: "stopped" };
      },
    },
  };
  k.app.get(SandboxProviders).register({ plugin: CLOUD, version: "v1", impl });
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  vi.restoreAllMocks();
  reached.length = 0;
  stored.clear();
  startRefuses = false;
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
});

/** One org, its owner and a root conversation on a cloud device its first call provisions. */
async function seed() {
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const s = await seedConversation(raw as any);
  const db = kernelDb(raw);
  await db
    .insertInto("memberships")
    .values({ org_id: s.orgId, account_id: s.accountId, role: "owner" })
    .execute();
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: s.orgId,
      owner_kind: "personal",
      owner_account_id: s.accountId,
      source: "cloud",
      provider: CLOUD,
      name: "Cloud",
    })
    .execute();
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId, permission_profile: "request-approval" })
    .where("id", "=", s.conversationId)
    .execute();
  const run = await startRun(k, raw, s.conversationId, s.accountId);
  watched = s.conversationId;
  watchedDevice = deviceId;
  return { ...s, db, deviceId, ...run };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

/**
 * Another root conversation of the same owner on the same device, with its own running run: a
 * call there records its own marked paths, so a setup call in `f` cannot have recorded them.
 * `reached` counts this conversation's marked paths from now on.
 */
async function sibling(f: Fixture): Promise<Fixture> {
  const conversationId = randomUUID();
  await sql`INSERT INTO capybara.conversations
    (id, org_id, agent_id, account_id, device_id, permission_profile)
    VALUES (${conversationId}, ${f.orgId}, ${f.agentId}, ${f.accountId}, ${f.deviceId},
      'request-approval')`.execute(raw);
  const run = await startRun(k, raw, conversationId, f.accountId);
  watched = conversationId;
  reached.length = 0;
  return { ...f, conversationId, ...run };
}

/** Records the run start's project snapshot of `root` (optionally unavailable) in `f`'s log. */
async function projectRoot(
  f: Fixture,
  root: string,
  unavailable?: { reason: "gone"; message: string },
): Promise<void> {
  await k.app.get(EventLog).append(f.conversationId, [
    {
      type: "project_root",
      idemKey: `test_project_root:${f.conversationId}`,
      payload: {
        project: "app",
        root,
        // an unavailable project carries no skills
        skills: unavailable
          ? []
          : [{ name: "demo", description: "A demo.", digest: "a".repeat(64) }],
        ...(unavailable && { unavailable }),
      },
    },
  ]);
}

/** An org skill `name` with a script, in the store stub and the conversation's catalog snapshot. */
async function catalogSkill(f: Fixture, name: string): Promise<void> {
  const prefix = `skills/${randomUUID()}/`;
  const files: Record<string, string> = {
    "SKILL.md": `---\nname: ${name}\ndescription: A plugin skill.\n---\nPlug body.\n`,
    "run.sh": "echo plug",
  };
  const manifestFiles = Object.entries(files).map(([path, text]) => {
    const data = new TextEncoder().encode(text);
    stored.set(`${prefix}${path}`, data);
    return { path, size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
  });
  const id = randomUUID();
  await f.db
    .insertInto("skills")
    .values({
      id,
      org_id: f.orgId,
      scope: "org",
      agent_id: null,
      name,
      description: "A plugin skill.",
      current_version: 1,
      created_by: f.accountId,
    })
    .execute();
  await f.db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version: 1,
      manifest: JSON.stringify({ name, description: "A plugin skill.", files: manifestFiles }),
      object_prefix: prefix,
      created_by: f.accountId,
    })
    .execute();
  await k.app.get(EventLog).append(f.conversationId, [
    {
      type: "skills_catalog",
      idemKey: `test_skills_catalog:${f.conversationId}`,
      payload: {
        skills: [{ id, name, description: "A plugin skill.", version: 1, source: prefix }],
      },
    },
  ]);
}

/** Binds the conversation to project `path` on its device (admission's working root). */
async function bindProject(f: Fixture, path: string): Promise<void> {
  await f.db
    .insertInto("device_projects")
    .values({ device_id: f.deviceId, name: "app", path, created_by: f.accountId })
    .execute();
  // fixture setup writes the otherwise immutable project binding
  await sql`UPDATE capybara.conversations SET project_name = 'app', project_path = ${path}
    WHERE id = ${f.conversationId}`.execute(raw);
}

const ATTACHMENT = "11111111-2222-4333-8444-555555555555";

/** Files of the kernel object store stub (skill versions), by key. */
const stored = new Map<string, Uint8Array>();

/** The builtin deps as `BuiltinTools` builds them; `gate` passes the managed writer, required. */
function depsOf(gate: boolean): SandboxToolDeps {
  return {
    sandbox: k.app.get(SandboxService),
    devices: k.app.get(ConversationDevices),
    background: k.app.get(BackgroundTaskStore),
    tasks: {
      finisher: k.app.get(BackgroundTaskFinisher),
      stopper: k.app.get(BackgroundTaskStopper),
    },
    attachments: {
      listForConversation: async () => [{ id: ATTACHMENT, name: "notes.txt" }] as never,
      openForConversation: async () =>
        ({
          name: "notes.txt",
          contentType: "text/plain",
          size: 2,
          body: new Response("hi").body as ReadableStream<Uint8Array>,
        }) as never,
    },
    storage: {
      available: true,
      kernel: () => ({
        put: async () => {},
        delete: async () => {},
        get: async (key: string) => {
          const data = stored.get(key);
          return data === undefined ? null : { body: new Response(data).body, size: data.length };
        },
      }),
    } as never,
    eventLog: k.app.get(EventLog),
    config: k.app.get(KernelConfigService),
    ...(gate && {
      managedDeviceContext: k.app.get(ManagedDeviceContextRecorder),
      managedDeviceContextRequired: true,
    }),
  };
}

/** The canonical started call admission needs (the pipeline writes it before a tool runs). */
async function started(f: Fixture, callId: string, toolKey: string): Promise<void> {
  const conv = await f.db
    .selectFrom("conversations")
    .select("last_seq")
    .where("id", "=", f.conversationId)
    .executeTakeFirstOrThrow();
  const seq = Number(conv.last_seq) + 1;
  await f.db
    .insertInto("conversation_events")
    .values({
      conversation_id: f.conversationId,
      run_id: f.runId,
      seq,
      type: "tool_call_started",
      payload: JSON.stringify({ callId, toolKey }),
    })
    .execute();
  await f.db
    .updateTable("conversations")
    .set({ last_seq: seq })
    .where("id", "=", f.conversationId)
    .execute();
}

/**
 * `GenerateImage` on the given sandbox deps: a stub image model answering one PNG, the real event
 * and step logs (its delivery and usage event), and the sandbox deps for its device copy.
 */
function imageToolOf(deps: SandboxToolDeps): BuiltinTool {
  const ref = { provider: "p", model: "img" };
  return generateImageTool({
    images: {
      prepare: async () => ({ ref, info: {}, request: { size: { width: 8, height: 8 } } }) as never,
      run: async () =>
        ({
          images: [{ mediaType: "image/png", data: FAKE_PNG_BASE64 }],
          usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: "img",
          latencyMs: 1,
        }) as never,
    },
    purposes: { resolve: async () => ({ model: ref, params: {} }) as never },
    providers: { resolve: async () => ({}) as never },
    storage: deps.storage as never,
    eventLog: k.app.get(EventLog),
    stepLog: k.app.get(StepLog),
    config: k.app.get(KernelConfigService),
    log: { warn: () => {} },
    db: () => kernelDb(raw),
    attachments: { openForConversation: async () => null },
    sandbox: deps,
  });
}

/** Runs one builtin call under the run's real claim fence, as the pipeline does. */
async function runTool(
  f: Fixture,
  name: string,
  input: Record<string, unknown>,
  opts: { gate?: boolean; over?: Partial<BuiltinCallContext> } = {},
): Promise<unknown> {
  const deps = depsOf(opts.gate ?? true);
  // the project skill path reads no database
  const tools: BuiltinTool[] = [
    ...sandboxTools(deps),
    skillLoadTool({ ...deps, db: kernelDb(raw) } as unknown as SkillLoadDeps),
    imageToolOf(deps),
  ];
  const tool = tools.find((t) => t.spec.name === name);
  if (!tool) throw new Error(`no builtin ${name}`);
  const callId = randomUUID();
  await started(f, callId, name);
  const ctx: BuiltinCallContext = {
    orgId: f.orgId,
    accountId: f.accountId,
    agentId: f.agentId,
    conversationId: f.conversationId,
    callId,
    runId: f.runId,
    signal: new AbortController().signal,
    executionClaim: f.claim,
    // the step's sandbox tools (Skill copies files only when the agent can run them)
    tools: [{ key: "Bash", source: { kind: "builtin", name: "Bash" } }] as never,
    ...opts.over,
  };
  return k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => tool.run(input, ctx),
  );
}

const failure = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail");
};

const textOf = (r: unknown): string =>
  (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

/** The marked paths of the conversation, in order. */
async function markedPaths(f: Fixture) {
  const rows = await f.db
    .selectFrom("conversation_events")
    .select("payload")
    .where("conversation_id", "=", f.conversationId)
    .where("type", "=", "device_paths")
    .orderBy("seq")
    .execute();
  return rows.map((r) => r.payload);
}

/**
 * Asserts the call went through the managed route only: the provider was reached, every entry
 * after the marked paths existed, and the legacy route was never entered.
 */
function expectManaged(legacy: { mock: { calls: unknown[] } }, methods: string[]): void {
  expect(legacy.mock.calls).toHaveLength(0);
  expect(reached.map((r) => r.method)).toEqual(expect.arrayContaining(methods));
  expect(reached.length).toBeGreaterThan(0);
  for (const r of reached) expect(r.marked).toBeGreaterThan(0);
}

describe("builtin tools on the managed route with the activation gate on", () => {
  it("Write records the marked paths before its first operation and writes through managed operations", async () => {
    const f = await seed();
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(f, "Write", { file_path: "/workspace/a.txt", content: "hello" });
    expect(textOf(r)).toContain("Created /workspace/a.txt");
    expectManaged(legacy, ["stat", "writeFile"]);
    expect(await markedPaths(f)).toEqual([
      {
        permissionContextVersion: 1,
        deviceId: f.deviceId,
        roots: ROOTS,
        workingRoot: ROOTS.workspace,
      },
    ]);
  });

  it("Read reads through managed operations after its own marked paths", async () => {
    const f = await seed();
    await runTool(f, "Write", { file_path: "/workspace/r.txt", content: "line one" });
    const g = await sibling(f);
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(g, "Read", { file_path: "/workspace/r.txt" });
    expect(textOf(r)).toContain("line one");
    expectManaged(legacy, ["stat", "readFile"]);
    expect(await markedPaths(g)).toHaveLength(1);
  });

  it("Edit stats and reads through managed operations after its own marked paths", async () => {
    const f = await seed();
    await runTool(f, "Write", { file_path: "/workspace/e.txt", content: "old text" });
    const g = await sibling(f);
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    // never read in this conversation: the read-before-write guard answers, after the reads
    const r = await runTool(g, "Edit", {
      file_path: "/workspace/e.txt",
      old_string: "old",
      new_string: "new",
    });
    expect(textOf(r)).toMatch(/Read/);
    expectManaged(legacy, ["stat", "readFile"]);
    expect(await markedPaths(g)).toHaveLength(1);
  });

  it("Glob searches through managed operations after its own marked paths", async () => {
    const f = await seed();
    await runTool(f, "Write", { file_path: "/workspace/g.txt", content: "x" });
    const g = await sibling(f);
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(g, "Glob", { pattern: "*.txt" });
    expect(textOf(r)).toContain("/workspace/g.txt");
    expectManaged(legacy, ["stat", "exec"]);
    expect(await markedPaths(g)).toHaveLength(1);
  });

  it("Grep searches through managed operations after its own marked paths", async () => {
    const f = await seed();
    await runTool(f, "Write", { file_path: "/workspace/h.txt", content: "needle" });
    const g = await sibling(f);
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(g, "Grep", { pattern: "needle" });
    expect(textOf(r)).toContain("/workspace/h.txt");
    expectManaged(legacy, ["stat", "exec"]);
    expect(await markedPaths(g)).toHaveLength(1);
  });

  it("Deliver reads the file through managed operations after its own marked paths", async () => {
    const f = await seed();
    await runTool(f, "Write", { file_path: "/workspace/d.txt", content: "deliver me" });
    const g = await sibling(f);
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(g, "Deliver", { file_path: "/workspace/d.txt" });
    expect(textOf(r)).toContain("Delivered d.txt");
    expectManaged(legacy, ["stat", "readFile"]);
    expect(await markedPaths(g)).toHaveLength(1);
  });

  it("foreground Bash runs its command through a managed exec after the marked paths", async () => {
    const f = await seed();
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(f, "Bash", { command: "echo managed-hi", description: "Say hi" });
    expect(textOf(r)).toContain("managed-hi");
    expectManaged(legacy, ["exec"]);
  });

  it("background Bash launches through the managed start after the marked paths", async () => {
    const f = await seed();
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(f, "Bash", {
      command: "sleep 30",
      description: "Wait",
      run_in_background: true,
    });
    expect(textOf(r)).toContain("Started");
    expectManaged(legacy, ["backgroundStart"]);
    const task = await f.db
      .selectFrom("background_tasks")
      .select(["operation_id", "launch_state"])
      .where("conversation_id", "=", f.conversationId)
      .executeTakeFirstOrThrow();
    expect(task.operation_id).not.toBeNull();
    expect(task.launch_state).toBe("acknowledged");
  });

  it("a background start the provider refuses tells the model kernel text, never the provider's words", async () => {
    const f = await seed();
    startRefuses = true;
    const err = await failure(
      runTool(f, "Bash", { command: "sleep 30", description: "Wait", run_in_background: true }),
    );
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/^The background task was not started: /);
    expect((err as ToolError).message).not.toContain("provider secret");
    // the task's reason (TaskOutput, TaskList, the HTTP view) is kernel text too
    const task = await f.db
      .selectFrom("background_tasks")
      .select(["status", "lost_reason"])
      .where("conversation_id", "=", f.conversationId)
      .executeTakeFirstOrThrow();
    expect(task.status).toBe("failed");
    expect(task.lost_reason).toMatch(/^launch refused: /);
    expect(task.lost_reason).not.toContain("provider secret");
  });

  it("FetchAttachment copies into its directory through the managed preparation after the marked paths", async () => {
    const f = await seed();
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(f, "FetchAttachment", { file: "notes.txt" });
    expect(textOf(r)).toMatch(
      /Copied notes\.txt to \/workspace\/attachments\/[0-9a-f]{12}\/notes\.txt/,
    );
    expect(legacy).not.toHaveBeenCalled();
    expect(await markedPaths(f)).toHaveLength(1);
    expect(reached).toEqual([{ method: "prepare", marked: 1 }]);
  });

  it("Skill reads a project skill through managed operations after its own marked paths", async () => {
    const f = await seed();
    await runTool(f, "Write", {
      file_path: "/workspace/.agents/skills/demo/SKILL.md",
      content: "---\nname: demo\ndescription: A demo.\n---\nDo the demo.\n",
    });
    const g = await sibling(f);
    await projectRoot(g, "/workspace");
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(g, "Skill", { skill: "project:demo" });
    expect(textOf(r)).toContain("Do the demo.");
    expectManaged(legacy, ["readFile"]);
    expect(await markedPaths(g)).toHaveLength(1);
  });

  it("Skill copies a plugin skill through the trusted preparation after the marked paths", async () => {
    const f = await seed();
    await catalogSkill(f, "plug");
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(f, "Skill", { skill: "plug" });
    expect(textOf(r)).toContain("Plug body.");
    expect(textOf(r)).toMatch(/copied to \/skills\/plug@/);
    expectManaged(legacy, ["prepare"]);
  });

  it("GenerateImage writes its device copy through managed operations after the marked paths", async () => {
    const f = await seed();
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(f, "GenerateImage", { prompt: "a fox", file_path: "/workspace/f.png" });
    expect(textOf(r)).toMatch(
      /Also written to the device \(same bytes as artifact [0-9a-f-]{36}\): \/workspace\/f\.png/,
    );
    expectManaged(legacy, ["stat", "writeFile"]);
    expect(await markedPaths(f)).toHaveLength(1);
  });

  it("GenerateImage reviewed against another root than the held evidence's is stale: nothing written", async () => {
    const f = await seed();
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const r = await runTool(
      f,
      "GenerateImage",
      { prompt: "a fox", file_path: "/workspace/s.png" },
      { over: { reviewedAgainstRoot: "/workspace/other" } },
    );
    // the images are delivered; the device line carries the stale refusal
    expect(textOf(r)).toContain(`Not written to the device: ${MANAGED_DEVICE_CONTEXT_STALE_TEXT}`);
    expect(legacy).not.toHaveBeenCalled();
    expect(reached).toEqual([]);
    expect(await markedPaths(f)).toEqual([]);
  });

  it("a call reviewed against the held evidence's own working root runs (any spelling of it)", async () => {
    const f = await seed();
    const r = await runTool(
      f,
      "Bash",
      { command: "echo same-root", description: "Same" },
      { over: { reviewedAgainstRoot: `${ROOTS.workspace}/./` } },
    );
    expect(textOf(r)).toContain("same-root");
  });
});

/**
 * B-18: every reviewed call carries the root it was judged against, the workspace included. When
 * the held device context names another root (the review fell back to the workspace while
 * admission uses the bound project's root, or the binding changed after the review), the call is
 * stale before anything is recorded or run, on every managed entry.
 */
describe("a call reviewed against another root than the held evidence's", () => {
  const OUTSIDE = "/srv/app";

  /** The root the command review judges the conversation's calls against now. */
  const reviewedRoot = async (f: Fixture): Promise<string | undefined> =>
    (await k.app.get(ConversationDevices).reviewFacts(f.orgId, f.conversationId))?.workingRoot;

  async function expectStale(
    f: Fixture,
    name: string,
    input: Record<string, unknown>,
    against: string,
  ): Promise<void> {
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const err = await failure(runTool(f, name, input, { over: { reviewedAgainstRoot: against } }));
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_STALE_TEXT);
    expect(legacy).not.toHaveBeenCalled();
    expect(reached).toEqual([]);
    expect(await markedPaths(f)).toEqual([]);
    legacy.mockRestore();
  }
  /**
   * The same call reviewed against the workspace in a conversation whose admission falls back to
   * the workspace as the review did (permission activation L2): it is not stale, the managed
   * writer records its marked paths and the call reaches the provider.
   */
  async function expectNotStale(
    f: Fixture,
    name: string,
    input: Record<string, unknown>,
    against: string,
  ): Promise<void> {
    const err = await runTool(f, name, input, { over: { reviewedAgainstRoot: against } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (err !== undefined)
      expect((err as Error).message).not.toBe(MANAGED_DEVICE_CONTEXT_STALE_TEXT);
    const [paths] = await markedPaths(f);
    expect(paths).toMatchObject({ workingRoot: ROOTS.workspace });
  }
  const BASH = { command: "rm -rf ./build", description: "Clean" };

  it("a workspace review of a project bound after the review (no snapshot yet) runs", async () => {
    const f = await seed();
    const against = await reviewedRoot(f);
    expect(against).toBe(ROOTS.workspace);
    await bindProject(f, OUTSIDE);
    expect(await reviewedRoot(f)).toBe(ROOTS.workspace);
    await expectNotStale(f, "Bash", BASH, against as string);
  });

  it("a workspace review because the project snapshot is unavailable runs", async () => {
    const f = await seed();
    await bindProject(f, OUTSIDE);
    await projectRoot(f, OUTSIDE, { reason: "gone", message: "The project's root is gone." });
    const against = await reviewedRoot(f);
    expect(against).toBe(ROOTS.workspace);
    await expectNotStale(f, "Bash", BASH, against as string);
  });

  it("a workspace review of a project outside the workspace without the wider reach runs", async () => {
    const f = await seed();
    // the device narrowed to sandbox mode: a cloud device then has only the workspace reach
    await f.db
      .updateTable("devices")
      .set({ mode: "sandbox" })
      .where("id", "=", f.deviceId)
      .execute();
    await bindProject(f, OUTSIDE);
    await projectRoot(f, OUTSIDE);
    const against = await reviewedRoot(f);
    expect(against).toBe(ROOTS.workspace);
    await expectNotStale(f, "Write", { file_path: "out.txt", content: "x" }, against as string);
  });

  it("a workspace review of a project above the owner's home runs", async () => {
    const f = await seed();
    await bindProject(f, "/home");
    await projectRoot(f, "/home");
    const against = await reviewedRoot(f);
    expect(against).toBe(ROOTS.workspace);
    await expectNotStale(
      f,
      "Edit",
      { file_path: "a.txt", old_string: "a", new_string: "b" },
      against as string,
    );
  });

  it("an approved ask's root, carried after a mode change dropped its working root", async () => {
    const f = await seed();
    // admission works in the usable project now; the person approved against the workspace
    await bindProject(f, OUTSIDE);
    await projectRoot(f, OUTSIDE);
    expect(await reviewedRoot(f)).toBe(OUTSIDE);
    await expectStale(f, "Bash", BASH, ROOTS.workspace);
  });

  it("the background start", async () => {
    const f = await seed();
    await bindProject(f, OUTSIDE);
    await projectRoot(f, OUTSIDE);
    await expectStale(f, "Bash", { ...BASH, run_in_background: true }, ROOTS.workspace);
    const tasks = await f.db
      .selectFrom("background_tasks")
      .select("id")
      .where("conversation_id", "=", f.conversationId)
      .execute();
    expect(tasks).toEqual([]);
  });

  it("the trusted preparation of a plugin skill copy", async () => {
    const f = await seed();
    await catalogSkill(f, "plug");
    await expectStale(f, "Skill", { skill: "plug" }, "/workspace/other");
  });

  it("the trusted preparation of an attachment copy", async () => {
    const f = await seed();
    await expectStale(f, "FetchAttachment", { file: "notes.txt" }, "/workspace/other");
  });
});

describe("builtin tools with the activation gate off", () => {
  it("keep the legacy route: no managed operation and no marked paths", async () => {
    const f = await seed();
    const legacy = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const managed = vi.spyOn(k.app.get(SandboxService), "withOperations");
    const r = await runTool(
      f,
      "Write",
      { file_path: "/workspace/off.txt", content: "off" },
      { gate: false },
    );
    expect(textOf(r)).toContain("Created /workspace/off.txt");
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(managed).not.toHaveBeenCalled();
    expect(reached).toEqual([]);
    const paths = await markedPaths(f);
    expect(paths).toHaveLength(1);
    expect(paths[0]).not.toHaveProperty("permissionContextVersion");
  });
});
