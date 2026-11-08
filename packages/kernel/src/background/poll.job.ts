import { rootsOf, type SandboxHandle } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelConfig } from "../config/schema.js";
import { EventLog } from "../conversations/event-log.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  type HeldProvider,
  type IfRunningResult,
  SandboxService,
} from "../sandbox/sandbox.service.js";
import { sandboxBaseTimeoutMs } from "../tools/builtins/sandbox/common.js";
import { type BackgroundFinish, BackgroundTaskFinisher } from "./finish.js";
import { LAUNCH_EXEC_TIMEOUT_MS } from "./launch.js";
import { actingAs, taskActor } from "./session.js";
import { parsePollOutput, polledAs, pollScript, type TaskReport } from "./status.js";
import { notRunningAs, RECREATED } from "./stop.js";
import { type BackgroundTaskRow, BackgroundTaskStore } from "./store.js";

/** The poll of the running background tasks (`@LockedInterval`, every `pollSeconds`). */
export const BACKGROUND_POLL_JOB = "background-task-poll";
/** The daily prune of finished background tasks older than `tools.outputRetentionDays`. */
export const BACKGROUND_PRUNE_JOB = "background-task-prune";

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
 * - `background-task-poll` (every `sandbox.background.pollSeconds`): for every environment
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
      "runningStarted" | "pruneFinished" | "failAbandonedLaunches"
    >,
    @Inject(BackgroundTaskFinisher) private readonly finisher: BackgroundTaskFinisher,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "publishChanged">,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "cloudAvailable" | "availableFor" | "ifRunning">,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
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
      // one exec per instance: the tasks of every conversation sharing the environment
      const key = `${t.environmentId} ${t.sandboxCreatedAt.getTime()}`;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    let finished = 0;
    for (const tasks of groups.values()) {
      if (signal.aborted) break;
      try {
        // the environment's provider is not there (no cloud provider, `@device` not served):
        // its tasks stay as they are until it is
        const env = tasks[0]?.environmentId ?? null;
        if (env === null ? !this.sandbox.cloudAvailable : !(await this.sandbox.availableFor(env))) {
          continue;
        }
        finished += await this.pollSandbox(tasks, signal);
      } catch (err) {
        if (signal.aborted) break;
        this.log.warn("cannot poll background tasks; retrying next tick", {
          environmentId: tasks[0]?.environmentId,
          err,
        });
      }
    }
    if (finished > 0) this.log.info("background tasks finished", { count: finished });
    return finished;
  }

  /** Polls the tasks of one environment instance; returns how many finished. */
  private async pollSandbox(tasks: BackgroundTaskRow[], signal: AbortSignal): Promise<number> {
    const [first] = tasks as [BackgroundTaskRow];
    // a task from before environments has no instance any more
    const r: IfRunningResult<Map<string, TaskReport>> =
      first.environmentId === null
        ? { kind: "not_running", status: "gone" }
        : await this.sandbox.ifRunning(
            first.environmentId,
            { createdAt: first.sandboxCreatedAt as Date },
            (p, h, sig) => this.pollExec(actingAs(p, taskActor(first)), h, tasks, sig),
            signal,
          );
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
