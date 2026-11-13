import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxGoneError, ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BackgroundTaskPollJob } from "../../src/background/poll.job.js";
import { type BackgroundTaskRow, BackgroundTaskStore } from "../../src/background/store.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { ApiError } from "../../src/errors.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import { TASK_LIST_FINISHED_LIMIT } from "../../src/tools/builtins/sandbox/task-list.js";
import {
  subagentNotTaskText,
  taskReadScript,
} from "../../src/tools/builtins/sandbox/task-output.js";
import type { BuiltinCallContext, BuiltinTool } from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { builtinsOff, onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  eventsOf,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";
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
const signal = () => AbortSignal.timeout(30_000);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let sandbox: SandboxService;
let store: BackgroundTaskStore;
let tools: readonly BuiltinTool[];
/** The devices a test used (destroyed after it: their tasks die with them). */
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
        // one command at a time: a blocking TaskOutput must not hold the slot while it waits
        sandbox: { background: { pollSeconds: 3600 }, maxConcurrentCommands: 1 },
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
  vi.restoreAllMocks();
  for (const e of used) await sandbox.destroyDevice(e).catch(() => {});
  used = [];
  await sql`UPDATE capybara.background_tasks SET status = 'lost', finished_at = now()
    WHERE status = 'running'`.execute(raw);
});

const tool = (name: string): BuiltinTool => tools.find((t) => t.spec.name === name) as BuiltinTool;

type Conv = Awaited<ReturnType<typeof seedConversation>> & { deviceId: string };

/** A seeded conversation bound to a device of its own. */
async function conversation(): Promise<Conv> {
  const s = await seedConversation(raw);
  const deviceId = await seedDevice(raw, s.orgId, s.accountId);
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", s.conversationId)
    .execute();
  used.push(deviceId);
  return { ...s, deviceId };
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
    {
      orgId: c.orgId,
      deviceId: c.deviceId,
      holderConversationId: c.conversationId,
      actor: { accountId: c.accountId, conversationId: c.conversationId },
    },
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

/** A reservation whose launch has not started the command (no sid), as `Bash` makes first. */
async function reservation(c: Conv, id: string): Promise<void> {
  const now = new Date();
  expect(
    await store.reserve(
      {
        id,
        orgId: c.orgId,
        conversationId: c.conversationId,
        sandboxConversationId: c.conversationId,
        deviceId: c.deviceId,
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
}

describe("offered with Bash", () => {
  it("a definition naming only Bash gets TaskOutput, TaskStop and TaskList; their policies validate", async () => {
    const c = await conversation();
    const registry = k.app.get(ToolRegistry);
    const got = await registry.forAgent(c.orgId, {
      source: "web",
      disabledTools: builtinsOff("Bash"),
    });
    expect(got.tools.map((t) => t.key)).toEqual(["Bash", "TaskOutput", "TaskStop", "TaskList"]);
    // an explicit ref changes nothing
    const both = await registry.forAgent(c.orgId, {
      source: "web",
      disabledTools: onlyBuiltins([
        { kind: "builtin", name: "TaskStop" },
        { kind: "builtin", name: "Bash" },
      ]),
    });
    expect(both.tools.map((t) => t.key).sort()).toEqual([
      "Bash",
      "TaskList",
      "TaskOutput",
      "TaskStop",
    ]);
    expect(both.unavailable).toEqual([]);
    // without Bash they are not offered
    const none = await registry.forAgent(c.orgId, {
      source: "web",
      disabledTools: builtinsOff("Read"),
    });
    expect(none.tools.map((t) => t.key)).toEqual(["Read"]);

    // through the agents API: a policy for TaskStop with only Bash referenced is accepted
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    const owner = await session(k, "owner");
    const orgId = await createOrg(owner);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Runner",
          instructions: "Run things.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
          toolPolicies: { TaskStop: "ask" },
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
  }, 60_000);
});

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
    expect(s).toContain("tk_alive 42");
    // a finished task's read checks no liveness
    expect(taskReadScript({ id: "bt_abcdef", sid: "42", running: false }, 0, 10)).not.toContain(
      "tk_alive",
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
      .selectFrom("device_instances")
      .select("status")
      .where("device_id", "=", c.deviceId)
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
        expect((e as Error).message).toContain("call TaskList to see this conversation's tasks");
      }
    }
    expect((await store.get(t.id))?.status).toBe("running");
  }, 60_000);

  it("a sub-agent's agentId gets the sub-agent text (TaskOutput as an answer, TaskStop as an error); other ids stay not found", async () => {
    const parent = await conversation();
    const child = randomUUID();
    const grandchild = randomUUID();
    for (const [id, up] of [
      [child, parent.conversationId],
      [grandchild, child],
    ] as const) {
      await sql`INSERT INTO capybara.conversations
          (id, org_id, agent_id, account_id, kind, parent_conversation_id)
        VALUES (${id}, ${parent.orgId}, ${parent.agentId}, ${parent.accountId}, 'subagent',
          ${up})`.execute(raw);
    }
    // the parent asks for its sub-agent and its sub-agent's sub-agent; the child for its own
    const asks: [BuiltinCallContext, string][] = [
      [ctxOf(parent), child],
      [ctxOf(parent), grandchild.toUpperCase()],
      [
        ctxOf(parent, { conversationId: child, sandboxConversationId: parent.conversationId }),
        grandchild,
      ],
    ];
    for (const [ctx, id] of asks) {
      // TaskOutput answers (not a failed call); TaskStop refuses (it cannot stop a sub-agent)
      const r = (await tool("TaskOutput").run({ task_id: id }, ctx)) as {
        isError: boolean;
        content: { text: string }[];
      };
      expect(r.isError).toBe(false);
      expect(r.content[0]?.text).toBe(subagentNotTaskText(id));
      const e = await tool("TaskStop")
        .run({ task_id: id }, ctx)
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ToolError);
      expect((e as Error).message).toBe(subagentNotTaskText(id));
    }
    // an unrelated conversation (another tree) and a random uuid are just not found
    const other = await conversation();
    for (const id of [other.conversationId, randomUUID()]) {
      for (const run of [output, stop]) {
        const e = await run(parent, { task_id: id }).catch((x: unknown) => x);
        expect((e as Error).message).toContain(`No background task ${id} in this conversation`);
      }
    }
  }, 60_000);
});

describe("the device access re-check", () => {
  it("TaskOutput and TaskStop check that the owner may still use the device", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "sleep 30");
    const forTool = vi
      .spyOn(k.app.get(ConversationDevices), "forTool")
      .mockRejectedValue(new ApiError("device.forbidden", "no longer allowed"));
    for (const run of [output, stop]) {
      const e = await run(c, { task_id: t.id, block: false }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ToolError);
      expect((e as Error).message).toContain("may no longer use its device");
    }
    expect(forTool).toHaveBeenCalledWith(c.orgId, c.conversationId);
    // nothing was read or stopped
    expect((await store.get(t.id))?.status).toBe("running");
    forTool.mockRestore();
    expect(isError(await output(c, { task_id: t.id, block: false }))).toBe(false);
  }, 60_000);
});

describe("TaskOutput: leases, reservations, reporting", () => {
  it("a blocking TaskOutput holds no lease while it waits: a Bash call runs meanwhile", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "sleep 30");
    const waiting = output(c, { task_id: t.id, timeout: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const r = await tool("Bash").run({ command: "echo hi", description: "Say hi" }, ctxOf(c));
    expect(textOf(r)).toContain("hi");
    // well before the blocking call's 8 s wait ends (with one command slot)
    expect(Date.now() - t0).toBeLessThan(5000);
    let done = false;
    void waiting.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    expect(textOf(await waiting)).toMatch(/^Status: running/);
  }, 60_000);

  it("a reservation (no sid yet) is still starting, with and without block", async () => {
    const c = await conversation();
    const id = "bt_yyyyyy";
    await reservation(c, id);
    for (const input of [{ block: false }, { timeout: 2500 }]) {
      const t0 = Date.now();
      const r = await output(c, { task_id: id, ...input });
      expect(textOf(r)).toMatch(
        /^Status: running \(\d+s\)\n\[The task is still starting; no output yet\.\]$/,
      );
      if ("timeout" in input) expect(Date.now() - t0).toBeGreaterThanOrEqual(2400);
    }
    // a launch that never started
    await store.failLaunch(id, "launch failed: boom");
    const r = await output(c, { task_id: id });
    expect(textOf(r)).toContain("[No output: the command never started.]");
    const s = await stop(c, { task_id: id });
    expect(textOf(s)).toContain("had already finished");
    expect(textOf(s)).toContain("[No output: the command never started.]");
  }, 30_000);

  it("a call that fails after the task finished leaves the finish to the poller, unreported", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "echo bye");
    await waitFor(
      async () => (await shell(c, `test -s .capybara/tasks/${t.id}.exit && echo y`)).includes("y"),
      10_000,
      "exit file",
    );
    vi.spyOn(store, "advanceOffset").mockRejectedValueOnce(new Error("database down"));
    await expect(output(c, { task_id: t.id })).rejects.toThrow("database down");
    expect((await store.get(t.id))?.status).toBe("running");
    expect(await finishedEvents(c.conversationId, t.id)).toHaveLength(0);
    expect(await k.app.get(BackgroundTaskPollJob).pollOnce()).toBe(1);
    const events = await finishedEvents(c.conversationId, t.id);
    expect(events.map((e) => e.payload)).toMatchObject([{ status: "completed", reported: false }]);
  }, 60_000);

  it("a sandbox gone under the read gives the status line and output unavailable", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "sleep 30");
    // the exec on the instance throws SandboxGoneError (the provider found it gone)
    vi.spyOn(sandbox, "ifRunning").mockImplementationOnce(async (_conv, _inst, fn) => {
      const p = {
        exec: async () => {
          throw new SandboxGoneError("instance gone");
        },
      } as unknown as Parameters<typeof fn>[0];
      return { kind: "ran", value: await fn(p, {} as Parameters<typeof fn>[1], signal()) };
    });
    const r = await output(c, { task_id: t.id, block: false });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toMatch(/^Status: running \(\d+s\)\n\[Output unavailable: /);
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

  it("a task another stop already claimed is stopping, not a failure", async () => {
    const c = await conversation();
    const t = await start(ctxOf(c), "sleep 30");
    expect(await store.claimStop(t.id)).toBe(true);
    const r = await stop(c, { task_id: t.id });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toContain(`Background task ${t.id} ("Run it") is stopping`);
    expect((await store.get(t.id))?.status).toBe("running");
  }, 60_000);

  it("a task still being launched is stopping, not a failure", async () => {
    const c = await conversation();
    const id = "bt_zzzzzz";
    await reservation(c, id);
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

describe("TaskList", () => {
  const list = (c: Conv, input: Record<string, unknown> = {}, over?: Partial<BuiltinCallContext>) =>
    tool("TaskList").run(input, ctxOf(c, over));

  /** A fresh task id (`bt_` and six base32 letters). */
  const taskId = (): string => {
    const abc = "abcdefghijklmnopqrstuvwxyz234567";
    let id = "bt_";
    for (let i = 0; i < 6; i++) id += abc[Math.floor(Math.random() * abc.length)];
    return id;
  };

  /** A task row written directly (no process): finished ones end `minutesAgo` minutes ago. */
  async function seedTask(
    c: Conv,
    opts: {
      conversationId?: string;
      description?: string;
      status?: "running" | "completed" | "failed" | "stopped" | "timed_out" | "lost";
      exitCode?: number | null;
      minutesAgo?: number;
    } = {},
  ): Promise<string> {
    const id = taskId();
    const status = opts.status ?? "completed";
    const ago = opts.minutesAgo ?? 1;
    const now = Date.now();
    const finished = status === "running" ? null : new Date(now - ago * 60_000);
    await sql`INSERT INTO capybara.background_tasks (id, org_id, conversation_id,
        sandbox_conversation_id, device_id, run_id, call_id, trigger_account_id, description,
        command, sid, output_path, status, exit_code, started_at, finished_at, deadline_at,
        sandbox_created_at)
      VALUES (${id}, ${c.orgId}, ${opts.conversationId ?? c.conversationId}, ${c.conversationId},
        ${c.deviceId}, 'run-1', ${`call-${id}`}, ${c.accountId}, ${opts.description ?? id},
        'true', '4242', ${`/workspace/.capybara/tasks/${id}.out`}, ${status},
        ${opts.exitCode ?? null}, ${new Date(now - (ago + 2) * 60_000)}, ${finished},
        ${new Date(Date.now() + 3_600_000)}, ${new Date()})`.execute(raw);
    return id;
  }

  /** A sub-agent of `parent` with its dispatch row and, unless null, a latest run in `status`. */
  async function seedChild(
    c: Conv,
    parent: string,
    title: string,
    status: "queued" | "running" | "waiting" | "completed" | "failed" | "aborted" | null,
    opts: { dispatch?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO capybara.conversations
        (id, org_id, agent_id, account_id, kind, parent_conversation_id, title)
      VALUES (${id}, ${c.orgId}, ${c.agentId}, ${c.accountId}, 'subagent', ${parent},
        ${title})`.execute(raw);
    const runId = randomUUID();
    if (opts.dispatch !== false) {
      await sql`INSERT INTO capybara.subagent_dispatches (parent_run_id, parent_call_id,
          parent_conversation_id, step, child_conversation_id, child_run_id, budget_run_id)
        VALUES (${randomUUID()}, 'c1', ${parent}, 1, ${id}, ${runId}, ${runId})`.execute(raw);
    }
    if (status !== null) {
      const done = ["completed", "failed", "aborted"].includes(status);
      await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
          trigger_account_id, trigger_seq, finished_at)
        VALUES (${runId}, ${id}, ${status}, 1, ${c.accountId}, 0,
          ${done ? new Date() : null})`.execute(raw);
    }
    return id;
  }

  it("is read-only and allowed by default", () => {
    const t = tool("TaskList");
    expect(t.spec.annotations).toEqual({ readOnlyHint: true });
    expect(t.defaultPolicy).toBe("allow");
    expect(t.spec.description).toContain(`(at most ${TASK_LIST_FINISHED_LIMIT})`);
    expect(t.spec.inputSchema.required).toBeUndefined();
  });

  it("an empty conversation says so", async () => {
    const c = await conversation();
    const r = await list(c);
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toBe("No background tasks or sub-agents in this conversation.");
    expect(textOf(await list(c, { status: "running" }))).toBe(
      "No background tasks or sub-agents are running in this conversation.",
    );
  }, 30_000);

  it("lists running tasks first, then finished ones with exit code and output path", async () => {
    const c = await conversation();
    const ctx = ctxOf(c);
    const running = await start(ctx, "sleep 30");
    const failed = await start(ctx, "echo out; exit 3");
    // TaskOutput observes the end: the failed task is finished
    await output(c, { task_id: failed.id, timeout: 10_000 });
    expect((await store.get(failed.id))?.status).toBe("failed");

    const text = textOf(await list(c));
    expect(text).toMatch(/^Background tasks: 1 running, 1 finished\.\n/);
    expect(text).toMatch(
      new RegExp(
        `- ${running.id} running for \\d+s: "Run it"\\n  Output: /workspace/\\.capybara/tasks/${running.id}\\.out`,
      ),
    );
    expect(text).toMatch(
      new RegExp(
        `- ${failed.id} failed, exit code 3, after \\d+s: "Run it"\\n  Output: /workspace/\\.capybara/tasks/${failed.id}\\.out`,
      ),
    );
    expect(text.indexOf(running.id)).toBeLessThan(text.indexOf(failed.id));
    expect(text).toContain("Use TaskOutput to check a task now");
    expect(text).not.toContain("Sub-agents");

    // only the running one
    const only = textOf(await list(c, { status: "running" }));
    expect(only).toContain(running.id);
    expect(only).not.toContain(failed.id);
    expect(only).toMatch(/^Background tasks: 1 running\./);
  }, 60_000);

  it("shows every finished status, lost with its reason", async () => {
    const c = await conversation();
    const ids = {
      completed: await seedTask(c, { status: "completed", exitCode: 0 }),
      stopped: await seedTask(c, { status: "stopped" }),
      timed_out: await seedTask(c, { status: "timed_out" }),
    };
    const lost = await seedTask(c, { status: "lost" });
    await sql`UPDATE capybara.background_tasks SET lost_reason = 'sandbox_suspended'
      WHERE id = ${lost}`.execute(raw);
    const text = textOf(await list(c));
    expect(text).toContain(`- ${ids.completed} completed, exit code 0, after 2m00s:`);
    expect(text).toContain(`- ${ids.stopped} stopped, after 2m00s:`);
    expect(text).toContain(`- ${ids.timed_out} timed_out, after 2m00s:`);
    expect(text).toContain(`- ${lost} lost (the sandbox was suspended), after 2m00s:`);
  }, 30_000);

  it("never lists another conversation's tasks, nor a sub-agent's", async () => {
    const parent = await conversation();
    const other = await conversation();
    const child = await seedChild(parent, parent.conversationId, "Child", "running");
    const mine = await seedTask(parent, { status: "running" });
    const childs = await seedTask(parent, { conversationId: child, status: "running" });
    const others = await seedTask(other, { status: "completed" });

    const fromParent = textOf(await list(parent));
    expect(fromParent).toContain(mine);
    expect(fromParent).not.toContain(childs);
    expect(fromParent).not.toContain(others);

    // the sub-agent lists its own task only
    const fromChild = textOf(
      await list(
        parent,
        {},
        { conversationId: child, sandboxConversationId: parent.conversationId },
      ),
    );
    expect(fromChild).toContain(childs);
    expect(fromChild).not.toContain(mine);
    expect(fromChild).not.toContain(child);

    const fromOther = textOf(await list(other));
    expect(fromOther).toContain(others);
    expect(fromOther).not.toContain(mine);
    expect(fromOther).not.toContain("Sub-agents");
  }, 30_000);

  it("lists the sub-agents this conversation dispatched, running first", async () => {
    const c = await conversation();
    const done = await seedChild(c, c.conversationId, "Search the docs", "completed");
    const running = await seedChild(c, c.conversationId, "Write the report", "running");
    const waiting = await seedChild(c, c.conversationId, "Ask for access", "waiting");
    const aborted = await seedChild(c, c.conversationId, "Old idea", "aborted");
    const failed = await seedChild(c, c.conversationId, "Broken", "failed");
    // a grandchild, and a child conversation never dispatched, are not listed
    const grandchild = await seedChild(c, running, "Nested", "running");
    const undispatched = await seedChild(c, c.conversationId, "Never", "running", {
      dispatch: false,
    });

    const text = textOf(await list(c));
    expect(text).toMatch(/^Background tasks: none\.\n\nSub-agents: 2 running, 3 finished\./);
    expect(text).toContain(`- ${running} running: "Write the report"`);
    expect(text).toContain(`- ${waiting} waiting: "Ask for access"`);
    expect(text).toContain(`- ${done} completed: "Search the docs"`);
    expect(text).toContain(`- ${aborted} stopped: "Old idea"`);
    expect(text).toContain(`- ${failed} failed: "Broken"`);
    expect(text.indexOf(waiting)).toBeLessThan(text.indexOf(done));
    expect(text).not.toContain(grandchild);
    expect(text).not.toContain(undispatched);
    expect(text).toContain("use SendMessage to give it more instructions");

    const only = textOf(await list(c, { status: "running" }));
    expect(only).toContain(running);
    expect(only).not.toContain(done);
    expect(only).toMatch(/Sub-agents: 2 running\./);
  }, 30_000);

  it(`lists at most ${TASK_LIST_FINISHED_LIMIT} finished tasks, the most recent first`, async () => {
    const c = await conversation();
    const ids: string[] = [];
    // ids[0] finished most recently
    for (let i = 0; i < TASK_LIST_FINISHED_LIMIT + 3; i++) {
      ids.push(await seedTask(c, { status: "completed", exitCode: 0, minutesAgo: i + 1 }));
    }
    const running = await seedTask(c, { status: "running" });
    const text = textOf(await list(c));
    expect(text).toMatch(
      new RegExp(`^Background tasks: 1 running, ${TASK_LIST_FINISHED_LIMIT + 3} finished\\.`),
    );
    for (const id of ids.slice(0, TASK_LIST_FINISHED_LIMIT)) expect(text).toContain(id);
    for (const id of ids.slice(TASK_LIST_FINISHED_LIMIT)) expect(text).not.toContain(id);
    expect(text).toContain("(3 older finished tasks are not listed.)");
    expect(text.indexOf(running)).toBeLessThan(text.indexOf(ids[0] as string));
    expect(text.indexOf(ids[0] as string)).toBeLessThan(text.indexOf(ids[1] as string));
  }, 30_000);
});
