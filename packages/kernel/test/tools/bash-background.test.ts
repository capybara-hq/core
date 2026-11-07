import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, SandboxHandle, SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startedText } from "../../src/background/launch.js";
import { BackgroundLaunchLock } from "../../src/background/launch-lock.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { XactLock } from "../../src/infra/database/xact-lock.js";
import { SANDBOX_STARTED_NOTICE } from "../../src/tools/builtins/sandbox/common.js";
import { type SandboxToolDeps, sandboxTools } from "../../src/tools/builtins/sandbox/index.js";
import type { BuiltinCallContext, BuiltinTool } from "../../src/tools/registry.js";
import { createFakeSandbox, fakeWorkspaceDir } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { handlesFor } from "../helpers/identity.js";
import { sandboxServiceFor, seedEnvironment } from "../helpers/sandbox.js";
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
/** The environment the seeded conversation is bound to. */
let envId: string;
let provider: SandboxProvider | undefined;
let fake: SandboxProvider;
/** The fake instances created by a test (destroyed after it: their tasks die with them). */
let handles: SandboxHandle[];
/** Replaces the result of the launch exec (the one that runs `setsid nohup`), when set. */
let launchResult: ExecResult | undefined;
/** `currentInstance` answers null, when set (the instance cannot be read after the launch). */
let noInstance: boolean;
/** The launch exec throws: before running the script, or after it ran (its output lost). */
let launchThrows: "before" | "after" | undefined;
/** Kill execs (`pkill -KILL -s` loops) answer exit status 2, when set. */
let killFails: boolean;
/** `withSandbox` throws after its callback returned (a lease release failing), when set. */
let leaveThrows: boolean;
/** A stop claims the reservation while the launch exec runs (`claimStop`), when set. */
let claimOnLaunch: boolean;
/** The `changed` frames the tool published, as `[conversationId, what]`. */
let published: [string, string][];

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
  store = new BackgroundTaskStore(
    h.db,
    h.txHost,
    new BackgroundLaunchLock(new XactLock(h.db, h.txHost), h.txHost),
  );
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.environment_instances, capybara.environments, capybara.accounts, capybara.orgs",
  );
  root = await mkdtemp(join(tmpdir(), "cap-bash-bg-"));
  handles = [];
  const impl = createFakeSandbox(root);
  fake = Object.create(impl) as SandboxProvider;
  fake.create = async (args) => {
    const h = await impl.create(args);
    handles.push(h);
    return h;
  };
  fake.exec = async (h, args) => {
    const isLaunch = args.command.includes("setsid nohup");
    if (isLaunch && launchResult !== undefined) return launchResult;
    if (isLaunch && launchThrows === "before") throw new Error("argument list too long");
    if (isLaunch && claimOnLaunch) {
      for (const t of await store.runningIn(seed.conversationId)) {
        if (t.sid === null) expect(await store.claimStop(t.id)).toBe(true);
      }
    }
    if (killFails && args.command.includes("pkill -KILL -s")) {
      return { exitCode: 2, stdout: "", stderr: "", truncated: false, timedOut: false };
    }
    const r = await impl.exec(h, args);
    if (isLaunch && launchThrows === "after") throw new Error("connection reset");
    return r;
  };
  launchResult = undefined;
  noInstance = false;
  launchThrows = undefined;
  killFails = false;
  leaveThrows = false;
  claimOnLaunch = false;
  published = [];
  provider = fake;
  config = configWith({});
  seed = await seedConversation(raw);
  envId = await seedEnvironment(raw, seed.orgId, seed.accountId);
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
  const wrapped = Object.create(sandbox) as typeof sandbox;
  wrapped.currentInstance = (env) =>
    noInstance ? Promise.resolve(null) : sandbox.currentInstance(env);
  wrapped.withSandbox = (async (...args: Parameters<typeof sandbox.withSandbox>) => {
    const v = await sandbox.withSandbox(...args);
    if (leaveThrows) throw new Error("cannot release the sandbox lease: redis down");
    return v;
  }) as typeof sandbox.withSandbox;
  const deps: SandboxToolDeps = {
    sandbox: wrapped,
    environments: { forTool: async () => envId },
    background: store,
    attachments: {
      listForConversation: async () => [],
      openForConversation: async () => null,
    } as unknown as SandboxToolDeps["attachments"],
    storage: {} as unknown as SandboxToolDeps["storage"],
    eventLog: {
      publishChanged: async (c: string, what: string) => {
        published.push([c, what]);
      },
    } as unknown as SandboxToolDeps["eventLog"],
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

/** A call context without a run id. */
const withoutRun = (): BuiltinCallContext => {
  const { runId: _, ...rest } = ctx();
  return rest;
};

const textOf = (r: Awaited<ReturnType<BuiltinTool["run"]>>): string =>
  "content" in r ? (r.content[0] as { text: string }).text : "";

const sandboxCreatedAt = async (env: string): Promise<Date> =>
  (
    await db
      .selectFrom("environment_instances")
      .select("created_at")
      .where("environment_id", "=", env)
      .executeTakeFirstOrThrow()
  ).created_at;

async function until(cond: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Whether `pgrep -s <sid>` finds a process in the conversation's sandbox. */
async function alive(sid: string): Promise<boolean> {
  const h = handles[0] as SandboxHandle;
  const r = await fake.exec(h, {
    command: `pgrep -s ${sid}`,
    timeoutMs: 10_000,
    maxOutputBytes: 10_000,
    signal: signal(),
    tag: "test",
    actor: { accountId: seed.accountId, conversationId: seed.conversationId },
  });
  return r.exitCode === 0;
}

// each test spawns several node shims (setsid, pgrep, pkill) per launch and check: under a loaded
// full run that takes seconds, past vitest's 5 s default
describe("Bash run_in_background", { timeout: 30_000 }, () => {
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
    // "at once" means without waiting for the 30 s command: the launch itself spawns node shims,
    // which take seconds under a loaded full run, so a tight bound here only measures load
    expect(Date.now() - t0).toBeLessThan(15_000);
    const [row] = await store.runningIn(seed.conversationId);
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.id).toMatch(/^bt_[a-z2-7]{6}$/);
    expect(textOf(r)).toBe(`${SANDBOX_STARTED_NOTICE}\n\n${startedText(row.id, "Sleep a while")}`);
    expect("isError" in r && r.isError).toBe(false);
    expect(row).toMatchObject({
      orgId: seed.orgId,
      conversationId: seed.conversationId,
      sandboxConversationId: seed.conversationId,
      environmentId: envId,
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
    expect(row.sandboxCreatedAt).toEqual(await sandboxCreatedAt(envId));
    // the command lives on after the call
    expect(await alive(row.sid as string)).toBe(true);
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
      environmentId: envId,
    });
    expect(row?.sandboxCreatedAt).toEqual(await sandboxCreatedAt(envId));
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

  it("six launches at once with maxTasks 4: exactly four start, two are refused", async () => {
    const tool = bash();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        tool.run(
          { command: "sleep 30", description: `Parallel ${i}`, run_in_background: true },
          ctx(),
        ),
      ),
    );
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      expect(String((r as PromiseRejectedResult).reason)).toContain(
        "4 background tasks are already running",
      );
    }
    const running = await store.runningIn(seed.conversationId);
    expect(running).toHaveLength(4);
    for (const t of running) expect(t.sid).toMatch(/^[1-9][0-9]*$/);
  });

  it("a launch that fails (a missing program) is a readable error and the row ends failed", async () => {
    launchResult = {
      exitCode: 127,
      stdout: "",
      stderr:
        "Background tasks need bash, setsid, nohup, timeout, pgrep, pkill, base64 in the sandbox; setsid is missing.\n",
      truncated: false,
      timedOut: false,
    };
    await expect(
      bash().run({ command: "sleep 30", description: "No setsid", run_in_background: true }, ctx()),
    ).rejects.toThrow(
      "The background task was not started: Background tasks need bash, setsid, nohup, timeout, pgrep, pkill, base64 in the sandbox; setsid is missing. Check the sandbox, or call Bash without run_in_background.",
    );
    const [row] = await store.listFor([seed.conversationId]);
    expect(row).toMatchObject({ status: "failed", sid: null, description: "No setsid" });
    expect(row?.lostReason).toContain("setsid is missing");
    expect(row?.finishedAt).not.toBeNull();
    expect(await store.countRunning(seed.conversationId)).toBe(0);
    // a client that listed the reservation as running refreshes (M4)
    expect(published).toEqual([[seed.conversationId, "background"]]);
  });

  it("a command that started but cannot be recorded is killed and the row ends failed", async () => {
    noInstance = true;
    await expect(
      bash().run({ command: "sleep 30", description: "Untracked", run_in_background: true }, ctx()),
    ).rejects.toThrow(
      "The background command started but could not be recorded (the sandbox instance could not be read), so it was stopped.",
    );
    const [row] = await store.listFor([seed.conversationId]);
    expect(row).toMatchObject({ status: "failed", sid: null });
    expect(published).toEqual([[seed.conversationId, "background"]]);
    // every session the fake's setsid started is gone
    const h = handles[0] as SandboxHandle;
    const sids = await readdir(join(root, "instances", h.id, "sessions"));
    expect(sids.length).toBe(1);
    for (const sid of sids) await until(async () => !(await alive(sid)));
  });

  it("a stop that claimed the reservation during the launch: the command is killed, the row ends stopped", async () => {
    claimOnLaunch = true;
    await expect(
      bash().run({ command: "sleep 30", description: "Stopped", run_in_background: true }, ctx()),
    ).rejects.toThrow(
      /^Background task bt_[a-z2-7]{6} \("Stopped"\) was stopped while it was starting, so nothing runs\./,
    );
    const [row] = await store.listFor([seed.conversationId]);
    expect(row).toMatchObject({ status: "stopped", stoppingAt: null });
    expect(published).toEqual([[seed.conversationId, "background"]]);
    expect(row?.sid).toMatch(/^[1-9][0-9]*$/);
    await until(async () => !(await alive(row?.sid as string)));
  });

  it("an error after the row has its sid (releasing the lease) does not undo the launch", async () => {
    leaveThrows = true;
    const r = await bash().run(
      { command: "sleep 30", description: "Started anyway", run_in_background: true },
      ctx(),
    );
    const [row] = await store.listFor([seed.conversationId]);
    expect(row).toMatchObject({ status: "running", description: "Started anyway" });
    expect(row?.sid).toMatch(/^[1-9][0-9]*$/);
    expect(textOf(r)).toBe(startedText(row?.id as string, "Started anyway"));
    expect(await alive(row?.sid as string)).toBe(true);
  });

  it("a launch exec that throws after starting the command: the session from the .sid file is killed", async () => {
    launchThrows = "after";
    await expect(
      bash().run(
        { command: "sleep 30", description: "Lost output", run_in_background: true },
        ctx(),
      ),
    ).rejects.toThrow("connection reset");
    const [row] = await store.listFor([seed.conversationId]);
    expect(row).toMatchObject({ status: "failed", sid: null });
    expect(row?.lostReason).toBe("launch failed: connection reset");
    const h = handles[0] as SandboxHandle;
    const sid = (
      await readFile(
        join(fakeWorkspaceDir(root, h.id), ".capybara", "tasks", `${row?.id}.sid`),
        "utf8",
      )
    ).trim();
    expect(sid).toMatch(/^[1-9][0-9]*$/);
    await until(async () => !(await alive(sid)));
  });

  it("a provider error on a very large command names the size limit", async () => {
    launchThrows = "before";
    const command = `: ${"a".repeat(80_000)}`;
    await expect(
      bash().run({ command, description: "Huge", run_in_background: true }, ctx()),
    ).rejects.toThrow(
      "The background task was not started: argument list too long. Check the sandbox, or call Bash without run_in_background. A very large command (over about 96 KB after base64) cannot be started in the background",
    );
    const [row] = await store.listFor([seed.conversationId]);
    expect(row).toMatchObject({ status: "failed", sid: null });
  });

  it("an unrecorded command whose kill fails is not called stopped", async () => {
    noInstance = true;
    killFails = true;
    await expect(
      bash().run(
        { command: "sleep 30", description: "Unkillable", run_in_background: true },
        ctx(),
      ),
    ).rejects.toThrow(
      "The background command started but could not be recorded (the sandbox instance could not be read); an attempt to stop it failed, so it ends at its timeout.",
    );
    const [row] = await store.listFor([seed.conversationId]);
    expect(row).toMatchObject({ status: "failed", sid: null });
  });

  it("refuses without a run id and records nothing", async () => {
    await expect(
      bash().run(
        { command: "sleep 30", description: "No run", run_in_background: true },
        withoutRun(),
      ),
    ).rejects.toThrow("Background tasks can only be started from an agent run");
    expect(await store.listFor([seed.conversationId])).toEqual([]);
  });

  it("without a sandbox the tool is unavailable and a call fails with the usual error", async () => {
    provider = undefined;
    const tool = bash();
    expect(await tool.unavailable?.({ orgId: seed.orgId })).toMatch(/^No sandbox is configured/);
    await expect(
      tool.run({ command: "sleep 30", description: "x", run_in_background: true }, ctx()),
    ).rejects.toThrow(/No sandbox is configured in this deployment/);
    expect(await store.listFor([seed.conversationId])).toEqual([]);
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
