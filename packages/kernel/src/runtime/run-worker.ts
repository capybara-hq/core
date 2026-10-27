import { hostname } from "node:os";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { DelayedError, type Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import { type AgentDefinition, normalizeStoredDefinition } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { ConversationKind, KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { SettingsService } from "../identity/settings.js";
import { pinnedFailureText, recordSkillsCatalog } from "../skills/catalog.js";
import type { StorageService } from "../storage/storage.service.js";
import type { RunAbort, RunAbortBy, RunAbortDetail } from "./abort.js";
import type { KyselyCheckpointSaver } from "./checkpointer.js";
import type { ConversationLock, Lease } from "./conversation-lock.js";
import type { AgentLoop, LoopOutcome, SubagentParent, WaitingFor } from "./loop.js";
import { RunError, type StreamSink } from "./model-call.js";
import { ORG_QUOTA_LEASE_MS, type OrgQuota, orgRunLimit } from "./quota.js";
import { type FinishRunArgs, finishRun, TERMINAL_STATUSES } from "./run-finish.js";
import {
  bullConnection,
  RUN_QUEUE_NAME,
  type RunJobData,
  type RunQueue,
  SUBAGENT_RUN_QUEUE_NAME,
} from "./run-queue.js";
import { dispatchOfChildRun } from "./subagents/child.js";
import { childRunDefinition } from "./subagents/definition.js";
import type { Waits } from "./waits.js";

/** 会话锁被占用时任务延后的时间。 */
const LOCK_BUSY_DELAY_MS = 1000;
/** 组织配额已满时任务延后的时间。 */
const QUOTA_FULL_DELAY_MS = 2000;
/** BullMQ stalled 检测允许的最大次数（超过则任务失败）。 */
const MAX_STALLED_COUNT = 3;
/** 停机时等待任务结束后处理（ensureRun 等）的最短时间。 */
const FOLLOW_UP_MIN_WAIT_MS = 250;
/** 读插话的分页大小。 */
const READ_PAGE = 500;
/**
 * 任务结束后的 ensureRun 失败时的重试间隔（首次之外再试 3 次）。用进程内定时器：这是本进程刚完成的任务的
 * 后续处理，由 close() 跟踪并限时；全部失败也不会让会话永远卡住——打开 SSE / 读事件时会再次 ensureRun。
 */
const ENSURE_RETRY_DELAYS_MS = [200, 1000, 3000] as const;

/** 测试钩子与参数。 */
export interface RunHooks {
  /** 终态事件已写入、释放配额与会话锁之前调用（用于构造「运行结束瞬间到达的消息」）。 */
  beforeRelease?(runId: string, conversationId: string): Promise<void>;
  /** 会话锁 TTL（毫秒），默认 `runtime.jobLockMs`；测试调短以快速触发续租。 */
  lockTtlMs?: number;
  /** 任务结束后的每次 ensureRun 尝试之前调用（attempt 从 0 起）；抛错即模拟该次尝试失败。 */
  beforeEnsureRun?(conversationId: string, attempt: number): Promise<void>;
}

export interface RunWorkerDeps {
  db: KernelDb;
  eventLog: EventLog;
  lock: ConversationLock;
  quota: OrgQuota;
  abort: RunAbort;
  queue: Pick<RunQueue, "ensureRun">;
  settings: Pick<SettingsService, "get">;
  loop: AgentLoop;
  config: () => KernelConfig;
  log: Logger;
  redisUrl: string;
  /** 按会话取流式增量出口；默认丢弃。 */
  sinkFor?: (conversationId: string) => StreamSink;
  /** 运行到达终态后删除该运行（thread_id = runId）的 checkpoint thread（只用于续跑，结束后无用）。 */
  checkpoints?: Pick<KyselyCheckpointSaver, "deleteThread">;
  /** loop 返回 `suspended` 后把运行置为 waiting（释放会话锁与配额之后）。 */
  waits: Pick<Waits, "suspend">;
  /** 取得会话锁与配额、开始执行运行时调用（同步、不等待；渠道出站投递用它排投递任务）。 */
  onRunStart?: (conversationId: string) => void;
  hooks?: RunHooks;
  /** Object storage: run start reads the pinned skills' bodies from it (phase B). */
  storage?: StorageService;
  /**
   * After a sub-agent run's terminal state committed (sub-agents spec §7.3; `onChildFinished`):
   * reports it to the parent. Called with any run id whose conversation may be a child; it ignores
   * runs that were not dispatched. Errors are logged (the wait sweep repairs a missed call).
   */
  onChildFinished?: (runId: string) => Promise<void>;
  /**
   * After any terminal commit of a run that is not a sub-agent's (sub-agents spec §12): stops its
   * active children on its behalf (`stopChildren` with no account). The wait sweep is the backstop.
   */
  stopChildren?: (runId: string) => Promise<number>;
  /**
   * In the terminal transaction of every run: writes its open `agent` call results
   * (`ToolPipeline.stopOpenAgentCalls`; a no-op without dispatches); `fire` runs their observe
   * hooks after the commit (sub-agents spec §12, review m1: a failed or stalled parent too).
   */
  stopOpenCalls?: (t: Transaction<KernelDatabase>, runId: string) => Promise<{ fire: () => void }>;
}

/** 本进程正在执行的运行（本进程持有的资源）。 */
interface ActiveRun {
  shutdown: AbortController;
  /** 停机超出预算：放弃本进程的执行，交给 BullMQ stalled 机制由其他 worker 续跑。 */
  abandoned: boolean;
  /** 会话锁已丢失（续租发现被他人持有）：按停机处理，不写终态、不释放锁，任务回到队列。 */
  leaseLost: boolean;
  lease: Lease;
  /** 清除本运行的定时器（截止时间、配额续期）。 */
  stopTimers: () => void;
  done: Promise<void>;
  /** loop 返回 `suspended`：等待对象，以及暂停时是否已收到用户中止。 */
  suspended?: { waitingFor: WaitingFor; abort?: RunAbortBy };
}

/** 处理函数的返回值：`ensure` 表示任务完成后再调用一次 ensureRun。 */
type ProcessResult = "ensure" | undefined;

/**
 * `broken`：编排自身出错，已尽力标记失败。之后仍 ensureRun：标记成功时触发消息已被消费，只有更新的消息才起新一轮；
 * 标记也失败时运行停在 running，而任务此时已完成并移除，ensureRun 的孤儿清理会把它标记为失败——
 * 每一轮都要有新的用户消息，不会形成无限重试。
 */
type ExecResult = "finished" | "interrupted" | "abandoned" | "broken" | "suspended";

const noopSink: StreamSink = () => {};

/** 任务回到队列：延后 delayMs 再处理（不计入 attempts）。 */
async function requeue(
  job: Job<RunJobData>,
  token: string | undefined,
  delayMs: number,
): Promise<never> {
  await job.moveToDelayed(Date.now() + delayMs, token);
  throw new DelayedError();
}

/**
 * 运行 worker（只在含 `worker` 角色的进程启动）：领取 `cap-kernel-runs` 的任务，取会话锁与组织配额，
 * 调用 AgentLoop，按结果写终态事件并推进 `consumed_seq`；结束后再调用一次 `ensureRun` 处理
 * 运行期间到达但没被吸收的消息（Review Focus 2）。
 */
export class RunWorker {
  /** One BullMQ worker per run queue: conversation runs and sub-agent runs (spec §7.4). */
  private workers: Worker<RunJobData, ProcessResult>[] = [];
  /** 传给 Worker 的连接：BullMQ 不关闭调用方传入的连接，close() 时自己关。 */
  private conn: Redis | undefined;
  private readonly active = new Map<string, ActiveRun>();
  /** 进行中的「任务结束后」处理（完成后的 ensureRun、失败标记）：停机时等它们做完再关闭队列。 */
  private readonly followUps = new Set<Promise<unknown>>();
  private closing = false;
  /** close() 开始时触发：ensureRun 重试不再等待退避间隔。 */
  private readonly closingSignal = new AbortController();

  constructor(private readonly d: RunWorkerDeps) {}

  start(): void {
    if (this.workers.length > 0) return;
    const runtime = this.d.config().runtime;
    this.conn = bullConnection(this.d.redisUrl, this.d.log);
    for (const queue of [RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME]) {
      const worker = new Worker<RunJobData, ProcessResult>(
        queue,
        (job, token) => this.process(job, token),
        {
          // the worker name is recorded on the job (BullMQ processedBy): which replica ran it
          name: `${hostname()}-${process.pid}`,
          connection: this.conn,
          concurrency: runtime.workerConcurrency,
          lockDuration: runtime.jobLockMs,
          stalledInterval: runtime.stalledIntervalMs,
          maxStalledCount: MAX_STALLED_COUNT,
        },
      );
      // ensureRun after a run goes after its job completed and left the queue: when the latest
      // unconsumed message is this run's own trigger (e.g. a run ended by its deadline without
      // absorbing it, R34), the new job has this job's id and would be dropped as a duplicate
      // while this one is still active. Relies on BullMQ moving the job to completed (deleted by
      // removeOnComplete) before emitting "completed" (pinned by the R34 test).
      worker.on("completed", (job, result) => {
        if (result !== "ensure") return;
        const { conversationId, runId } = job.data;
        this.track(this.ensureAfterRun(conversationId, runId));
      });
      worker.on("error", (err) => this.d.log.error("run worker error", { err, queue }));
      worker.on("failed", (job, err) => {
        this.d.log.error("run job failed", { jobId: job?.id, runId: job?.data.runId, err });
        if (job) {
          this.track(
            this.onJobFailed(job.data, err).catch((e) =>
              this.d.log.error("cannot mark failed run job", { runId: job.data.runId, err: e }),
            ),
          );
        }
      });
      this.workers.push(worker);
    }
  }

  /** Stops the active children of a finished run (see {@link RunWorkerDeps.stopChildren}). */
  private async stopChildren(runId: string): Promise<void> {
    if (!this.d.stopChildren) return;
    try {
      await this.d.stopChildren(runId);
    } catch (err) {
      this.d.log.error("cannot stop the sub-agents of a finished run", { runId, err });
    }
  }

  /** Reports a finished sub-agent run to its parent (see {@link RunWorkerDeps.onChildFinished}). */
  private async childFinished(runId: string): Promise<void> {
    if (!this.d.onChildFinished) return;
    try {
      await this.d.onChildFinished(runId);
    } catch (err) {
      this.d.log.error("cannot report finished sub-agent run to its parent", { runId, err });
    }
  }

  /**
   * 任务结束后的 ensureRun，失败按 {@link ENSURE_RETRY_DELAYS_MS} 退避重试；停机开始后不再等待间隔
   * （剩余的尝试立即进行，close() 以剩余预算为限等待）。全部失败只记日志，不抛出。
   */
  private async ensureAfterRun(conversationId: string, runId: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.d.hooks?.beforeEnsureRun?.(conversationId, attempt);
        await this.d.queue.ensureRun(conversationId);
        return;
      } catch (err) {
        const delay = ENSURE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.d.log.error("ensureRun after run failed; giving up", {
            conversationId,
            runId,
            attempts: attempt + 1,
            err,
          });
          return;
        }
        this.d.log.warn("ensureRun after run failed; retrying", {
          conversationId,
          runId,
          attempt,
          err,
        });
        await this.retryDelay(delay);
      }
    }
  }

  /** 等待 ms 毫秒；停机开始时立即返回。 */
  private retryDelay(ms: number): Promise<void> {
    const signal = this.closingSignal.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      t.unref();
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** 登记一个任务结束后的处理，做完自动移除。 */
  private track(p: Promise<unknown>): void {
    this.followUps.add(p);
    void p.finally(() => this.followUps.delete(p));
  }

  /**
   * BullMQ 判定任务失败（R29）：stalled 次数超过上限（持有者反复崩溃），或处理函数在自己的终态处理之外抛错。
   * 运行若仍未结束：清理死去持有者留下的会话锁，写 `run_failed`（stalled → `run.stalled`，
   * 其他 → `run.internal`），status 置为 failed，consumed_seq 至少推进到触发消息，删除 checkpoint，然后 ensureRun（带重试）。
   */
  private async onJobFailed(data: RunJobData, err: Error): Promise<void> {
    const { runId, conversationId } = data;
    const stalled = /stalled/i.test(err.message);
    await this.d.lock.releaseFor(conversationId, runId);
    // 运行已进入 waiting（暂停后任务才失败）：它有自己的续跑路径（人工决定 / 超时任务），不标记失败。
    const cur = await this.d.db
      .selectFrom("runs")
      .select("status")
      .where("id", "=", runId)
      .executeTakeFirst();
    if (cur?.status === "waiting") {
      this.d.log.warn("run job failed after the run was suspended; leaving it waiting", { runId });
      return;
    }
    await this.finish(
      conversationId,
      runId,
      "failed",
      null,
      {
        type: "run_failed",
        payload: {
          error: stalled
            ? {
                code: "run.stalled",
                message: "The run was interrupted too many times and will not continue",
              }
            : { code: "run.internal", message: "The run failed unexpectedly" },
        },
      },
      false,
    );
    await this.dropCheckpoints(runId);
    // the kind is not loaded here: both are no-ops for the other kind
    await this.childFinished(runId);
    await this.stopChildren(runId);
    await this.ensureAfterRun(conversationId, runId);
  }

  /**
   * 优雅停机：停止领取新任务 → 向本进程的运行发停机信号（loop 在下一个步骤边界返回 `interrupted`，
   * 任务回到队列）→ 在 budgetMs 内等它们结束。超出预算的运行放弃执行（停止续租会话锁、强制关闭
   * worker，不再续任务锁），由 BullMQ 的 stalled 机制交给其他 worker 续跑。
   */
  async close(budgetMs: number): Promise<void> {
    const workers = this.workers;
    if (workers.length === 0) return;
    const deadline = Date.now() + Math.max(0, budgetMs);
    this.workers = [];
    this.closing = true;
    this.closingSignal.abort();
    await Promise.all(
      workers.map((w) =>
        w.pause(true).catch((err) => this.d.log.warn("run worker pause failed", { err })),
      ),
    );
    for (const a of this.active.values()) a.shutdown.abort();
    const all = Promise.all([...this.active.values()].map((a) => a.done));
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      all.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, budgetMs));
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (!finished) {
      for (const [runId, a] of this.active) {
        a.abandoned = true;
        a.lease.abandon();
        a.stopTimers();
        this.d.log.warn(
          "run did not reach a step boundary before shutdown; leaving it to another worker",
          {
            runId,
          },
        );
      }
    }
    await Promise.all(workers.map((w) => w.close(!finished)));
    // 关闭期间完成 / 失败的任务登记的后续处理（ensureRun 等）要在调用方关闭运行队列之前做完，
    // 否则投递半途被打断，待处理的消息无人处理。以剩余预算为限（至少留一点时间）。
    if (this.followUps.size > 0) {
      let t: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.followUps]),
        new Promise<void>((resolve) => {
          t = setTimeout(resolve, Math.max(FOLLOW_UP_MIN_WAIT_MS, deadline - Date.now()));
          t.unref();
        }),
      ]);
      clearTimeout(t);
    }
    const conn = this.conn;
    this.conn = undefined;
    if (conn) await conn.quit().catch(() => conn.disconnect());
  }

  private async process(job: Job<RunJobData>, token: string | undefined): Promise<ProcessResult> {
    const { runId, conversationId } = job.data;
    if (this.closing) return requeue(job, token, 0);
    const run = await this.d.db
      .selectFrom("runs")
      .select([
        "id",
        "status",
        "agent_version",
        "trigger_account_id",
        "trigger_seq",
        "started_at",
        "waited_ms",
      ])
      .where("id", "=", runId)
      .executeTakeFirst();
    // 重复投递的任务发现运行已不存在或已结束（例如上一个处理者写完终态后、做后续检查前崩溃）：
    // 仍做一次结束后的 ensureRun，避免那时到达的消息无人处理。
    if (!run || TERMINAL_STATUSES.has(run.status)) {
      await this.dropCheckpoints(runId);
      // a sub-agent run whose finisher may have crashed before reporting to the parent (idempotent)
      if (run) await this.childFinished(runId);
      return "ensure";
    }
    // 运行在等人处理（例如暂停后本任务被 stalled 机制重新投递）：不执行，续跑由处理 / 超时发起的新任务负责。
    if (run.status === "waiting") return;
    const conv = await this.d.db
      .selectFrom("conversations")
      .select(["org_id", "agent_id", "kind"])
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (!conv) return;

    // 会话锁 TTL 与任务锁一致：持有者崩溃后，任务被判定 stalled 时会话锁也差不多同时过期。
    const lease = await this.d.lock.acquire(
      conversationId,
      runId,
      this.d.hooks?.lockTtlMs ?? this.d.config().runtime.jobLockMs,
    );
    if (!lease) return requeue(job, token, LOCK_BUSY_DELAY_MS);

    let settle!: () => void;
    const state: ActiveRun = {
      shutdown: new AbortController(),
      abandoned: false,
      leaseLost: false,
      lease,
      stopTimers: () => {},
      done: new Promise<void>((r) => {
        settle = r;
      }),
    };
    this.active.set(runId, state);
    // 停机开始后才登记的运行（close() 的快照之后）：同样在步骤边界停下。
    if (this.closing) state.shutdown.abort();
    // 锁丢失（R27）：走与停机相同的路径——loop 在下一个步骤边界返回 interrupted，任务回到队列。
    lease.onLost(() => {
      state.leaseLost = true;
      state.shutdown.abort();
    });
    let entered = false;
    let delayMs: number | null = null;
    try {
      const limit = await orgRunLimit(this.d.settings, this.d.config, conv.org_id);
      entered = await this.d.quota.tryEnter(conv.org_id, runId, limit, ORG_QUOTA_LEASE_MS);
      if (!entered) {
        delayMs = QUOTA_FULL_DELAY_MS;
      } else {
        // 运行开始执行（含续跑、stalled 后接手）：通知旁路（渠道出站投递据此把输出投到 IM），失败不影响运行
        try {
          this.d.onRunStart?.(conversationId);
        } catch (err) {
          this.d.log.warn("onRunStart hook failed", { conversationId, err });
        }
        const r = await this.execute(run, { id: conversationId, ...conv }, state).catch(
          async (err: unknown): Promise<ExecResult> => {
            if (state.abandoned) return "abandoned";
            if (state.leaseLost) return "interrupted";
            // 编排自身出错（如写事件失败）：尽力把运行标记为失败，避免会话卡在 running。
            this.d.log.error("run orchestration failed", { conversationId, runId, err });
            await this.finish(conversationId, runId, "failed", null, {
              type: "run_failed",
              payload: { error: { code: "run.internal", message: "The run failed unexpectedly" } },
            }).catch((e) => this.d.log.error("cannot mark run as failed", { runId, err: e }));
            return "broken";
          },
        );
        if (r === "interrupted") delayMs = 0;
      }
    } finally {
      state.stopTimers();
      if (!state.abandoned) {
        if (entered) {
          await this.d.quota
            .leave(conv.org_id, runId)
            .catch((err) => this.d.log.warn("org quota leave failed", { runId, err }));
        }
        // 锁已丢失时不释放（已不属于本运行；RELEASE 虽比对 runId，这里也不再触碰）。
        if (!state.leaseLost) {
          await lease
            .release()
            .catch((err) => this.d.log.warn("conversation lock release failed", { runId, err }));
        }
      }
      this.active.delete(runId);
      settle();
    }
    if (state.abandoned) return;
    if (delayMs !== null) return requeue(job, token, delayMs);
    // 暂停：会话锁与配额已释放，checkpoint 保留；置 waiting 并投递超时任务。任务就此完成，不 ensureRun
    // （等待期间的新消息在续跑后作为插话吸收）。
    if (state.suspended) {
      await this.d.waits.suspend(
        runId,
        conversationId,
        state.suspended.waitingFor,
        state.suspended.abort,
      );
      return;
    }
    // 运行已到达终态（broken 时已尽力标记失败）：checkpoint 只用于续跑，删除。
    await this.dropCheckpoints(runId);
    if (conv.kind === "subagent") await this.childFinished(runId);
    else await this.stopChildren(runId);
    return "ensure";
  }

  private async execute(
    run: {
      id: string;
      status: string;
      agent_version: number;
      trigger_account_id: string;
      trigger_seq: string;
      started_at: Date | null;
      waited_ms: string;
    },
    conv: { id: string; org_id: string; agent_id: string; kind: ConversationKind },
    state: ActiveRun,
  ): Promise<ExecResult> {
    const runId = run.id;
    const conversationId = conv.id;
    const runtime = this.d.config().runtime;
    let agent: AgentDefinition;
    let maxSteps = runtime.maxSteps;
    let parent: SubagentParent | undefined;
    if (conv.kind === "subagent") {
      // a sub-agent runs its effective definition frozen at dispatch, never agent_versions
      // (spec §6.3), and works for the parent call that dispatched this run
      const started = await this.d.eventLog.findByIdem(conversationId, "subagent_started");
      if (started?.type !== "subagent_started") {
        throw new Error(`sub-agent conversation ${conversationId} has no subagent_started`);
      }
      // a follow-up runs with its task message's narrowing (final review I1): the frozen tools
      // and org skills the current version still allows, recorded at its dispatch
      const trigger = (
        await this.d.eventLog.readAfter(conversationId, Number(run.trigger_seq) - 1, 1)
      )[0];
      agent = childRunDefinition(
        normalizeStoredDefinition(started.payload.definition),
        trigger?.type === "user_message" && trigger.seq === Number(run.trigger_seq)
          ? trigger.payload.dispatch?.narrowed
          : undefined,
      );
      maxSteps = Math.min(started.payload.maxSteps, runtime.maxSteps);
      const row = await dispatchOfChildRun(this.d.db, runId);
      const otherAgent = started.payload.template.source === "agent";
      parent = row
        ? {
            conversationId: row.parentConversationId,
            runId: row.parentRunId,
            callId: row.parentCallId,
            otherAgent,
          }
        : {
            conversationId: started.payload.parent.conversationId,
            runId: started.payload.parent.runId,
            callId: started.payload.parent.callId,
            otherAgent,
          };
    } else {
      const version = await this.d.db
        .selectFrom("agent_versions")
        .select("definition")
        .where("agent_id", "=", conv.agent_id)
        .where("version", "=", run.agent_version)
        .executeTakeFirstOrThrow();
      agent = normalizeStoredDefinition(version.definition);
    }

    let startedAt = run.started_at;
    if (run.status === "queued" || startedAt === null) {
      await this.d.eventLog.append(conversationId, [
        {
          type: "run_started",
          runId,
          idemKey: `run_started:${runId}`,
          payload: {
            agentVersion: run.agent_version,
            model: agent.model,
            triggerAccountId: run.trigger_account_id,
          },
        },
      ]);
      // 技能目录快照（Ruling M17）：在置为 running 之前写，崩溃重试时仍走这里（幂等键去重）
      try {
        await recordSkillsCatalog(
          {
            db: this.d.db,
            eventLog: this.d.eventLog,
            log: this.d.log,
            ...(this.d.storage !== undefined && { storage: this.d.storage }),
          },
          {
            orgId: conv.org_id,
            agentId: conv.agent_id,
            conversationId,
            runId,
            agent,
          },
        );
      } catch (e) {
        // Pinned skill bodies could not be read (Decision 9), or the pinned skills kept changing
        // while they were read (`conflict`): fail before any model request. A transient failure
        // or a conflict is fixed by sending again; a permanent one names the skill for the owner
        // (`recordSkillsCatalog` already logged it at error). Other errors take the generic path.
        if (
          !(e instanceof ApiError) ||
          (e.code !== "storage.unavailable" && e.code !== "conflict")
        ) {
          throw e;
        }
        this.d.log.warn("skills catalog not recorded at run start", {
          conversationId,
          runId,
          code: e.code,
          err: e,
        });
        const message = e.code === "conflict" ? e.message : pinnedFailureText(e);
        await this.finish(conversationId, runId, "failed", null, {
          type: "run_failed",
          payload: { error: { code: e.code, message } },
        });
        return "finished";
      }
      const updated = await this.d.db
        .updateTable("runs")
        .set({ status: "running", started_at: sql<Date>`COALESCE(started_at, now())` })
        .where("id", "=", runId)
        .returning("started_at")
        .executeTakeFirstOrThrow();
      startedAt = updated.started_at as Date;
    }
    // 截止时间以首次开始为准：停机后在其他 worker 续跑也不重新计时；等人处理的时长（waited_ms）不计入。
    const deadline = startedAt.getTime() + Number(run.waited_ms) + runtime.maxRunSeconds * 1000;

    const ac = new AbortController();
    let abortedBy: string | null | undefined;
    let abortDetail: RunAbortDetail | undefined;
    let deadlineHit = false;
    const deadlineTimer = setTimeout(
      () => {
        deadlineHit = true;
        ac.abort();
      },
      Math.max(0, deadline - Date.now()),
    );
    const quotaTimer = setInterval(() => {
      this.d.quota
        .renew(conv.org_id, runId, ORG_QUOTA_LEASE_MS)
        .then((ok) => {
          if (!ok) this.d.log.warn("org quota lease lost", { runId, orgId: conv.org_id });
        })
        .catch((err) => this.d.log.warn("org quota renew failed", { runId, err }));
    }, ORG_QUOTA_LEASE_MS / 3);
    quotaTimer.unref();
    state.stopTimers = () => {
      clearTimeout(deadlineTimer);
      clearInterval(quotaTimer);
    };

    let unwatch: (() => Promise<void>) | undefined;
    try {
      unwatch = await this.d.abort.watch(runId, (by, detail) => {
        abortedBy = by;
        abortDetail = detail;
        ac.abort();
      });

      // 取得会话锁之后再读 consumed_seq（锁内不会有别的运行推进它）。
      const { consumed_seq } = await this.d.db
        .selectFrom("conversations")
        .select("consumed_seq")
        .where("id", "=", conversationId)
        .executeTakeFirstOrThrow();
      const startConsumed = Number(consumed_seq);
      let absorbed = startConsumed;
      const pendingUserMessages = async (afterSeq: number): Promise<ConversationEvent[]> => {
        // loop 声明已吸收到 afterSeq（续跑时来自 checkpoint，可能包含之前进程吸收的消息）。
        absorbed = Math.max(absorbed, afterSeq);
        const out: ConversationEvent[] = [];
        let after = Math.max(afterSeq, startConsumed);
        for (;;) {
          const page = await this.d.eventLog.readAfter(conversationId, after, READ_PAGE);
          for (const e of page) if (e.type === "user_message") out.push(e);
          const last = page.at(-1);
          if (page.length < READ_PAGE || !last) break;
          after = last.seq;
        }
        for (const e of out) absorbed = Math.max(absorbed, e.seq);
        return out;
      };

      let outcome: LoopOutcome;
      try {
        outcome = await this.d.loop.run({
          orgId: conv.org_id,
          conversationId,
          runId,
          agentId: conv.agent_id,
          triggerAccountId: run.trigger_account_id,
          agent,
          agentVersion: run.agent_version,
          signal: ac.signal,
          shutdown: state.shutdown.signal,
          sink: this.d.sinkFor?.(conversationId) ?? noopSink,
          pendingUserMessages,
          limits: { maxSteps, deadline },
          // a sub-agent's conversation fires hooks like a chat, with `parent` set (spec §11)
          conversationKind:
            conv.kind === "eval" ? "eval" : conv.kind === "subagent" ? "subagent" : "chat",
          ...(parent !== undefined && { parent }),
        });
      } catch (e) {
        if (state.abandoned) return "abandoned";
        if (state.leaseLost) return "interrupted";
        const err =
          e instanceof RunError ? e : new RunError("run.internal", "The run failed unexpectedly");
        if (!(e instanceof RunError)) {
          this.d.log.error("agent loop threw", { conversationId, runId, err: e });
        }
        // 失败也推进 consumed_seq 到已吸收的位置：否则结束时的 ensureRun 会对同一条消息无限重试；
        // 用户看到 run_failed 后可以重发。
        await this.finish(conversationId, runId, "failed", absorbed, {
          type: "run_failed",
          payload: { error: { code: err.code, message: err.message } },
        });
        return "finished";
      }
      if (state.abandoned) return "abandoned";
      // 锁在运行中丢失：无论 loop 返回什么都不写终态，任务回到队列由持锁者续跑。
      if (state.leaseLost) return "interrupted";

      // loop 因截止时间停下但按中止返回：按超时收尾。
      if (outcome.kind === "aborted" && abortedBy === undefined && deadlineHit) {
        outcome = { kind: "max_duration", consumedUpToSeq: absorbed };
      }
      switch (outcome.kind) {
        case "interrupted":
          return "interrupted";
        case "suspended":
          // 暂停与用户中止同时发生：仍先置 waiting，再按「等待中中止」取消等待并结束（见 Waits.suspend）。
          state.suspended = {
            waitingFor: outcome.waitingFor,
            ...(abortedBy !== undefined && {
              abort: {
                byAccountId: abortedBy,
                ...(abortDetail !== undefined && { detail: abortDetail }),
              },
            }),
          };
          return "suspended";
        case "aborted":
          await this.finish(conversationId, runId, "aborted", absorbed, {
            type: "run_aborted",
            payload: {
              byAccountId: abortedBy ?? null,
              reason: "user",
              ...(abortDetail !== undefined && { detail: abortDetail }),
            },
          });
          break;
        case "max_duration": {
          // 超时只消费 loop 实际吸收的消息，不按触发消息兜底（R34）：截止时间可能在第一次吸收之前就已过
          // （如续跑时已超过 started_at + maxRunSeconds），这些消息没有被回复，留给结束后的 ensureRun 起新一轮。
          const consumed = Math.max(outcome.consumedUpToSeq, startConsumed);
          await this.finish(
            conversationId,
            runId,
            "completed",
            consumed,
            { type: "run_finished", payload: { reason: outcome.kind, consumedUpToSeq: consumed } },
            true,
            false,
          );
          break;
        }
        default: {
          // completed / max_steps / budget: the loop always absorbed the trigger message; still
          // floor to it
          const consumed = Math.max(outcome.consumedUpToSeq, Number(run.trigger_seq));
          await this.finish(conversationId, runId, "completed", consumed, {
            type: "run_finished",
            payload: { reason: outcome.kind, consumedUpToSeq: consumed },
          });
        }
      }
      return "finished";
    } finally {
      state.stopTimers();
      await unwatch?.().catch((err) => this.d.log.warn("abort unwatch failed", { runId, err }));
    }
  }

  /** 删除已结束运行的 checkpoint thread（失败只记日志）。 */
  private async dropCheckpoints(runId: string): Promise<void> {
    await this.d.checkpoints
      ?.deleteThread(runId)
      .catch((err) => this.d.log.warn("checkpoint delete failed", { runId, err }));
  }

  /**
   * 写终态（见 `finishRun`：运行仍未结束才写，同一事务内推进 `consumed_seq` 并更新 `runs.status`），
   * 提交后发布会话通知，然后调用测试钩子。返回终态事件 seq；运行已是终态 → null。
   */
  private async finish(
    conversationId: string,
    runId: string,
    status: FinishRunArgs["status"],
    consumed: number | null,
    event: FinishRunArgs["event"],
    hook = true,
    floorToTrigger = true,
  ): Promise<number | null> {
    const stopOpen = this.d.stopOpenCalls;
    let fire = () => {};
    const toSeq = await finishRun(this.d.db, this.d.eventLog, {
      conversationId,
      runId,
      status,
      consumed,
      event,
      floorToTrigger,
      ...(stopOpen !== undefined && {
        beforeTerminal: async (t) => {
          fire = (await stopOpen(t, runId)).fire;
        },
      }),
    });
    if (toSeq !== null) fire();
    if (hook) await this.d.hooks?.beforeRelease?.(runId, conversationId);
    return toSeq;
  }
}
