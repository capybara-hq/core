import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { launchScript, newTaskId, taskOutputPath } from "../../src/background/launch.js";
import {
  BACKGROUND_PRUNE_JOB,
  BackgroundTaskPollJob,
  launchAbandonedAfterMs,
} from "../../src/background/poll.job.js";
import { BackgroundTaskStopper } from "../../src/background/stop.js";
import {
  type BackgroundTaskRow,
  BackgroundTaskStore,
  STOP_CLAIM_TTL_MS,
} from "../../src/background/store.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { Waits } from "../../src/runtime/waits.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { sandboxBaseTimeoutMs } from "../../src/tools/builtins/sandbox/common.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { removeFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
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
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { finishedDeliveries } from "../helpers/subagents.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * Polling, finishing and stopping background tasks (spec 2026-11-05-background-bash-design §4.3)
 * on one kernel with the fake sandbox. Tasks are started with the launch script directly (as the
 * `Bash` launch does), except in the sub-agent test, where a scripted child launches one. The
 * scheduled poll runs hourly here; the tests call its body (`pollOnce`).
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";

const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "bg-child", assistantTurns: 0 },
    reply: {
      toolCalls: [
        {
          name: "Bash",
          input: { command: "sleep 301", description: "Sleep", run_in_background: true },
        },
      ],
    },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "bg-child", assistantTurns: 1 },
    reply: { text: "launched" },
  },
  {
    when: { lastUserIncludes: "SCENARIO bg", assistantTurns: 0 },
    reply: {
      toolCalls: [
        { name: "Agent", input: { description: "Start a task", prompt: "bg-child: start it" } },
      ],
    },
  },
  { when: { lastToolResultIncludes: "in the background" }, reply: { text: "parent done" } },
  // a child that starts a task, then waits for the approval of a Write
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "bg-wait", assistantTurns: 0 },
    reply: {
      toolCalls: [
        {
          name: "Bash",
          input: { command: "sleep 313", description: "Sleep", run_in_background: true },
        },
      ],
    },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "bg-wait", assistantTurns: 1 },
    reply: {
      toolCalls: [{ name: "Write", input: { file_path: "/workspace/w.txt", content: "w" } }],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO wait", assistantTurns: 0 },
    reply: {
      toolCalls: [
        { name: "Agent", input: { description: "Start and wait", prompt: "bg-wait: go" } },
      ],
    },
  },
];

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let sandbox: SandboxService;
let store: BackgroundTaskStore;
let job: BackgroundTaskPollJob;
let stopper: BackgroundTaskStopper;
/** The conversations whose sandboxes a test used (destroyed after it: their tasks die with them). */
let used: string[] = [];

const signal = () => AbortSignal.timeout(30_000);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-bg-poll-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        sandbox: { background: { pollSeconds: 3600 } },
      },
    ),
  );
  sandbox = k.app.get(SandboxService);
  store = k.app.get(BackgroundTaskStore);
  job = k.app.get(BackgroundTaskPollJob);
  stopper = k.app.get(BackgroundTaskStopper);
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of used) await sandbox.destroyFor(c).catch(() => {});
  used = [];
  // a test's tasks never reach the next one's polls
  await sql`UPDATE capybara.background_tasks SET status = 'lost', finished_at = now()
    WHERE status = 'running'`.execute(raw);
});

/** A new conversation (seeded in the database). */
async function conversation(): Promise<{
  orgId: string;
  conversationId: string;
  accountId: string;
}> {
  const s = await seedConversation(raw);
  used.push(s.conversationId);
  return s;
}

/** Runs `command` in the conversation's sandbox (creating or resuming it). */
async function inSandbox(
  c: { orgId: string; conversationId: string },
  command: string,
): Promise<{ exitCode: number | null; stdout: string }> {
  return sandbox.withSandbox(
    c,
    (h, p, _info, sig) =>
      p.exec(h, {
        command,
        cwd: "/workspace",
        timeoutMs: 20_000,
        maxOutputBytes: 64_000,
        signal: sig,
      }),
    signal(),
  );
}

/** Starts `command` as a background task of the conversation, as the `Bash` launch does. */
async function launch(
  c: { orgId: string; conversationId: string; accountId: string },
  command: string,
  seconds = 300,
  runId = "run-x",
): Promise<BackgroundTaskRow> {
  const id = newTaskId();
  // before the launch exec, as the Bash launch does: the sandbox's own timeout starts after it
  const startedAt = new Date();
  const r = await inSandbox(c, launchScript(id, command, seconds));
  expect(r.exitCode).toBe(0);
  const sid = r.stdout.trim();
  // the fake's setsid shim may still be starting when the launch returns (on Linux the session
  // exists by then): wait for its session record, so a suspension right after kills it
  const { handle } = await db
    .selectFrom("sandboxes")
    .select("handle")
    .where("conversation_id", "=", c.conversationId)
    .executeTakeFirstOrThrow();
  const record = join(root, "instances", (handle as { id: string }).id, "sessions", sid);
  await waitFor(async () => existsSync(record), 10_000, "session record");
  const instance = await sandbox.currentInstance(c.conversationId);
  await store.insert({
    id,
    orgId: c.orgId,
    conversationId: c.conversationId,
    sandboxConversationId: c.conversationId,
    runId,
    callId: "call-x",
    triggerAccountId: c.accountId,
    description: `Run ${command}`,
    command,
    sid,
    outputPath: taskOutputPath(id),
    startedAt,
    deadlineAt: new Date(startedAt.getTime() + seconds * 1000),
    sandboxCreatedAt: instance?.createdAt as Date,
  });
  return (await store.get(id)) as BackgroundTaskRow;
}

/** Whether the task's session still has a process (pgrep -s), asked inside the sandbox. */
async function alive(
  c: { orgId: string; conversationId: string },
  t: BackgroundTaskRow,
): Promise<boolean> {
  return (await inSandbox(c, `pgrep -s ${t.sid} >/dev/null`)).exitCode === 0;
}

type Finished = Extract<ConversationEvent, { type: "background_task_finished" }>;
const finishedEvents = async (conversationId: string, taskId: string): Promise<Finished[]> =>
  (await eventsOf(db, conversationId)).filter(
    (e): e is Finished => e.type === "background_task_finished" && e.payload.taskId === taskId,
  );

/** Polls until `task` left `running` (or `ms` passed); returns its row. */
async function pollUntilFinished(task: BackgroundTaskRow, ms = 15_000): Promise<BackgroundTaskRow> {
  return waitFor(
    async () => {
      await job.pollOnce();
      const t = await store.get(task.id);
      return t?.status !== "running" && t;
    },
    ms,
    `task ${task.id} finished`,
    200,
  );
}

describe("polling", () => {
  it("a task that exits 3 ends failed with its exit code and last lines, in one poll, with one event", async () => {
    const c = await conversation();
    const t = await launch(c, "echo hi; exit 3");
    // the exit file is written: the next poll finishes it
    await waitFor(
      async () => (await inSandbox(c, `test -s .capybara/tasks/${t.id}.exit`)).exitCode === 0,
      10_000,
      "exit file",
    );
    expect(await job.pollOnce()).toBe(1);
    const row = await store.get(t.id);
    expect(row).toMatchObject({ status: "failed", exitCode: 3, lostReason: null });
    expect(row?.finishedAt).toBeInstanceOf(Date);
    const events = await finishedEvents(c.conversationId, t.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      taskId: t.id,
      description: "Run echo hi; exit 3",
      status: "failed",
      exitCode: 3,
      lastLines: "hi\n",
      outputPath: `/workspace/.capybara/tasks/${t.id}.out`,
      reported: false,
    });
    expect(events[0]?.payload.lostReason).toBeUndefined();
    // a later poll finds nothing more
    expect(await job.pollOnce()).toBe(0);
    expect(await finishedEvents(c.conversationId, t.id)).toHaveLength(1);
  }, 60_000);

  it("a task that exits 0 ends completed", async () => {
    const c = await conversation();
    const t = await launch(c, "printf 'a\\nb\\n'");
    const row = await pollUntilFinished(t);
    expect(row).toMatchObject({ status: "completed", exitCode: 0 });
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload.lastLines).toBe("a\nb\n");
  }, 60_000);

  it("keeps a running task running, and keeps only the last 4 000 characters of the output", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 302");
    expect(await job.pollOnce()).toBe(0);
    expect((await store.get(t.id))?.status).toBe("running");
    const long = await launch(
      c,
      "for i in $(seq 1 20); do printf 'x%.0s' $(seq 1 400); echo; done",
    );
    const row = await pollUntilFinished(long);
    expect(row.status).toBe("completed");
    const last = (await finishedEvents(c.conversationId, long.id))[0]?.payload.lastLines ?? "";
    expect(last.length).toBe(4000);
    expect(last.endsWith("x\n")).toBe(true);
  }, 60_000);

  it("a task whose command exited but left processes running ends completed, its session empty (M2)", async () => {
    const c = await conversation();
    const t = await launch(c, "sh -c 'sleep 300 & echo started'");
    await waitFor(
      async () => (await inSandbox(c, `test -s .capybara/tasks/${t.id}.exit`)).exitCode === 0,
      10_000,
      "exit file",
    );
    // the command exited, its `sleep 300` lives on in the task's session
    expect(await alive(c, t)).toBe(true);
    const row = await pollUntilFinished(t);
    expect(row).toMatchObject({ status: "completed", exitCode: 0 });
    expect(await alive(c, t)).toBe(false);
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload.lastLines).toBe("started\n");
  }, 60_000);

  it("a task killed at its timeout ends timed_out", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 60", 1);
    const row = await pollUntilFinished(t);
    expect(row).toMatchObject({ status: "timed_out", exitCode: 137 });
  }, 60_000);

  it("a task whose session was killed from outside ends lost (process_gone)", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 303");
    expect((await inSandbox(c, `pkill -KILL -s ${t.sid}`)).exitCode).toBe(0);
    const row = await pollUntilFinished(t);
    expect(row).toMatchObject({
      status: "lost",
      lostReason: "process_gone",
      exitCode: null,
      killPending: false,
    });
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload).toMatchObject({
      status: "lost",
      lostReason: "process_gone",
    });
  }, 60_000);

  it("a suspended sandbox's task ends lost (sandbox_suspended) with kill_pending; a resume kills nothing alive", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 304");
    expect(await sandbox.suspendIdle(new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThan(0);
    expect(await job.pollOnce()).toBe(1);
    expect(await store.get(t.id)).toMatchObject({
      status: "lost",
      lostReason: "sandbox_suspended",
      killPending: true,
    });
    // the poll neither resumed the sandbox nor ran anything in it
    const st = await db
      .selectFrom("sandboxes")
      .select("status")
      .where("conversation_id", "=", c.conversationId)
      .executeTakeFirstOrThrow();
    expect(st.status).toBe("suspended");
    // the next use resumes it and kills the pending task's session: nothing of it is alive
    expect(await alive(c, t)).toBe(false);
    expect((await store.get(t.id))?.killPending).toBe(false);
  }, 60_000);

  it("a task of a rebuilt sandbox ends lost (sandbox_recreated)", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 305");
    const row = await db
      .selectFrom("sandboxes")
      .select("handle")
      .where("conversation_id", "=", c.conversationId)
      .executeTakeFirstOrThrow();
    await inSandbox(c, `pkill -KILL -s ${t.sid}`);
    await removeFakeSandbox(root, (row.handle as { id: string }).id);
    // the next use finds the instance gone and rebuilds it
    expect((await inSandbox(c, "true")).exitCode).toBe(0);
    expect(await job.pollOnce()).toBe(1);
    expect(await store.get(t.id)).toMatchObject({
      status: "lost",
      lostReason: "sandbox_recreated",
      killPending: false,
    });
  }, 60_000);

  it("a task whose sandbox is gone ends lost (sandbox_gone)", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 306");
    await sandbox.destroyFor(c.conversationId);
    expect(await job.pollOnce()).toBe(1);
    expect(await store.get(t.id)).toMatchObject({ status: "lost", lostReason: "sandbox_gone" });
  }, 60_000);

  it("keeps the sandbox alive: a poll moves last_used_at forward, so idle suspension skips it", async () => {
    const c = await conversation();
    await launch(c, "sleep 307");
    const idleMs =
      k.app.get(KernelConfigService).get().sandbox.limits.suspendAfterIdleMinutes * 60_000;
    const age = async (ago: number) =>
      db
        .updateTable("sandboxes")
        .set({ last_used_at: new Date(Date.now() - ago) })
        .where("conversation_id", "=", c.conversationId)
        .execute();
    const status = async () =>
      await db
        .selectFrom("sandboxes")
        .select(["status", "last_used_at"])
        .where("conversation_id", "=", c.conversationId)
        .executeTakeFirstOrThrow();
    await age(2 * idleMs);
    const before = Date.now();
    await job.pollOnce();
    expect((await status()).last_used_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // a minute before the idle limit would pass again: not suspended
    const later = new Date(Date.now() + idleMs - 60_000);
    await sandbox.suspendIdle(later);
    expect((await status()).status).toBe("running");
    // without the poll it would have been
    await age(2 * idleMs);
    await sandbox.suspendIdle(new Date());
    expect((await status()).status).toBe("suspended");
  }, 60_000);

  it("skips a reservation that has not started (no sid)", async () => {
    const c = await conversation();
    const id = newTaskId();
    expect(
      await store.reserve(
        {
          id,
          orgId: c.orgId,
          conversationId: c.conversationId,
          sandboxConversationId: c.conversationId,
          runId: "run-x",
          callId: "call-x",
          triggerAccountId: c.accountId,
          description: "d",
          command: "true",
          outputPath: taskOutputPath(id),
          startedAt: new Date(),
          deadlineAt: new Date(Date.now() + 60_000),
        },
        4,
      ),
    ).toBe(true);
    expect(await job.pollOnce()).toBe(0);
    expect((await store.get(id))?.status).toBe("running");
    await store.failLaunch(id, "test");
  }, 60_000);

  it("fails a reservation abandoned by its launch after 2 minutes, never a younger or live-claimed one", async () => {
    const c = await conversation();
    // only an abandoned reservation of its own: its frame comes from the abandoned path alone
    const lone = await conversation();
    const reserve = async (startedAt: Date, conv = c) => {
      const id = newTaskId();
      await store.reserve(
        {
          id,
          orgId: conv.orgId,
          conversationId: conv.conversationId,
          sandboxConversationId: conv.conversationId,
          runId: "run-x",
          callId: "call-x",
          triggerAccountId: conv.accountId,
          description: "d",
          command: "true",
          outputPath: taskOutputPath(id),
          startedAt,
          deadlineAt: new Date(startedAt.getTime() + 3_600_000),
        },
        10,
      );
      return id;
    };
    const limit = launchAbandonedAfterMs(k.app.get(KernelConfigService).get());
    // derived from config: twice the launch call's pipeline limit, so well over the lease wait
    const cfg = k.app.get(KernelConfigService).get();
    expect(limit).toBe(2 * (30_000 + sandboxBaseTimeoutMs(cfg)));
    expect(limit).toBeGreaterThan((cfg.sandbox.lockWaitSeconds + 30) * 1000 * 2);
    const old = new Date(Date.now() - limit - 1000);
    const abandoned = await reserve(old);
    const loneAbandoned = await reserve(old, lone);
    const young = await reserve(new Date(Date.now() - limit + 30_000));
    const claimed = await reserve(old);
    expect(await store.claimStop(claimed)).toBe(true);
    // a stop claimed it, then its launch died: the claim expires and no longer holds the slot
    const staleClaim = await reserve(old);
    expect(await store.claimStop(staleClaim)).toBe(true);
    await sql`UPDATE capybara.background_tasks
      SET stopping_at = now() - ${STOP_CLAIM_TTL_MS + 1000}::integer * interval '1 millisecond'
      WHERE id = ${staleClaim}`.execute(raw);
    // a launch that completed at that moment (its sid set) is no longer a reservation
    const completing = await reserve(old);
    expect(
      await store.markStarted(completing, { sid: "424242", sandboxCreatedAt: new Date() }),
    ).toBe("started");

    const publish = vi.spyOn(k.app.get(EventLog), "publishChanged");
    await job.pollOnce();
    // a client that listed the reservations as running refreshes (M4)
    expect(publish).toHaveBeenCalledWith(lone.conversationId, "background");
    expect(await store.get(loneAbandoned)).toMatchObject({ status: "failed" });
    expect(await store.get(abandoned)).toMatchObject({
      status: "failed",
      lostReason: "launch_abandoned",
      sid: null,
    });
    expect((await store.get(abandoned))?.finishedAt).not.toBeNull();
    // no event: the command never started and the model never saw the task's id
    expect(await finishedEvents(c.conversationId, abandoned)).toEqual([]);
    expect(await store.get(staleClaim)).toMatchObject({
      status: "failed",
      lostReason: "launch_abandoned",
      stoppingAt: null,
    });
    expect(await finishedEvents(c.conversationId, staleClaim)).toEqual([]);
    expect((await store.get(young))?.status).toBe("running");
    expect((await store.get(claimed))?.status).toBe("running");
    // the completed launch keeps its sid (the poll then checks it like any started task)
    expect((await store.get(completing))?.sid).toBe("424242");
    expect((await store.get(completing))?.lostReason).not.toBe("launch_abandoned");
    // a failed launch clears a stop's claim with its status
    for (const id of [young, claimed]) await store.failLaunch(id, "test");
    expect(await store.get(claimed)).toMatchObject({ status: "failed", stoppingAt: null });
  }, 60_000);
});

describe("finishing", () => {
  it("writes the status and the event in one transaction: a failed append leaves the task running", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 308");
    const finisher = k.app.get(BackgroundTaskFinisher);
    vi.spyOn(k.app.get(EventLog), "appendIn").mockRejectedValueOnce(new Error("append failed"));
    await expect(
      finisher.finish(t, { status: "completed", exitCode: 0 }, "x", false),
    ).rejects.toThrow("append failed");
    expect((await store.get(t.id))?.status).toBe("running");
    expect(await finishedEvents(c.conversationId, t.id)).toHaveLength(0);
    // the next finish goes through, once
    expect(await finisher.finish(t, { status: "completed", exitCode: 0 }, "x", true)).toBe(true);
    expect(await finisher.finish(t, { status: "failed", exitCode: 1 }, "y", false)).toBe(false);
    const events = await finishedEvents(c.conversationId, t.id);
    expect(events.map((e) => [e.payload.status, e.payload.reported])).toEqual([
      ["completed", true],
    ]);
  }, 60_000);
});

describe("stopping", () => {
  it("stops a running task within 6 s as stopped, its session empty", async () => {
    const c = await conversation();
    const t = await launch(c, "echo started; sleep 309");
    await waitFor(
      async () =>
        (await inSandbox(c, `grep -q started .capybara/tasks/${t.id}.out`)).exitCode === 0,
      10_000,
      "output",
    );
    const t0 = Date.now();
    const row = await stopper.stop(t, "person");
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(row).toMatchObject({ status: "stopped", exitCode: null });
    expect(await alive(c, t)).toBe(false);
    const events = await finishedEvents(c.conversationId, t.id);
    expect(events.map((e) => e.payload)).toMatchObject([
      { status: "stopped", lastLines: "started\n", reported: false },
    ]);
    // stopping it again changes nothing
    expect(await stopper.stop(t, "tool")).toMatchObject({ status: "stopped" });
    expect(await finishedEvents(c.conversationId, t.id)).toHaveLength(1);
  }, 60_000);

  it("a poll while a stop is between SIGTERM and its finish leaves the task to the stop", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 314");
    const finisher = k.app.get(BackgroundTaskFinisher);
    const original = finisher.finish.bind(finisher);
    let polled: number | undefined;
    vi.spyOn(finisher, "finish").mockImplementation(async (...args) => {
      // the stop's finish: the session is gone now; poll before it is written
      if (polled === undefined) polled = await job.pollOnce();
      return original(...args);
    });
    const row = await stopper.stop(t, "tool");
    expect(polled).toBe(0);
    expect(row).toMatchObject({ status: "stopped", stoppingAt: null });
    const events = await finishedEvents(c.conversationId, t.id);
    expect(events.map((e) => [e.payload.status, e.payload.reported])).toEqual([["stopped", true]]);
  }, 60_000);

  it("a poll that read a task before a stop claimed it does not finish it", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 316");
    expect(await store.claimStop(t.id)).toBe(true);
    // a second stop finds it claimed
    expect(await store.claimStop(t.id)).toBe(false);
    const finisher = k.app.get(BackgroundTaskFinisher);
    expect(
      await finisher.finish(t, { status: "lost", lostReason: "process_gone" }, "", false, {
        unclaimed: true,
      }),
    ).toBe(false);
    expect(await job.pollOnce()).toBe(0);
    expect((await store.get(t.id))?.status).toBe("running");
    await store.releaseStop(t.id);
  }, 60_000);

  it("a stop that fails while the sandbox runs keeps the task running and gives up its claim", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 317");
    vi.spyOn(sandbox, "ifRunning").mockRejectedValueOnce(new Error("sandbox busy"));
    await expect(stopper.stop(t, "tool")).rejects.toThrow("sandbox busy");
    expect(await store.get(t.id)).toMatchObject({ status: "running", stoppingAt: null });
    expect(await finishedEvents(c.conversationId, t.id)).toHaveLength(0);
    expect(await alive(c, t)).toBe(true);
  }, 60_000);

  it("a stop of a reservation only claims it (its launch kills what it starts)", async () => {
    const c = await conversation();
    const id = newTaskId();
    await store.reserve(
      {
        id,
        orgId: c.orgId,
        conversationId: c.conversationId,
        sandboxConversationId: c.conversationId,
        runId: "run-x",
        callId: "call-x",
        triggerAccountId: c.accountId,
        description: "d",
        command: "true",
        outputPath: taskOutputPath(id),
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
      },
      4,
    );
    const row = await stopper.stop((await store.get(id)) as BackgroundTaskRow, "person");
    expect(row.status).toBe("running");
    expect(row.stoppingAt).toBeInstanceOf(Date);
    expect(await store.markStarted(id, { sid: "12345", sandboxCreatedAt: new Date() })).toBe(
      "stopping",
    );
    await store.finishStoppedLaunch(id);
    expect(await store.get(id)).toMatchObject({ status: "stopped", stoppingAt: null });
  }, 60_000);

  it("a stop of a task that already exited finishes it as its exit says", async () => {
    const c = await conversation();
    const t = await launch(c, "echo done");
    await waitFor(
      async () => (await inSandbox(c, `test -s .capybara/tasks/${t.id}.exit`)).exitCode === 0,
      10_000,
      "exit file",
    );
    expect(await stopper.stop(t, "tool")).toMatchObject({ status: "completed", exitCode: 0 });
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload).toMatchObject({
      reported: true,
      lastLines: "done\n",
    });
  }, 60_000);

  it("a stop of a task that exited but left processes running kills them (M2)", async () => {
    const c = await conversation();
    const t = await launch(c, "sh -c 'sleep 300 & echo started'");
    await waitFor(
      async () => (await inSandbox(c, `test -s .capybara/tasks/${t.id}.exit`)).exitCode === 0,
      10_000,
      "exit file",
    );
    expect(await alive(c, t)).toBe(true);
    expect(await stopper.stop(t, "tool")).toMatchObject({ status: "completed", exitCode: 0 });
    expect(await alive(c, t)).toBe(false);
  }, 60_000);

  it("a sub-agent run's end stops only the tasks that run started (M5)", async () => {
    const c = await conversation();
    await sql`UPDATE capybara.conversations SET kind = 'subagent'
      WHERE id = ${c.conversationId}`.execute(raw);
    const older = await launch(c, "sleep 319", 300, "run-old");
    const followUp = await launch(c, "sleep 320", 300, "run-new");
    // the older run's end, handled after the follow-up run started its own task
    await stopper.stopSubagentTasks(c.conversationId, "run-old");
    expect(await store.get(older.id)).toMatchObject({ status: "stopped" });
    expect(await alive(c, older)).toBe(false);
    expect(await store.get(followUp.id)).toMatchObject({ status: "running" });
    expect(await alive(c, followUp)).toBe(true);
    await stopper.stopSubagentTasks(c.conversationId, "run-new");
    expect(await store.get(followUp.id)).toMatchObject({ status: "stopped" });
  }, 60_000);

  it("a stop while the sandbox is suspended ends the task lost with kill_pending", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 310");
    expect(await sandbox.suspendIdle(new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThan(0);
    expect(await stopper.stop(t, "person")).toMatchObject({
      status: "lost",
      lostReason: "sandbox_suspended",
      killPending: true,
    });
  }, 60_000);

  describe("through the run worker and the conversation delete", () => {
    let owner: Req;
    let orgId: string;
    let agentId: string;

    beforeAll(async () => {
      await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
      owner = await session(k, "owner");
      orgId = await createOrg(owner);
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: {
          definition: {
            name: "Lead",
            instructions: "Lead the work.",
            model: { provider: "model-script", model: "script-1" },
            tools: ["Agent", "Bash", "Write"].map((name) => ({ kind: "builtin", name })),
            toolPolicies: { Write: "ask" },
          },
          visibility: "org",
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      agentId = (res.json() as { agent: { id: string } }).agent.id;
    });

    it("a background sub-agent's run end leaves its running task running (its finish wakes the child)", async () => {
      const conv = await createConv(owner, orgId, agentId);
      used.push(conv);
      await postMessage(owner, orgId, conv, "SCENARIO bg");
      await waitForTerminal(db, conv, 1, 30_000);
      // the child runs in the background (agent map spec §4.1): wait for its finish
      await finishedDeliveries(db, conv, 1);
      const child = await db
        .selectFrom("conversations")
        .select("id")
        .where("parent_conversation_id", "=", conv)
        .executeTakeFirstOrThrow();
      const [task] = await store.listFor([child.id]);
      expect(task).toMatchObject({ conversationId: child.id, sandboxConversationId: conv });
      // the run's end handling, done again and awaited (idempotent: the delivery exists, so it
      // writes nothing): any task stop it makes has happened when it returns
      const childRun = await db
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", child.id)
        .executeTakeFirstOrThrow();
      expect(await k.app.get(Waits).childFinished(childRun.id)).toBe(false);
      const row = await store.get(task?.id as string);
      expect(row).toMatchObject({ status: "running" });
      expect(await finishedEvents(child.id, task?.id as string)).toEqual([]);
      expect(await alive({ orgId, conversationId: conv }, row as NonNullable<typeof row>)).toBe(
        true,
      );
    }, 60_000);

    it("stopping a child waiting for approval stops the child's task", async () => {
      const conv = await createConv(owner, orgId, agentId);
      used.push(conv);
      await postMessage(owner, orgId, conv, "SCENARIO wait");
      const child = await waitFor(
        async () =>
          db
            .selectFrom("conversations")
            .select("id")
            .where("parent_conversation_id", "=", conv)
            .executeTakeFirst(),
        20_000,
        "child conversation",
      );
      await waitFor(
        async () =>
          (
            await db
              .selectFrom("runs")
              .select("status")
              .where("conversation_id", "=", child.id)
              .executeTakeFirst()
          )?.status === "waiting",
        20_000,
        "child waiting for approval",
      );
      const [task] = await store.listFor([child.id]);
      expect(task?.status).toBe("running");
      // the parent's run ended after the dispatch; the child is stopped on its own
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${child.id}/abort`,
      });
      expect(res.statusCode, res.body).toBe(202);
      const row = await waitFor(
        async () => {
          const r = await store.get(task?.id as string);
          return r?.status !== "running" && r;
        },
        15_000,
        "waiting child's task stopped",
      );
      expect(row).toMatchObject({ status: "stopped" });
      expect(await alive({ orgId, conversationId: conv }, row)).toBe(false);
    }, 60_000);

    it("deleting a conversation stops the running tasks in its sandbox first", async () => {
      const conv = await createConv(owner, orgId, agentId);
      used.push(conv);
      const owned = await db
        .selectFrom("conversations")
        .select("account_id")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow();
      const t = await launch(
        { orgId, conversationId: conv, accountId: owned.account_id },
        "sleep 311",
      );
      const res = await owner({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
      });
      expect(res.statusCode, res.body).toBe(204);
      expect(await store.get(t.id)).toMatchObject({ status: "stopped" });
      expect(await alive({ orgId, conversationId: conv }, t)).toBe(false);
    }, 60_000);

    it("deleting an idle conversation with a running task wakes no run (I1)", async () => {
      const conv = await createConv(owner, orgId, agentId);
      used.push(conv);
      const owned = await db
        .selectFrom("conversations")
        .select("account_id")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow();
      const t = await launch(
        { orgId, conversationId: conv, accountId: owned.account_id },
        "sleep 318",
      );
      const res = await owner({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
      });
      expect(res.statusCode, res.body).toBe(204);
      expect(await store.get(t.id)).toMatchObject({ status: "stopped" });
      expect(await alive({ orgId, conversationId: conv }, t)).toBe(false);
      // the wake runs after the stop's commit; give a late one time to show up
      await new Promise((r) => setTimeout(r, 1000));
      const runs = await db
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", conv)
        .execute();
      expect(runs).toEqual([]);
      // the stop's finish is marked as the deletion's, so nothing that reads it later wakes a run
      expect((await finishedEvents(conv, t.id)).map((e) => e.payload)).toMatchObject([
        { status: "stopped", reported: false, stoppedBy: "deletion" },
      ]);
    }, 60_000);
  });
});

describe("pruning", () => {
  it("the daily prune deletes finished tasks older than tools.outputRetentionDays", async () => {
    const c = await conversation();
    const old = await launch(c, "true");
    const recent = await launch(c, "true");
    const running = await launch(c, "sleep 312");
    await pollUntilFinished(old);
    await pollUntilFinished(recent);
    const days = k.app.get(KernelConfigService).get().tools.outputRetentionDays;
    await sql`UPDATE capybara.background_tasks SET finished_at = now() - make_interval(days => ${days + 1})
      WHERE id = ${old.id}`.execute(raw);
    const prune = vi.spyOn(store, "pruneFinished");
    await job.prune();
    expect(prune).toHaveBeenCalledTimes(1);
    const before = prune.mock.calls[0]?.[0] as Date;
    expect(Math.abs(before.getTime() - (Date.now() - days * 86_400_000))).toBeLessThan(60_000);
    expect(await store.get(old.id)).toBeUndefined();
    expect(await store.get(recent.id)).toBeDefined();
    expect(await store.get(running.id)).toBeDefined();
    expect(BACKGROUND_PRUNE_JOB).toBe("background-task-prune");
  }, 60_000);
});
