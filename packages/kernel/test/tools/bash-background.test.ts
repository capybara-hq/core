import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxHandle, SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startedText } from "../../src/background/launch.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { type SandboxToolDeps, sandboxTools } from "../../src/tools/builtins/sandbox/index.js";
import type { BuiltinCallContext, BuiltinTool } from "../../src/tools/registry.js";
import { createFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { handlesFor } from "../helpers/identity.js";
import { sandboxServiceFor } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * `Bash` with `run_in_background` (spec 2026-11-05-background-bash-design §2.1, §4.2): one short
 * launch exec under the call's shared lease, then a `running` row; the command keeps running.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let store: BackgroundTaskStore;
let config: KernelConfig;
let root: string;
let seed: Awaited<ReturnType<typeof seedConversation>>;
let provider: SandboxProvider | undefined;
let fake: SandboxProvider;
/** The fake instances created by a test (destroyed after it: their tasks die with them). */
let handles: SandboxHandle[];

const signal = () => AbortSignal.timeout(30_000);

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
  const h = handlesFor(raw);
  store = new BackgroundTaskStore(h.db, h.txHost);
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(raw, "capybara.sandboxes, capybara.accounts, capybara.orgs");
  root = await mkdtemp(join(tmpdir(), "cap-bash-bg-"));
  handles = [];
  const impl = createFakeSandbox(root);
  fake = Object.create(impl) as SandboxProvider;
  fake.create = async (args) => {
    const h = await impl.create(args);
    handles.push(h);
    return h;
  };
  provider = fake;
  config = configWith({});
  seed = await seedConversation(raw);
});

afterEach(async () => {
  for (const h of handles) await fake.destroy(h, signal()).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

function configWith(o: { maxSeconds?: number; maxCommandSeconds?: number; maxTasks?: number }) {
  return KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    sandbox: {
      background: {
        ...(o.maxSeconds !== undefined && { maxSeconds: o.maxSeconds }),
        ...(o.maxTasks !== undefined && { maxTasks: o.maxTasks }),
      },
      limits: {
        ...(o.maxCommandSeconds !== undefined && { maxCommandSeconds: o.maxCommandSeconds }),
      },
    },
  });
}

function bash(): BuiltinTool {
  const sandbox = sandboxServiceFor({
    db,
    redis,
    provider: () => (provider ? { plugin: "sandbox-fake", impl: provider } : undefined),
    config: () => config,
    log: {},
    lockPollMs: 20,
  });
  const deps: SandboxToolDeps = {
    sandbox,
    background: store,
    attachments: {
      listForConversation: async () => [],
      openForConversation: async () => null,
    } as unknown as SandboxToolDeps["attachments"],
    storage: {} as unknown as SandboxToolDeps["storage"],
    eventLog: {} as unknown as SandboxToolDeps["eventLog"],
    config: { get: () => config },
  };
  return sandboxTools(deps).find((t) => t.spec.name === "Bash") as BuiltinTool;
}

const ctx = (over: Partial<BuiltinCallContext> = {}): BuiltinCallContext => ({
  orgId: seed.orgId,
  accountId: seed.accountId,
  agentId: seed.agentId,
  conversationId: seed.conversationId,
  callId: `call-${randomUUID().slice(0, 8)}`,
  runId: "run-1",
  signal: signal(),
  ...over,
});

const textOf = (r: Awaited<ReturnType<BuiltinTool["run"]>>): string =>
  "content" in r ? (r.content[0] as { text: string }).text : "";

const sandboxCreatedAt = async (conv: string): Promise<Date> =>
  (
    await db
      .selectFrom("sandboxes")
      .select("created_at")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow()
  ).created_at;

/** Whether `pgrep -s <sid>` finds a process in the conversation's sandbox. */
async function alive(sid: string): Promise<boolean> {
  const h = handles[0] as SandboxHandle;
  const r = await fake.exec(h, {
    command: `pgrep -s ${sid}`,
    timeoutMs: 10_000,
    maxOutputBytes: 10_000,
    signal: signal(),
  });
  return r.exitCode === 0;
}

describe("Bash run_in_background", () => {
  it("returns the started text at once and records a running task", async () => {
    const t0 = Date.now();
    const c = ctx();
    const r = await bash().run(
      {
        command: "sleep 30",
        description: "Sleep a while",
        run_in_background: true,
        timeout: 600_000,
      },
      c,
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    const [row] = await store.runningIn(seed.conversationId);
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.id).toMatch(/^bt_[a-z2-7]{6}$/);
    expect(textOf(r)).toBe(
      `Sandbox started for this conversation (first use); the working directory is /workspace.\n\n${startedText(row.id, "Sleep a while")}`,
    );
    expect("isError" in r && r.isError).toBe(false);
    expect(row).toMatchObject({
      orgId: seed.orgId,
      conversationId: seed.conversationId,
      sandboxConversationId: seed.conversationId,
      runId: "run-1",
      callId: c.callId,
      triggerAccountId: seed.accountId,
      description: "Sleep a while",
      command: "sleep 30",
      outputPath: `.capybara/tasks/${row.id}.out`,
      status: "running",
    });
    expect(row.sid).toMatch(/^[1-9][0-9]*$/);
    expect(row.deadlineAt.getTime() - row.startedAt.getTime()).toBe(600_000);
    expect(row.sandboxCreatedAt).toEqual(await sandboxCreatedAt(seed.conversationId));
    // the command lives on after the call
    expect(await alive(row.sid)).toBe(true);
  });

  it("a sub-agent's task is its own conversation's, counted in the parent's sandbox", async () => {
    const child = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${child}, ${seed.orgId}, ${seed.agentId}, ${seed.accountId})`.execute(raw);
    await bash().run(
      { command: "sleep 30", description: "Child task", run_in_background: true },
      ctx({ conversationId: child, sandboxConversationId: seed.conversationId }),
    );
    const [row] = await store.runningIn(seed.conversationId);
    expect(row).toMatchObject({
      conversationId: child,
      sandboxConversationId: seed.conversationId,
    });
    expect(row?.sandboxCreatedAt).toEqual(await sandboxCreatedAt(seed.conversationId));
    expect(await store.countRunning(seed.conversationId)).toBe(1);
  });

  it("refuses the fifth launch while four run in the sandbox", async () => {
    const tool = bash();
    for (let i = 0; i < 4; i++) {
      await tool.run(
        { command: "sleep 30", description: `Task ${i}`, run_in_background: true },
        ctx(),
      );
    }
    await expect(
      tool.run({ command: "sleep 30", description: "Fifth", run_in_background: true }, ctx()),
    ).rejects.toThrow(
      "4 background tasks are already running; stop one with TaskStop or wait for one to finish, then retry",
    );
    expect(await store.countRunning(seed.conversationId)).toBe(4);
  });

  it("without a sandbox the tool is unavailable and a call fails with the usual error", async () => {
    provider = undefined;
    const tool = bash();
    expect(tool.unavailable?.()).toMatch(/^No sandbox is configured/);
    await expect(
      tool.run({ command: "sleep 30", description: "x", run_in_background: true }, ctx()),
    ).rejects.toThrow(/No sandbox is configured in this deployment/);
    expect(await store.countRunning(seed.conversationId)).toBe(0);
  });

  it("clamps timeout to the background maximum (itself at most maxCommandSeconds) and says so", async () => {
    config = configWith({ maxSeconds: 7200, maxCommandSeconds: 900 });
    const tool = bash();
    const r = await tool.run(
      { command: "sleep 30", description: "Long", run_in_background: true, timeout: 5_000_000 },
      ctx(),
    );
    const [row] = await store.runningIn(seed.conversationId);
    expect(row && row.deadlineAt.getTime() - row.startedAt.getTime()).toBe(900_000);
    expect(textOf(r)).toContain(
      "[timeout 5000000 ms is over the background task maximum; it was lowered to 900000 ms.]",
    );

    // no timeout: the background maximum, not the foreground default
    config = configWith({ maxSeconds: 1800 });
    const r2 = await tool.run(
      { command: "sleep 30", description: "Default", run_in_background: true },
      ctx(),
    );
    expect(textOf(r2)).not.toContain("lowered");
    const rows = await store.runningIn(seed.conversationId);
    const d = rows.find((t) => t.description === "Default");
    expect(d && d.deadlineAt.getTime() - d.startedAt.getTime()).toBe(1_800_000);
  });

  it("the pipeline's time limit is the short launch, not the task's timeout", () => {
    const tool = bash();
    const bg = tool.timeoutMs?.({
      command: "x",
      description: "x",
      run_in_background: true,
      timeout: 3_600_000,
    });
    const fg = tool.timeoutMs?.({ command: "x", description: "x", timeout: 3_600_000 });
    expect(fg).toBeGreaterThan(3_600_000);
    expect(bg).toBeLessThan(fg as number);
    expect(bg).toBeLessThan(3_600_000);
  });

  it("a foreground call still runs to completion and records nothing", async () => {
    const r = await bash().run({ command: "echo hi", description: "Say hi" }, ctx());
    expect(textOf(r)).toContain("hi\n[exit code: 0]");
    expect(await store.countRunning(seed.conversationId)).toBe(0);
  });
});
