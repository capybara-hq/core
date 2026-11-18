import { rootsOf, type SandboxHandle } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { KernelConfig } from "../config/schema.js";
import { EventLog } from "../conversations/event-log.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { PERMISSION_CONTEXT_ACTIVATION } from "../sandbox/permission-context-types.js";
import {
  type HeldProvider,
  type IfRunningResult,
  RetirementPendingError,
  SandboxService,
} from "../sandbox/sandbox.service.js";
import { sandboxBaseTimeoutMs } from "../tools/builtins/sandbox/common.js";
import { type BackgroundFinish, BackgroundTaskFinisher } from "./finish.js";
import { LAUNCH_EXEC_TIMEOUT_MS } from "./launch.js";
import {
  exactRefOf,
  lastLinesByRef,
  onManagedInstance,
  statusEnd,
  summaryLines,
} from "./managed.js";
import { actingAs, taskActor } from "./session.js";
import { parsePollOutput, polledAs, pollScript, type TaskReport } from "./status.js";
import { BackgroundTaskStopper, notRunningAs, RECREATED } from "./stop.js";
import { type BackgroundTaskRow, BackgroundTaskStore } from "./store.js";

/** The poll of the running background tasks (`@LockedInterval`, every `pollSeconds`). */
export const BACKGROUND_POLL_JOB = "background-task-poll";
/** The daily prune of finished background tasks older than `tools.outputRetentionDays`. */
export const BACKGROUND_PRUNE_JOB = "background-task-prune";

/** The most owed managed cancellations one poll applies (each a lease and up to a 5 s grace). */
export const MANAGED_STOPS_PER_TICK = 8;

/** The least age at which a reservation counts as abandoned, whatever the config. */
const LAUNCH_ABANDONED_FLOOR_MS = 120_000;

/**
 * A reservation (`sid` null) older than this has lost its launch. The slowest legitimate launch
 * is the pipeline's own limit for a background `Bash` call ({@link LAUNCH_EXEC_TIMEOUT_MS} plus
 * {@link sandboxBaseTimeoutMs}: the tool timeout, `sandbox.lockWaitSeconds` and the setup margin),
 * so twice that (never under 2 minutes) leaves a wide margin: only a launching process that died
 * leaves a reservation this old.
 */
export const launchAbandonedAfterMs = (cfg: KernelConfig): number =>
  Math.max(LAUNCH_ABANDONED_FLOOR_MS, 2 * (LAUNCH_EXEC_TIMEOUT_MS + sandboxBaseTimeoutMs(cfg)));

/** The time limit of one sandbox's poll exec. */
const POLL_EXEC_TIMEOUT_MS = 30_000;
/** The most output one poll exec keeps (a line per task, with a tail when it ended). */
const POLL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * The worker's background task jobs (spec 2026-11-05-background-bash-design §4.3), each once per
 * tick across replicas:
 * - `background-task-poll` (every `sandbox.background.pollSeconds`): for every device
 *   instance with running tasks (of any conversation using it), one exec through
 *   `SandboxService.ifRunning` (which never creates or resumes an instance) reports each task's
 *   exit file and liveness; ended tasks finish through {@link BackgroundTaskFinisher}. Each poll
 *   takes and releases a lease, so `last_used_at` stays fresh and an instance with running tasks
 *   is never idle-suspended;
 * - `background-task-prune` (daily): deletes finished tasks older than `tools.outputRetentionDays`.
 */
@Injectable()
export class BackgroundTaskPollJob {
  constructor(
    @Inject(BackgroundTaskStore)
    private readonly store: Pick<
      BackgroundTaskStore,
      | "runningStarted"
      | "runningManaged"
      | "owedCancels"
      | "pruneFinished"
      | "failAbandonedLaunches"
    >,
    @Inject(BackgroundTaskFinisher) private readonly finisher: BackgroundTaskFinisher,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "publishChanged">,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "cloudAvailable" | "availableFor" | "ifRunning">,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
    @Inject(BackgroundTaskStopper)
    private readonly stopper: Pick<BackgroundTaskStopper, "stop">,
    /**
     * The paired activation gate: once on, a legacy (SID) task is never polled by a raw exec;
     * its instance's poll is refused for the retirement gate ({@link pollSandbox}).
     */
    @Optional() @Inject(PERMISSION_CONTEXT_ACTIVATION) private readonly activation?: boolean,
    /** The marker that logs a refused legacy poll once per instance across the replicas. */
    @Optional() @Inject(REDIS) private readonly redis?: Pick<Redis, "set">,
  ) {}

  @LockedInterval(BACKGROUND_POLL_JOB, (cfg) => cfg.sandbox.background.pollSeconds * 1000)
  async poll(signal?: AbortSignal): Promise<void> {
    await this.pollOnce(signal);
  }

  /**
   * One poll of every running task (the body of {@link poll}); returns how many tasks finished.
   * A sandbox whose poll fails (busy, a provider error) is logged and tried again next tick.
   * First, reservations abandoned by a launch that died ({@link launchAbandonedAfterMs}) are
   * failed, so they stop holding a slot of `sandbox.background.maxTasks` (not counted in the
   * result: they never started), with a `changed: "background"` frame to their conversations.
   */
  async pollOnce(signal: AbortSignal = new AbortController().signal): Promise<number> {
    const abandoned = await this.store.failAbandonedLaunches(
      new Date(Date.now() - launchAbandonedAfterMs(this.config.get())),
    );
    if (abandoned.length > 0) {
      this.log.warn("abandoned background launches failed", { count: abandoned.length });
      // a client that listed the reservation as running refreshes (the owner and, for a
      // sub-agent's task, the conversation that owns the sandbox); a failed publish only logs
      const conversations = new Set(
        abandoned.flatMap((t) => [t.conversationId, t.sandboxConversationId]),
      );
      for (const c of conversations) await this.eventLog.publishChanged(c, "background");
    }
    const groups = new Map<string, BackgroundTaskRow[]>();
    for (const t of await this.store.runningStarted()) {
      if (t.sid === null || t.sandboxCreatedAt === null) continue;
      // one exec per instance: the tasks of every conversation sharing the device
      const key = `${t.deviceId} ${t.sandboxCreatedAt.getTime()}`;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    let finished = 0;
    for (const tasks of groups.values()) {
      if (signal.aborted) break;
      try {
        // the device's provider is not there (no cloud provider, `@local` not served):
        // its tasks stay as they are until it is
        const env = tasks[0]?.deviceId ?? null;
        if (env === null ? !this.sandbox.cloudAvailable : !(await this.sandbox.availableFor(env))) {
          continue;
        }
        finished += await this.pollSandbox(tasks, signal);
      } catch (err) {
        if (signal.aborted) break;
        this.log.warn("cannot poll background tasks; retrying next tick", {
          deviceId: tasks[0]?.deviceId,
          err,
        });
      }
    }
    finished += await this.pollManaged(signal);
    if (finished > 0) this.log.info("background tasks finished", { count: finished });
    return finished;
  }

  /**
   * The managed tasks (permission runtime cutover phase 8.3), by exact ref only: an acknowledged
   * task's status on its exact instance (one lease per instance, never resumed; an exit or a lost
   * supervision finishes it with the exact tail's last lines), and a `cancel-pending` task's owed
   * exact stop (through the stopper, so its claim, outcome and requester's wake rule hold). A
   * malformed ref is never used; an unavailable provider leaves its tasks as they are.
   */
  private async pollManaged(signal: AbortSignal): Promise<number> {
    const groups = new Map<string, BackgroundTaskRow[]>();
    const cancels: BackgroundTaskRow[] = [];
    for (const t of [...(await this.store.runningManaged()), ...(await this.store.owedCancels())]) {
      try {
        exactRefOf(t);
      } catch (err) {
        this.log.warn("a managed background task has a malformed reference; skipped", {
          taskId: t.id,
          err,
        });
        continue;
      }
      if (t.launchState === "cancel-pending") {
        cancels.push(t);
        continue;
      }
      const key = `${t.deviceId} ${t.instanceGeneration}`;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    let n = 0;
    for (const tasks of groups.values()) {
      if (signal.aborted) break;
      const [first] = tasks as [BackgroundTaskRow];
      try {
        if (!(await this.sandbox.availableFor(first.deviceId as string))) continue;
        n += await this.pollManagedInstance(tasks, signal);
      } catch (err) {
        if (signal.aborted) break;
        this.log.warn("cannot poll managed background tasks; retrying next tick", {
          deviceId: first.deviceId,
          err,
        });
      }
    }
    // Bounded per tick: at most this many stops that reach a provider, least recently attempted
    // first (an attempt moves a task to the back, so one that keeps failing never holds the head);
    // a task whose provider is not loaded takes no turn. The rest stay owed for the next ticks.
    let attempts = 0;
    for (const t of cancels) {
      if (signal.aborted || attempts >= MANAGED_STOPS_PER_TICK) break;
      try {
        if (!(await this.sandbox.availableFor(t.deviceId as string))) continue;
        attempts++;
        const after = await this.stopper.stop(t, "revoked", signal);
        if (after.status !== "running") n++;
      } catch (err) {
        this.log.warn("cannot apply an owed background task cancellation; retrying next tick", {
          taskId: t.id,
          err,
        });
      }
    }
    return n;
  }

  /** The exact statuses of one instance's acknowledged managed tasks; returns how many finished. */
  private async pollManagedInstance(
    tasks: BackgroundTaskRow[],
    signal: AbortSignal,
  ): Promise<number> {
    const [first] = tasks as [BackgroundTaskRow];
    const r = await onManagedInstance(
      this.sandbox.ifRunning.bind(this.sandbox),
      first,
      async (bg, h, _ref, sig) => {
        const ends = new Map<string, { to: BackgroundFinish; lastLines: string }>();
        for (const t of tasks) {
          // one task's failing status never holds back the others of its instance
          try {
            const { ref } = exactRefOf(t);
            const to = statusEnd(await bg.status(h, ref, sig));
            if (to) {
              ends.set(t.id, {
                to,
                lastLines: summaryLines(await lastLinesByRef(bg, h, ref, sig)),
              });
            }
          } catch (err) {
            sig.throwIfAborted();
            this.log.warn("cannot read a managed background task's status; retrying next tick", {
              taskId: t.id,
              err,
            });
          }
        }
        return ends;
      },
      signal,
    );
    let n = 0;
    for (const t of tasks) {
      const end: { to: BackgroundFinish; lastLines: string } | undefined =
        r.kind === "ran"
          ? r.value.get(t.id)
          : r.kind === "not_running"
            ? { to: notRunningAs(r.status, false), lastLines: "" }
            : { to: RECREATED, lastLines: "" };
      // a stop that claimed the task after the read above finishes it itself
      if (end && (await this.finisher.finish(t, end.to, end.lastLines, false, { unclaimed: true })))
        n++;
    }
    return n;
  }

  /** Polls the tasks of one device instance; returns how many finished. */
  private async pollSandbox(tasks: BackgroundTaskRow[], signal: AbortSignal): Promise<number> {
    const [first] = tasks as [BackgroundTaskRow];
    // a task from before devices has no instance any more
    let r: IfRunningResult<Map<string, TaskReport>>;
    try {
      r =
        first.deviceId === null
          ? { kind: "not_running", status: "gone" }
          : await this.sandbox.ifRunning(
              first.deviceId,
              { createdAt: first.sandboxCreatedAt as Date },
              (p, h, sig) =>
                this.pollExec(actingAs(p, taskActor(first), this.activation), h, tasks, sig),
              signal,
            );
    } catch (err) {
      // once activated, a running legacy instance is the retirement gate's: its tasks stay as
      // they are until it retires them; said once per instance, not as a warning every tick
      if (!(err instanceof RetirementPendingError)) throw err;
      await this.noteRetirementOnce(first);
      return 0;
    }
    const now = new Date();
    let n = 0;
    for (const t of tasks) {
      let to: BackgroundFinish | null;
      let lastLines = "";
      if (r.kind === "ran") {
        const report = r.value.get(t.id);
        // a task the exec did not report is checked again next tick
        to = report ? polledAs(t, report, now) : null;
        lastLines = report?.lastLines ?? "";
      } else if (r.kind === "not_running") {
        // a suspended sandbox may keep the processes (E2B's pause): killed after its next resume
        to = notRunningAs(r.status, r.status === "suspended");
      } else {
        to = RECREATED;
      }
      // a stop that claimed the task after the read above finishes it itself
      if (to && (await this.finisher.finish(t, to, lastLines, false, { unclaimed: true }))) n++;
    }
    return n;
  }

  /**
   * Logs at `info`, once per legacy instance across the replicas (a Redis marker; every time
   * without one), that its tasks are left to the retirement gate. A Redis failure logs anyway.
   */
  private async noteRetirementOnce(first: BackgroundTaskRow): Promise<void> {
    const instance = `${first.deviceId}:${first.sandboxCreatedAt?.getTime() ?? 0}`;
    // a log marker, not a lock: the previous value says whether this instance was logged (two
    // replicas racing may both log, which is harmless)
    const firstTime =
      this.redis === undefined ||
      (await this.redis
        .set(`capk:bg-legacy-retirement-noted:${instance}`, "1", "EX", 86_400, "GET")
        .then((prev) => prev === null)
        .catch(() => true));
    if (firstTime)
      this.log.info("legacy background tasks left to the retirement gate; not polled", {
        deviceId: first.deviceId,
        instanceGeneration: first.sandboxCreatedAt?.getTime(),
      });
  }

  /** The poll exec of one instance: each task's report by id. */
  private async pollExec(
    p: HeldProvider,
    h: SandboxHandle,
    tasks: BackgroundTaskRow[],
    signal: AbortSignal,
  ): Promise<Map<string, TaskReport>> {
    const res = await p.exec(h, {
      command: pollScript(tasks.map((t) => ({ id: t.id, sid: t.sid as string }))),
      cwd: rootsOf(h).workspace,
      timeoutMs: POLL_EXEC_TIMEOUT_MS,
      maxOutputBytes: POLL_MAX_OUTPUT_BYTES,
      signal,
    });
    if (res.exitCode !== 0 || res.truncated) {
      throw new Error(
        `the poll exec failed (exit ${res.exitCode}${res.truncated ? ", truncated" : ""}): ${res.stderr.slice(0, 500)}`,
      );
    }
    return parsePollOutput(res.stdout);
  }

  /** Deletes the finished tasks older than `tools.outputRetentionDays` (their rows only). */
  @LockedCron("30 3 * * *", { name: BACKGROUND_PRUNE_JOB })
  async prune(): Promise<void> {
    const days = this.config.get().tools.outputRetentionDays;
    const n = await this.store.pruneFinished(new Date(Date.now() - days * 86_400_000));
    if (n > 0) this.log.info("finished background tasks pruned", { count: n });
  }
}
