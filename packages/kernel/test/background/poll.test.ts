import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { newTaskId, taskOutputPath } from "../../src/background/launch.js";
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
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account } from "../../src/identity/accounts.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { Waits } from "../../src/runtime/waits.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import { sandboxBaseTimeoutMs } from "../../src/tools/builtins/sandbox/common.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { removeFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import {
  fakeExecutionAlive,
  fakeExecutionExited,
  killFakeExecution,
  launchManaged,
  type ManagedLauncher,
} from "../helpers/background-fake.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { managedTaskFixture } from "../helpers/managed-background.js";
import { startClaimedRun } from "../helpers/managed-calls.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
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
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";
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
/** The devices a test used (destroyed after it: their tasks die with them). */
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
});

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
  // a test's tasks never reach the next one's polls
  await sql`UPDATE capybara.background_tasks SET status = 'lost', finished_at = now()
    WHERE status = 'running'`.execute(raw);
});

/** A conversation with the actor and the claimed run its managed launches belong to. */
type Conv = ManagedLauncher & { deviceId: string };

/**
 * A new conversation (seeded in the database) bound to a device of its own, its actor an org
 * member (a managed call's actor must be one), with a running claimed run.
 */
async function conversation(): Promise<Conv> {
  const s = await seedConversation(raw);
  const deviceId = await seedDevice(raw, s.orgId, s.accountId);
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", s.conversationId)
    .execute();
  await db
    .insertInto("memberships")
    .values({ org_id: s.orgId, account_id: s.accountId, role: "owner" })
    .execute();
  used.push(deviceId);
  return { ...s, deviceId, ...(await startClaimedRun(k, raw, s.conversationId, s.accountId)) };
}

/** The device a conversation is bound to. */
async function envOf(conversationId: string): Promise<string> {
  const r = await db
    .selectFrom("conversations")
    .select("device_id")
    .where("id", "=", conversationId)
    .executeTakeFirstOrThrow();
  if (r.device_id === null) throw new Error(`conversation ${conversationId} is not bound`);
  return r.device_id;
}

/** Runs `command` in the conversation's device (creating or resuming its instance). */
async function inSandbox(
  c: { orgId: string; conversationId: string },
  command: string,
): Promise<{ exitCode: number | null; stdout: string }> {
  return sandbox.withSandbox(
    {
      orgId: c.orgId,
      deviceId: await envOf(c.conversationId),
      holderConversationId: c.conversationId,
      actor: { accountId: "test", conversationId: c.conversationId },
    },
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

/** Starts `command` as a managed background task of the conversation through the `Bash` path. */
const launch = (c: ManagedLauncher, command: string, seconds = 300): Promise<BackgroundTaskRow> =>
  launchManaged(k, raw, c, command, seconds);

/** Whether a process of the task's group still runs (the fake's record of its execution). */
const alive = (_c: unknown, t: BackgroundTaskRow): Promise<boolean> => fakeExecutionAlive(root, t);

/** Waits until the fake recorded the task's command exit. */
const exited = (t: BackgroundTaskRow) =>
  waitFor(async () => fakeExecutionExited(root, t), 10_000, "the task's exit");

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
    // the exit is recorded: the next poll finishes it
    await exited(t);
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
  });

  it("a task that exits 0 ends completed", async () => {
    const c = await conversation();
    const t = await launch(c, "printf 'a\\nb\\n'");
    const row = await pollUntilFinished(t);
    expect(row).toMatchObject({ status: "completed", exitCode: 0 });
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload.lastLines).toBe("a\nb\n");
  });

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
  });

  it("a task whose command exited but left processes running ends completed, nothing of it left running (M2)", async () => {
    const c = await conversation();
    const t = await launch(c, "sh -c 'sleep 300 & echo started'");
    await exited(t);
    // the provider ends what the command left running once it exits, as a device's exec does
    await waitFor(async () => !(await alive(c, t)), 10_000, "the task's group ended");
    const row = await pollUntilFinished(t);
    expect(row).toMatchObject({ status: "completed", exitCode: 0 });
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload.lastLines).toBe("started\n");
  });

  it("a task killed at its timeout ends timed_out", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 60", 1);
    const row = await pollUntilFinished(t);
    // the exit code is the provider's (the fake's timeout gives 124)
    expect(row).toMatchObject({ status: "timed_out", exitCode: 124 });
  });

  it("a task whose process group was killed from outside ends lost (supervision_lost)", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 303");
    // its whole process group killed from outside: the provider lost the execution
    await killFakeExecution(root, t);
    const row = await pollUntilFinished(t);
    expect(row).toMatchObject({
      status: "lost",
      lostReason: "supervision_lost",
      exitCode: null,
    });
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload).toMatchObject({
      status: "lost",
      lostReason: "supervision_lost",
    });
  });

  it("a suspended sandbox's task ends lost (sandbox_suspended); nothing of it is left alive", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 304");
    expect(await sandbox.suspendIdle(new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThan(0);
    expect(await job.pollOnce()).toBe(1);
    // the suspension killed the exact execution: no kill is owed
    expect(await store.get(t.id)).toMatchObject({
      status: "lost",
      lostReason: "sandbox_suspended",
      killPending: false,
    });
    // the poll neither resumed the sandbox nor ran anything in it
    const st = await db
      .selectFrom("device_instances")
      .select("status")
      .where("device_id", "=", c.deviceId)
      .executeTakeFirstOrThrow();
    expect(st.status).toBe("suspended");
    expect(await alive(c, t)).toBe(false);
  });

  it("a task of a rebuilt sandbox ends lost (sandbox_recreated)", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 305");
    const row = await db
      .selectFrom("device_instances")
      .select("handle")
      .where("device_id", "=", c.deviceId)
      .executeTakeFirstOrThrow();
    await killFakeExecution(root, t);
    await removeFakeSandbox(root, (row.handle as { id: string }).id);
    // the next use finds the instance gone and rebuilds it
    expect((await inSandbox(c, "true")).exitCode).toBe(0);
    expect(await job.pollOnce()).toBe(1);
    expect(await store.get(t.id)).toMatchObject({
      status: "lost",
      lostReason: "sandbox_recreated",
      killPending: false,
    });
  });

  it("a task whose sandbox is gone ends lost (sandbox_gone)", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 306");
    await sandbox.destroyDevice(c.deviceId);
    expect(await job.pollOnce()).toBe(1);
    expect(await store.get(t.id)).toMatchObject({ status: "lost", lostReason: "sandbox_gone" });
  });

  it("keeps the sandbox alive: a poll moves last_used_at forward, so idle suspension skips it", async () => {
    const c = await conversation();
    await launch(c, "sleep 307");
    const idleMs =
      k.app.get(KernelConfigService).get().sandbox.limits.suspendAfterIdleMinutes * 60_000;
    const age = async (ago: number) =>
      db
        .updateTable("device_instances")
        .set({ last_used_at: new Date(Date.now() - ago) })
        .where("device_id", "=", c.deviceId)
        .execute();
    const status = async () =>
      await db
        .selectFrom("device_instances")
        .select(["status", "last_used_at"])
        .where("device_id", "=", c.deviceId)
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
  });

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
          deviceId: c.deviceId,
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
  });

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
          deviceId: conv.deviceId,
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
  });
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
  });
});

describe("stopping", () => {
  it("stops a running task within 6 s as stopped, its session empty", async () => {
    const c = await conversation();
    const t = await launch(c, "echo started; sleep 309");
    await waitFor(
      async () => (await inSandbox(c, `grep -q started ${t.outputPath}`)).exitCode === 0,
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
  });

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
  });

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
  });

  it("a stop that fails while the sandbox runs keeps the task running and gives up its claim", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 317");
    vi.spyOn(sandbox, "ifRunning").mockRejectedValueOnce(new Error("sandbox busy"));
    await expect(stopper.stop(t, "tool")).rejects.toThrow("sandbox busy");
    expect(await store.get(t.id)).toMatchObject({ status: "running", stoppingAt: null });
    expect(await finishedEvents(c.conversationId, t.id)).toHaveLength(0);
    expect(await alive(c, t)).toBe(true);
  });

  it("a stop of a reservation only claims it (its launch kills what it starts)", async () => {
    const c = await conversation();
    const id = newTaskId();
    await store.reserve(
      {
        id,
        orgId: c.orgId,
        conversationId: c.conversationId,
        sandboxConversationId: c.conversationId,
        deviceId: c.deviceId,
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
  });

  it("a stop of a task that already exited finishes it as its exit says", async () => {
    const c = await conversation();
    const t = await launch(c, "echo done");
    await exited(t);
    expect(await stopper.stop(t, "tool")).toMatchObject({ status: "completed", exitCode: 0 });
    expect((await finishedEvents(c.conversationId, t.id))[0]?.payload).toMatchObject({
      reported: true,
      lastLines: "done\n",
    });
  });

  it("a sub-agent run's end stops only the tasks that run started (M5)", async () => {
    const parent = await conversation();
    // a sub-agent of it, working in the parent's device
    const childId = randomUUID();
    await sql`INSERT INTO capybara.conversations
        (id, org_id, agent_id, account_id, kind, parent_conversation_id)
      VALUES (${childId}, ${parent.orgId}, ${parent.agentId}, ${parent.accountId}, 'subagent',
        ${parent.conversationId})`.execute(raw);
    const childRun = async () => ({
      ...parent,
      conversationId: childId,
      sandboxConversationId: parent.conversationId,
      ...(await startClaimedRun(k, raw, childId, parent.accountId)),
    });
    const c = await childRun();
    const older = await launch(c, "sleep 319");
    // the older run ends; a follow-up run starts its own task
    await db.updateTable("runs").set({ status: "completed" }).where("id", "=", c.runId).execute();
    const next = await childRun();
    const followUp = await launch(next, "sleep 320");
    // the older run's end, handled after the follow-up run started its own task
    await stopper.stopSubagentTasks(childId, c.runId);
    expect(await store.get(older.id)).toMatchObject({ status: "stopped" });
    expect(await alive(c, older)).toBe(false);
    expect(await store.get(followUp.id)).toMatchObject({ status: "running" });
    expect(await alive(c, followUp)).toBe(true);
    await stopper.stopSubagentTasks(childId, next.runId);
    expect(await store.get(followUp.id)).toMatchObject({ status: "stopped" });
  });

  it("a stop while the sandbox is suspended leaves the exact cancellation owed, never resuming it", async () => {
    const c = await conversation();
    const t = await launch(c, "sleep 310");
    expect(await sandbox.suspendIdle(new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThan(0);
    const row = await stopper.stop(t, "person");
    expect(row).toMatchObject({ status: "running", cancelRequestedBy: "person" });
    expect(row.cancelRequestedAt).toBeInstanceOf(Date);
    const st = await db
      .selectFrom("device_instances")
      .select("status")
      .where("device_id", "=", c.deviceId)
      .executeTakeFirstOrThrow();
    expect(st.status).toBe("suspended");
  });

  describe("through the run worker and the conversation delete", () => {
    let owner: Req;
    let orgId: string;
    let agentId: string;

    /** The task once the deletion's owed stop ended it. */
    const stoppedAfterDeletion = (t: BackgroundTaskRow) =>
      waitFor(
        async () => {
          const r = await store.get(t.id);
          return r?.status !== "running" && r;
        },
        15_000,
        "the deletion's stop",
      );

    /**
     * Launches `command` in conversation `conv` from a run of its own that then ends: the
     * conversation is idle with the task running.
     */
    async function launchIdle(conv: string, accountId: string, command: string) {
      const run = await startClaimedRun(k, raw, conv, accountId);
      const t = await launch({ orgId, accountId, agentId, conversationId: conv, ...run }, command);
      await db
        .updateTable("runs")
        .set({ status: "completed" })
        .where("id", "=", run.runId)
        .execute();
      return t;
    }

    beforeAll(async () => {
      await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
      owner = await session(k, "owner");
      orgId = await createOrgWithProviders(k, owner);
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: {
          definition: {
            name: "Lead",
            instructions: "Lead the work.",
            model: { provider: "model-script", model: "script-1" },
            disabledTools: onlyBuiltins(
              ["Agent", "Bash", "Write"].map((name) => ({ kind: "builtin", name })),
            ),
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
    });

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
    });

    it("deleting a conversation stops the running tasks in its sandbox first", async () => {
      const conv = await createConv(owner, orgId, agentId);
      used.push(conv);
      const owned = await db
        .selectFrom("conversations")
        .select("account_id")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow();
      const t = await launchIdle(conv, owned.account_id, "sleep 311");
      const res = await owner({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
      });
      expect(res.statusCode, res.body).toBe(204);
      // the deletion's stop is owed work after the commit (the outbox): wait for it
      expect(await stoppedAfterDeletion(t)).toMatchObject({ status: "stopped" });
      expect(await alive({ orgId, conversationId: conv }, t)).toBe(false);
    });

    it("a revocation that stops a task of a deleted conversation first still marks the stop the deletion's", async () => {
      const conv = await createConv(owner, orgId, agentId);
      used.push(conv);
      const owned = await db
        .selectFrom("conversations")
        .select("account_id")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow();
      const t = await launchIdle(conv, owned.account_id, "sleep 319");
      // the deletion committed; its revocation reaches the task before the deletion's own stop
      await sql`UPDATE capybara.conversations SET deleted_at = now() WHERE id = ${conv}`.execute(
        raw,
      );
      const stopped = await k.app.get(BackgroundTaskStopper).stop(t, "revoked");
      expect(stopped.status).toBe("stopped");
      expect((await finishedEvents(conv, t.id)).map((e) => e.payload)).toMatchObject([
        { status: "stopped", reported: false, stoppedBy: "deletion" },
      ]);
    });

    it.each(["root", "org"] as const)(
      "a revocation winning against the %s's deletion stop still marks the stop the deletion's",
      async (deleted) => {
        const conv = await createConv(owner, orgId, agentId);
        used.push(conv);
        const owned = await db
          .selectFrom("conversations")
          .select("account_id")
          .where("id", "=", conv)
          .executeTakeFirstOrThrow();
        const t = await launchIdle(conv, owned.account_id, "sleep 320");
        const root = await createConv(owner, orgId, agentId);
        used.push(root);
        // the task is a sub-agent's: its tree's root is another conversation
        await sql`UPDATE capybara.background_tasks SET sandbox_conversation_id = ${root}
          WHERE id = ${t.id}`.execute(raw);
        const runsBefore = await db
          .selectFrom("runs")
          .select("id")
          .where("conversation_id", "=", conv)
          .execute();
        if (deleted === "root")
          await sql`UPDATE capybara.conversations SET deleted_at = now() WHERE id = ${root}`.execute(
            raw,
          );
        else
          await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${orgId}`.execute(raw);
        try {
          const task = (await store.get(t.id)) as BackgroundTaskRow;
          const stopped = await k.app.get(BackgroundTaskStopper).stop(task, "revoked");
          expect(stopped.status).toBe("stopped");
        } finally {
          if (deleted === "org")
            await sql`UPDATE capybara.orgs SET deleted_at = NULL WHERE id = ${orgId}`.execute(raw);
        }
        expect((await finishedEvents(conv, t.id)).map((e) => e.payload)).toMatchObject([
          { status: "stopped", reported: false, stoppedBy: "deletion" },
        ]);
        // nothing woke: no run beyond the launching one
        expect(
          await db.selectFrom("runs").select("id").where("conversation_id", "=", conv).execute(),
        ).toEqual(runsBefore);
      },
    );

    it("deleting an idle conversation with a running task wakes no run (I1)", async () => {
      const conv = await createConv(owner, orgId, agentId);
      used.push(conv);
      const owned = await db
        .selectFrom("conversations")
        .select("account_id")
        .where("id", "=", conv)
        .executeTakeFirstOrThrow();
      const t = await launchIdle(conv, owned.account_id, "sleep 318");
      const res = await owner({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
      });
      expect(res.statusCode, res.body).toBe(204);
      // the deletion's stop is owed work after the commit (the outbox): wait for it
      expect(await stoppedAfterDeletion(t)).toMatchObject({ status: "stopped" });
      expect(await alive({ orgId, conversationId: conv }, t)).toBe(false);
      // the wake runs after the stop's commit; give a late one time to show up
      await new Promise((r) => setTimeout(r, 1000));
      // only the run that launched the task (ended before the deletion)
      const runs = await db
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", conv)
        .execute();
      expect(runs).toEqual([{ id: t.runId }]);
      // the stop's finish is marked as the deletion's, so nothing that reads it later wakes a run
      expect((await finishedEvents(conv, t.id)).map((e) => e.payload)).toMatchObject([
        { status: "stopped", reported: false, stoppedBy: "deletion" },
      ]);
    });
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
  });
});

/**
 * Exact background revocation end to end (permission runtime cutover 8.4, B3), on this worker-role
 * kernel: tasks admitted through the real path, real owner and org writers, the owed revoke
 * delivered through the outbox to the maintenance consumer, which stops only the affected task.
 */
describe("exact background revocation through the outbox and the worker", () => {
  const OWNER_PW = "correct horse battery";
  // a host the deployment's restricted allowlist covers, so the owner baseline may include it
  const HOST = "github.com";
  /** An authenticated staged `policy` frame carrying the machine's owner report (B2). */
  const ownerFrame = (
    sequence: number,
    o: { fullAccess: boolean; domains: string[]; reach?: "workspace" | "os-user" },
  ) => ({
    type: "policy",
    policy: { mode: o.fullAccess ? "auto" : "sandbox", allowedDomains: o.domains },
    ownerCeiling: {
      version: 2,
      revision: `owner-${sequence}`,
      sequence,
      fullAccess: o.fullAccess,
      restrictedProjectReach: o.reach ?? "os-user",
      restrictedAllowedDomains: o.domains,
    },
  });
  let current: { account: Account; login: string } | undefined;
  const owner = () => {
    if (!current) throw new Error("no owner yet");
    return current;
  };
  const ownerAccount = () => owner().account;
  const ownerLogin = () => owner().login;
  beforeEach(async () => {
    const login = `owner-${randomUUID().slice(0, 8)}`;
    const account = await accountsFor(kernelDb(raw)).createLocal({
      login,
      password: OWNER_PW,
      displayName: "Owner",
    });
    current = { account, login };
  });

  it("the real owner writer revokes only the baseline-host task; the outbox delivers the exact stop through the worker", async () => {
    const f = await managedTaskFixture({
      kernels: [k],
      raw,
      login: ownerLogin(),
      password: OWNER_PW,
      accountId: ownerAccount().id,
      launch: false,
    });
    const machine = await f.db
      .selectFrom("device_machines")
      .select("id")
      .where("device_id", "=", f.deviceId)
      .executeTakeFirstOrThrow();
    // the owner's restricted baseline allows the host when the first task is admitted: written
    // by the machine's authenticated policy frame (B2 owner report), not by SQL
    await k.app
      .get(MachinesService)
      .recordPolicyV3(
        machine.id,
        ownerFrame(1, { fullAccess: true, domains: [HOST] }),
        "connection-1",
      );
    const baselineTask = await f.launchAnother();
    // the person approves the host for this run through the real network ask and decision: an
    // explicit grant independent of the baseline
    const approvals = k.app.get(ApprovalsService);
    const ask = await approvals.requestNetwork({
      orgId: f.orgId,
      conversationId: f.conversationId,
      runId: f.runId,
      step: 1,
      callId: `c-${randomUUID().slice(0, 8)}`,
      requestedFor: ownerAccount().id,
      detail: {
        deviceId: f.deviceId,
        hosts: [{ host: HOST, port: 443 }],
        command: `curl https://${HOST}/`,
        description: "Fetch",
        result: { content: "blocked", isError: true },
      },
      scopes: ["once"],
    });
    await approvals.decide(f.orgId, ask.id, ownerAccount().id, {
      decision: "approve",
      scope: "once",
    });
    const grantedTask = await f.launchAnother();
    const intentOf = async (taskId: string) => {
      const task = await f.db
        .selectFrom("background_tasks")
        .select("operation_id")
        .where("id", "=", taskId)
        .executeTakeFirstOrThrow();
      return f.db
        .selectFrom("sandbox_operation_intents")
        .selectAll()
        .where("operation_id", "=", task.operation_id as string)
        .executeTakeFirstOrThrow();
    };
    const taskOf = (id: string) =>
      f.db
        .selectFrom("background_tasks")
        .select(["status", "launch_state"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    // the real admissions recorded the provenance: baseline only vs an explicit run grant
    const a = await intentOf(baselineTask);
    const b = await intentOf(grantedTask);
    expect(a.scope).toMatchObject({ network: { kind: "allowlist", hosts: [HOST] } });
    expect(a.granted_hosts).toEqual([]);
    expect(b.scope).toMatchObject({ network: { kind: "allowlist" } });
    expect(b.granted_hosts).toEqual([HOST]);
    // the launching run completes; the started authority does not depend on it
    await f.db.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
    // the owner removes the host from the baseline on the machine (a restricted-only change),
    // reported by the next authenticated policy frame
    await k.app
      .get(MachinesService)
      .recordPolicyV3(machine.id, ownerFrame(2, { fullAccess: true, domains: [] }), "connection-1");
    expect((await intentOf(baselineTask)).state).toBe("revoked");
    expect((await intentOf(grantedTask)).state).toBe("background-running");
    await drainOutbox(k.app, { jobName: "sandbox-operation-revoke" });
    // only the maintenance consumer acknowledges a revocation
    await waitFor(
      async () => (await intentOf(baselineTask)).revoke_acknowledged,
      30_000,
      "the worker's exact revoke",
    );
    expect(await taskOf(baselineTask)).toEqual({ status: "stopped", launch_state: "terminal" });
    expect(f.provider.calls.stop).toHaveLength(1);
    expect(await taskOf(grantedTask)).toEqual({ status: "running", launch_state: "acknowledged" });
    expect((await intentOf(grantedTask)).state).toBe("background-running");
  });

  it("the B2 owner writer: a restricted-only change keeps Full work and consent; Full narrowing revokes only Full work", async () => {
    const f = await managedTaskFixture({
      kernels: [k],
      raw,
      login: ownerLogin(),
      password: OWNER_PW,
      accountId: ownerAccount().id,
      launch: false,
    });
    const machine = await f.db
      .selectFrom("device_machines")
      .select("id")
      .where("device_id", "=", f.deviceId)
      .executeTakeFirstOrThrow();
    const machines = k.app.get(MachinesService);
    await machines.recordPolicyV3(
      machine.id,
      ownerFrame(1, { fullAccess: true, domains: [HOST] }),
      "connection-1",
    );
    const profiles = k.app.get(PermissionProfilesService);
    const facts = k.app.get(PermissionFacts);
    const preview = await facts.scope(f.orgId, f.deviceId, null, null);
    if (!preview.scopeRevision) throw new Error("the fixture device has no Full scope");
    const { revision } = await profiles.set(f.orgId, f.conversationId, ownerAccount().id, {
      profile: "full-access",
      consentScopeRevision: preview.scopeRevision,
      expectedRevision: 0,
    });
    const fullTask = await f.launchAnother();
    await profiles.set(f.orgId, f.conversationId, ownerAccount().id, {
      profile: "approve-for-me",
      expectedRevision: revision,
    });
    const restrictedTask = await f.launchAnother();
    const intentOf = async (taskId: string) => {
      const task = await f.db
        .selectFrom("background_tasks")
        .select("operation_id")
        .where("id", "=", taskId)
        .executeTakeFirstOrThrow();
      return f.db
        .selectFrom("sandbox_operation_intents")
        .selectAll()
        .where("operation_id", "=", task.operation_id as string)
        .executeTakeFirstOrThrow();
    };
    const taskOf = (id: string) =>
      f.db
        .selectFrom("background_tasks")
        .select(["status", "launch_state"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    expect((await intentOf(fullTask)).scope).toMatchObject({ profile: "full-access" });
    expect((await intentOf(restrictedTask)).scope).toMatchObject({
      profile: "approve-for-me",
      network: { kind: "allowlist", hosts: [HOST] },
    });
    await f.db.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
    const consentAt = (await facts.scope(f.orgId, f.deviceId, null, null)).scopeRevision;
    // restricted-only owner change (baseline host and reach): only restricted work it narrows
    await machines.recordPolicyV3(
      machine.id,
      ownerFrame(2, { fullAccess: true, domains: [], reach: "workspace" }),
      "connection-1",
    );
    expect((await intentOf(restrictedTask)).state).toBe("revoked");
    expect((await intentOf(fullTask)).state).toBe("background-running");
    // the Full consent scope is untouched by a restricted-only change
    expect((await facts.scope(f.orgId, f.deviceId, null, null)).scopeRevision).toBe(consentAt);
    await drainOutbox(k.app, { jobName: "sandbox-operation-revoke" });
    await waitFor(
      async () => (await intentOf(restrictedTask)).revoke_acknowledged,
      30_000,
      "the worker's exact revoke of the restricted task",
    );
    expect(await taskOf(restrictedTask)).toEqual({ status: "stopped", launch_state: "terminal" });
    expect(await taskOf(fullTask)).toEqual({ status: "running", launch_state: "acknowledged" });
    expect(f.provider.calls.stop).toHaveLength(1);
    // the owner removes Full: only the Full task is revoked and stopped exactly
    await machines.recordPolicyV3(
      machine.id,
      ownerFrame(3, { fullAccess: false, domains: [], reach: "workspace" }),
      "connection-1",
    );
    expect((await intentOf(fullTask)).state).toBe("revoked");
    expect((await facts.scope(f.orgId, f.deviceId, null, null)).scopeRevision).not.toBe(consentAt);
    await drainOutbox(k.app, { jobName: "sandbox-operation-revoke" });
    await waitFor(
      async () => (await intentOf(fullTask)).revoke_acknowledged,
      30_000,
      "the worker's exact revoke of the Full task",
    );
    expect(await taskOf(fullTask)).toEqual({ status: "stopped", launch_state: "terminal" });
    expect(f.provider.calls.stop).toHaveLength(2);
  });

  it("I5: org Full off revokes running restricted work on a selected project outside the workspace", async () => {
    const f = await managedTaskFixture({
      kernels: [k],
      raw,
      login: ownerLogin(),
      password: OWNER_PW,
      accountId: ownerAccount().id,
      launch: false,
    });
    const machine = await f.db
      .selectFrom("device_machines")
      .select("id")
      .where("device_id", "=", f.deviceId)
      .executeTakeFirstOrThrow();
    // the owner allows no Full but OS-user project reach (B2 report)
    await k.app
      .get(MachinesService)
      .recordPolicyV3(
        machine.id,
        ownerFrame(1, { fullAccess: false, domains: [], reach: "os-user" }),
        "connection-1",
      );
    // the instance already runs at the limits that ceiling gives (no recreation on launch)
    // (the managed test provider is not `@local`, so the sandbox service treats it like a cloud one)
    const limits = await k.app
      .get(SandboxService)
      .deviceLimits({ orgId: f.orgId, deviceId: f.deviceId }, { source: "cloud" });
    await f.db
      .updateTable("device_instances")
      .set({ instance_limits: JSON.stringify({ mode: limits.mode, network: limits.network }) })
      .where("device_id", "=", f.deviceId)
      .execute();
    const outside = "/home/owner/ext";
    await f.db
      .insertInto("device_projects")
      .values({ device_id: f.deviceId, name: "ext", path: outside, created_by: ownerAccount().id })
      .execute();
    // the conversation is bound to that project (as creating it with the project binds it; the
    // shared fixture creates the conversation before the device exists)
    await sql`UPDATE capybara.conversations SET project_name = 'ext', project_path = ${outside}
      WHERE id = ${f.conversationId}`.execute(f.db);
    // the bound run start records the project's root: it becomes the working root
    await k.app.get(EventLog).append(f.conversationId, [
      {
        type: "project_root",
        idemKey: `test_project_root:${f.conversationId}`,
        payload: { project: "ext", root: outside, skills: [] },
      },
    ]);
    const task = await f.launchAnother();
    const intentOf = async (taskId: string) => {
      const t = await f.db
        .selectFrom("background_tasks")
        .select("operation_id")
        .where("id", "=", taskId)
        .executeTakeFirstOrThrow();
      return f.db
        .selectFrom("sandbox_operation_intents")
        .selectAll()
        .where("operation_id", "=", t.operation_id as string)
        .executeTakeFirstOrThrow();
    };
    expect((await intentOf(task)).scope).toMatchObject({
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: [outside, "/skills"], writeRoots: [outside] },
    });
    await f.db.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
    await k.app.get(OrgSettingsService).update(f.orgId, { fullAccess: "off" }, ownerAccount().id);
    expect((await intentOf(task)).state).toBe("revoked");
    await drainOutbox(k.app, { jobName: "sandbox-operation-revoke" });
    await waitFor(
      async () => (await intentOf(task)).revoke_acknowledged,
      30_000,
      "the worker's exact revoke of the outside-project task",
    );
    expect(f.provider.calls.stop).toHaveLength(1);
  });

  it("R1: with Full on, an org removing a host revokes the outside-project task using it, not its sibling", async () => {
    const f = await managedTaskFixture({
      kernels: [k],
      raw,
      login: ownerLogin(),
      password: OWNER_PW,
      accountId: ownerAccount().id,
      launch: false,
    });
    const machine = await f.db
      .selectFrom("device_machines")
      .select("id")
      .where("device_id", "=", f.deviceId)
      .executeTakeFirstOrThrow();
    const machines = k.app.get(MachinesService);
    // Full allowed with OS-user reach (as a protocol 2 auto machine translates), no baseline host
    await machines.recordPolicyV3(
      machine.id,
      ownerFrame(1, { fullAccess: true, domains: [], reach: "os-user" }),
      "connection-1",
    );
    const outside = "/home/owner/ext";
    await f.db
      .insertInto("device_projects")
      .values({ device_id: f.deviceId, name: "ext", path: outside, created_by: ownerAccount().id })
      .execute();
    await sql`UPDATE capybara.conversations SET project_name = 'ext', project_path = ${outside}
      WHERE id = ${f.conversationId}`.execute(f.db);
    await k.app.get(EventLog).append(f.conversationId, [
      {
        type: "project_root",
        idemKey: `test_project_root:${f.conversationId}`,
        payload: { project: "ext", root: outside, skills: [] },
      },
    ]);
    const sibling = await f.launchAnother();
    // the owner adds the host to the baseline (a restricted-only widening: nothing is revoked)
    await machines.recordPolicyV3(
      machine.id,
      ownerFrame(2, { fullAccess: true, domains: [HOST], reach: "os-user" }),
      "connection-1",
    );
    const task = await f.launchAnother();
    const intentOf = async (taskId: string) => {
      const t = await f.db
        .selectFrom("background_tasks")
        .select("operation_id")
        .where("id", "=", taskId)
        .executeTakeFirstOrThrow();
      return f.db
        .selectFrom("sandbox_operation_intents")
        .selectAll()
        .where("operation_id", "=", t.operation_id as string)
        .executeTakeFirstOrThrow();
    };
    expect((await intentOf(task)).scope).toMatchObject({
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: [outside, "/skills"] },
      network: { kind: "allowlist", hosts: [HOST] },
    });
    expect((await intentOf(sibling)).scope).toMatchObject({
      filesystem: { kind: "scoped", readRoots: [outside, "/skills"] },
      network: { kind: "none" },
    });
    await f.db.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
    // Full stays on; the org removes the host from its network
    await k.app
      .get(OrgSettingsService)
      .update(
        f.orgId,
        { cloudNetwork: { mode: "allowlist", excludedHosts: [HOST] } },
        ownerAccount().id,
      );
    expect((await intentOf(task)).state).toBe("revoked");
    expect((await intentOf(sibling)).state).toBe("background-running");
  });

  it("the real org writer turning Full off revokes only the task admitted under Full; the worker stops it exactly", async () => {
    const f = await managedTaskFixture({
      kernels: [k],
      raw,
      login: ownerLogin(),
      password: OWNER_PW,
      accountId: ownerAccount().id,
      launch: false,
    });
    const profiles = k.app.get(PermissionProfilesService);
    // the person selects Full with consent to the displayed scope; the first task starts under it
    const preview = await k.app.get(PermissionFacts).scope(f.orgId, f.deviceId, null, null);
    if (!preview.scopeRevision) throw new Error("the fixture device has no Full scope");
    const { revision } = await profiles.set(f.orgId, f.conversationId, ownerAccount().id, {
      profile: "full-access",
      consentScopeRevision: preview.scopeRevision,
      expectedRevision: 0,
    });
    const fullTask = await f.launchAnother();
    // back to a restricted profile: started work keeps its starting scope, the next task is restricted
    await profiles.set(f.orgId, f.conversationId, ownerAccount().id, {
      profile: "approve-for-me",
      expectedRevision: revision,
    });
    const restrictedTask = await f.launchAnother();
    const intentOf = async (taskId: string) => {
      const task = await f.db
        .selectFrom("background_tasks")
        .select("operation_id")
        .where("id", "=", taskId)
        .executeTakeFirstOrThrow();
      return f.db
        .selectFrom("sandbox_operation_intents")
        .selectAll()
        .where("operation_id", "=", task.operation_id as string)
        .executeTakeFirstOrThrow();
    };
    expect((await intentOf(fullTask)).scope).toMatchObject({ profile: "full-access" });
    expect((await intentOf(restrictedTask)).scope).toMatchObject({ profile: "approve-for-me" });
    await f.db.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
    await k.app.get(OrgSettingsService).update(f.orgId, { fullAccess: "off" }, ownerAccount().id);
    expect((await intentOf(fullTask)).state).toBe("revoked");
    expect((await intentOf(restrictedTask)).state).toBe("background-running");
    await drainOutbox(k.app, { jobName: "sandbox-operation-revoke" });
    await waitFor(
      async () => (await intentOf(fullTask)).revoke_acknowledged,
      30_000,
      "the worker's exact revoke",
    );
    const taskOf = (id: string) =>
      f.db
        .selectFrom("background_tasks")
        .select(["status", "launch_state"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    expect(await taskOf(fullTask)).toEqual({ status: "stopped", launch_state: "terminal" });
    expect(f.provider.calls.stop).toHaveLength(1);
    expect(await taskOf(restrictedTask)).toEqual({
      status: "running",
      launch_state: "acknowledged",
    });
  });
});
