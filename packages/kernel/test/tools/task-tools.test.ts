import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type BackgroundTaskRow, BackgroundTaskStore } from "../../src/background/store.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import { taskReadScript } from "../../src/tools/builtins/sandbox/task-output.js";
import type { BuiltinCallContext, BuiltinTool } from "../../src/tools/registry.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, runConfig, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * `TaskOutput` and `TaskStop` (spec 2026-11-05-background-bash-design §2.2, §2.3) on one kernel
 * with the fake sandbox; tasks are started with `Bash` and `run_in_background`. The scheduled poll
 * runs hourly here, so every finish below is one these tools observed.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
const SPILL = 50_000;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let sandbox: SandboxService;
let store: BackgroundTaskStore;
let tools: readonly BuiltinTool[];
/** The conversations whose sandboxes a test used (destroyed after it: their tasks die with them). */
let used: string[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-task-tools-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root } },
        sandbox: { background: { pollSeconds: 3600 } },
        tools: { outputSpillChars: SPILL },
      },
    ),
  );
  sandbox = k.app.get(SandboxService);
  store = k.app.get(BackgroundTaskStore);
  tools = k.app.get(BuiltinTools).list();
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  for (const c of used) await sandbox.destroyFor(c).catch(() => {});
  used = [];
  await sql`UPDATE capybara.background_tasks SET status = 'lost', finished_at = now()
    WHERE status = 'running'`.execute(raw);
});

const tool = (name: string): BuiltinTool => tools.find((t) => t.spec.name === name) as BuiltinTool;

type Conv = Awaited<ReturnType<typeof seedConversation>>;

async function conversation(): Promise<Conv> {
  const s = await seedConversation(raw);
  used.push(s.conversationId);
  return s;
}

const ctxOf = (c: Conv, over: Partial<BuiltinCallContext> = {}): BuiltinCallContext => ({
  orgId: c.orgId,
  accountId: c.accountId,
  agentId: c.agentId,
  conversationId: c.conversationId,
  callId: `call-${randomUUID().slice(0, 8)}`,
  runId: "run-1",
  signal: AbortSignal.timeout(60_000),
  ...over,
});

type Result = Awaited<ReturnType<BuiltinTool["run"]>>;
const textOf = (r: Result): string =>
  "content" in r ? (r.content[0] as { text: string }).text : "";
const isError = (r: Result): boolean => "isError" in r && r.isError === true;

/** Starts `command` in the background through `Bash`; returns the task's row. */
async function start(ctx: BuiltinCallContext, command: string): Promise<BackgroundTaskRow> {
  const r = await tool("Bash").run(
    { command, description: "Run it", run_in_background: true },
    ctx,
  );
  const id = /Started background task (bt_[a-z2-7]{6})/.exec(textOf(r))?.[1];
  expect(id, textOf(r)).toBeDefined();
  return (await store.get(id as string)) as BackgroundTaskRow;
}

/** Runs `command` in the conversation's sandbox. */
async function shell(c: Conv, command: string): Promise<string> {
  return sandbox.withSandbox(
    c,
    async (h, p, _info, sig) =>
      (
        await p.exec(h, {
          command,
          cwd: "/workspace",
          timeoutMs: 20_000,
          maxOutputBytes: 64_000,
          signal: sig,
        })
      ).stdout,
    AbortSignal.timeout(30_000),
  );
}

const output = (c: Conv, input: Record<string, unknown>, over?: Partial<BuiltinCallContext>) =>
  tool("TaskOutput").run(input, ctxOf(c, over));
const stop = (c: Conv, input: Record<string, unknown>, over?: Partial<BuiltinCallContext>) =>
  tool("TaskStop").run(input, ctxOf(c, over));

type Finished = Extract<ConversationEvent, { type: "background_task_finished" }>;
const finishedEvents = async (conversationId: string, taskId: string): Promise<Finished[]> =>
  (await eventsOf(db, conversationId)).filter(
    (e): e is Finished => e.type === "background_task_finished" && e.payload.taskId === taskId,
  );

describe("TaskOutput", () => {
  it("two reads return the new output only: first a, then b", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "echo a; while [ ! -f go ]; do sleep 0.1; done; echo b");
    await waitFor(
      async () => (await shell(c, `cat .capybara/tasks/${t.id}.out`)).includes("a"),
      10_000,
      "first line",
    );
    const first = textOf(await output(c, { task_id: t.id, block: false }));
    expect(first).toMatch(/^Status: running \(\d+s\)/);
    expect(first).toContain("\na\n");
    expect(first).not.toContain("b");
    expect((await store.get(t.id))?.readOffset).toBe(2);
    await shell(c, "touch go");
    const second = textOf(await output(c, { task_id: t.id, timeout: 10_000 }));
    expect(second).toMatch(/^Status: completed, exit code 0, after \d+s/);
    expect(second).toContain("\nb\n");
    expect(second).not.toMatch(/\na\n/);
    // the finish this read observed is reported: its event says so, and the row is completed
    expect(await store.get(t.id)).toMatchObject({
      status: "completed",
      exitCode: 0,
      readOffset: 4,
    });
    const events = await finishedEvents(c.conversationId, t.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ status: "completed", reported: true });
  }, 60_000);

  it("block waits for the task to finish", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "sleep 3; echo done");
    const t0 = Date.now();
    const text = textOf(await output(c, { task_id: t.id, block: true }));
    expect(Date.now() - t0).toBeGreaterThan(1500);
    expect(text).toMatch(/^Status: completed, exit code 0, after \d+s/);
    expect(text).toContain("done");
  }, 60_000);

  it("block with a timeout returns after about the timeout, still running", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "sleep 30");
    const t0 = Date.now();
    const text = textOf(await output(c, { task_id: t.id, timeout: 1000 }));
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1000);
    expect(took).toBeLessThan(6000);
    expect(text).toMatch(/^Status: running \(\d+s\)/);
    expect(text).toContain("[No new output.]");
    expect((await store.get(t.id))?.status).toBe("running");
  }, 60_000);

  it("never waits past the run's time left", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "sleep 30");
    const t0 = Date.now();
    // the run's deadline is 31 s away: 30 s of it is the margin, 1 s is left to wait
    const text = textOf(
      await output(c, { task_id: t.id, timeout: 600_000 }, { runDeadline: Date.now() + 31_000 }),
    );
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(text).toMatch(/^Status: running/);
  }, 60_000);

  it("a 20 MB output is read a bounded slice at a time", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "head -c 20000000 /dev/zero | tr '\\0' x");
    const text = textOf(await output(c, { task_id: t.id, timeout: 30_000 }));
    expect(text).toMatch(/^Status: completed, exit code 0/);
    // the output part is exactly the cap; the pipeline spills the result (over outputSpillChars)
    expect(text.match(/x{100,}/)?.[0]).toHaveLength(SPILL);
    expect(text.length).toBeGreaterThan(SPILL);
    expect(text.length).toBeLessThan(SPILL + 500);
    expect(text).toContain(`${20_000_000 - SPILL} more bytes`);
    expect((await store.get(t.id))?.readOffset).toBe(SPILL);
    // the next read continues after it
    const next = textOf(await output(c, { task_id: t.id, block: false }));
    expect(next.match(/x{100,}/)?.[0]).toHaveLength(SPILL);
    expect((await store.get(t.id))?.readOffset).toBe(2 * SPILL);
  }, 60_000);

  it("the read exec takes a bounded slice: tail -c +<offset+1> | head -c <cap>", () => {
    const s = taskReadScript({ id: "bt_abcdef", sid: "42", running: true }, 1000, SPILL);
    expect(s).toContain(`tail -c +1001 .capybara/tasks/bt_abcdef.out`);
    expect(s).toContain(`| head -c ${SPILL} |`);
    expect(s).toContain("pgrep -s 42");
    // a finished task's read checks no liveness
    expect(taskReadScript({ id: "bt_abcdef", sid: "42", running: false }, 0, 10)).not.toContain(
      "pgrep",
    );
  });

  it("a multi-byte character cut by the cap is left for the next read", async () => {
    const c = await conversation();
    // 3 bytes each: a cap of 50 000 bytes ends inside the 16 667th one
    const t = await start(ctxOf(c), `i=0; while [ $i -lt 17000 ]; do printf '€'; i=$((i+1)); done`);
    const text = textOf(await output(c, { task_id: t.id, timeout: 30_000 }));
    expect(text.match(/€+/)?.[0]).toHaveLength(16_666);
    expect((await store.get(t.id))?.readOffset).toBe(16_666 * 3);
    const next = textOf(await output(c, { task_id: t.id, block: false }));
    expect(next.match(/€+/)?.[0]).toHaveLength(17_000 - 16_666);
  }, 90_000);

  it("a failed task shows its exit code", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "echo oops; exit 3");
    const text = textOf(await output(c, { task_id: t.id }));
    expect(text).toMatch(/^Status: failed, exit code 3, after \d+s/);
    expect(text).toContain("oops");
  }, 60_000);

  it("a task whose sandbox was suspended is lost, its output unavailable, nothing resumed", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "sleep 300");
    expect(await sandbox.suspendIdle(new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThan(0);
    const r = await output(c, { task_id: t.id });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toMatch(/^Status: lost \(the sandbox was suspended\)/);
    expect(textOf(r)).toContain("Output unavailable");
    expect(await store.get(t.id)).toMatchObject({
      status: "lost",
      lostReason: "sandbox_suspended",
    });
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload.reported).toBe(true);
    const st = await db
      .selectFrom("sandboxes")
      .select("status")
      .where("conversation_id", "=", c.conversationId)
      .executeTakeFirstOrThrow();
    expect(st.status).toBe("suspended");
  }, 60_000);

  it("an unknown id, or a task of another conversation (a sub-agent's), is not found", async () => {
    const parent = await conversation();
    const childId = randomUUID();
    await sql`INSERT INTO capybara.conversations
        (id, org_id, agent_id, account_id, kind, parent_conversation_id)
      VALUES (${childId}, ${parent.orgId}, ${parent.agentId}, ${parent.accountId}, 'subagent',
        ${parent.conversationId})`.execute(raw);
    // the child's task runs in the parent's sandbox
    const t = await start(
      ctxOf(parent, { conversationId: childId, sandboxConversationId: parent.conversationId }),
      "sleep 30",
    );
    expect(t).toMatchObject({
      conversationId: childId,
      sandboxConversationId: parent.conversationId,
    });
    for (const id of [t.id, "bt_aaaaaa", "nope"]) {
      for (const run of [output, stop]) {
        const e = await run(parent, { task_id: id }).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(ToolError);
        expect((e as Error).message).toContain(`No background task ${id} in this conversation`);
      }
    }
    expect((await store.get(t.id))?.status).toBe("running");
  }, 60_000);
});

describe("TaskStop", () => {
  it("stops a running task, with its final status and last lines", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "echo started; sleep 300");
    await waitFor(
      async () => (await shell(c, `cat .capybara/tasks/${t.id}.out`)).includes("started"),
      10_000,
      "output",
    );
    const r = await stop(c, { task_id: t.id });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toContain(`Background task ${t.id} ("Run it") was stopped.`);
    expect(textOf(r)).toMatch(/Status: stopped after \d+s/);
    expect(textOf(r)).toContain("Last lines:\nstarted");
    expect((await store.get(t.id))?.status).toBe("stopped");
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload).toMatchObject({
      status: "stopped",
      reported: true,
    });
  }, 60_000);

  it("a task that already finished: says so, not an error", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "echo fin");
    await output(c, { task_id: t.id });
    expect((await store.get(t.id))?.status).toBe("completed");
    const r = await stop(c, { task_id: t.id });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toContain(`Background task ${t.id} ("Run it") had already finished.`);
    expect(textOf(r)).toMatch(/Status: completed, exit code 0, after \d+s/);
    expect(textOf(r)).toContain("Last lines:\nfin");
  }, 60_000);

  it("a task still being launched is stopping, not a failure", async () => {
    const c = await conversation();
    const id = "bt_zzzzzz";
    const now = new Date();
    expect(
      await store.reserve(
        {
          id,
          orgId: c.orgId,
          conversationId: c.conversationId,
          sandboxConversationId: c.conversationId,
          runId: "run-1",
          callId: "call-1",
          triggerAccountId: c.accountId,
          description: "Launching",
          command: "sleep 1",
          outputPath: `.capybara/tasks/${id}.out`,
          startedAt: now,
          deadlineAt: new Date(now.getTime() + 60_000),
        },
        4,
      ),
    ).toBe(true);
    const r = await stop(c, { task_id: id });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toContain(`Background task ${id} ("Launching") is stopping`);
  }, 30_000);
});

describe("the Claude Code tool map", () => {
  it("names TaskOutput and TaskStop as themselves", () => {
    expect(CLAUDE_CODE_TOOL_MAP).toContain("- TaskOutput -> TaskOutput, TaskStop -> TaskStop");
    expect(CLAUDE_CODE_TOOL_MAP).not.toContain("TaskOutput, TaskStop -> not available");
  });
});
