import type { Logger } from "@capybara-hq/plugin-sdk";
import { DelayedError, type Job, Worker } from "bullmq";
import { sql } from "kysely";
import type { AgentDefinition } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { KernelDb } from "../db/kernel-schema.js";
import type { SettingsService } from "../identity/settings.js";
import type { RunAbort } from "./abort.js";
import {
  CONVERSATION_LOCK_TTL_MS,
  type ConversationLock,
  type Lease,
} from "./conversation-lock.js";
import type { AgentLoop, LoopOutcome } from "./loop.js";
import { RunError, type StreamSink } from "./model-call.js";
import { ORG_QUOTA_LEASE_MS, type OrgQuota, orgRunLimit } from "./quota.js";
import { bullConnection, RUN_QUEUE_NAME, type RunJobData, type RunQueue } from "./run-queue.js";

/** 会话锁被占用时任务延后的时间。 */
const LOCK_BUSY_DELAY_MS = 1000;
/** 组织配额已满时任务延后的时间。 */
const QUOTA_FULL_DELAY_MS = 2000;
/** BullMQ stalled 检测允许的最大次数（超过则任务失败）。 */
const MAX_STALLED_COUNT = 3;
/** 读插话的分页大小。 */
const READ_PAGE = 500;

const TERMINAL = new Set(["completed", "failed", "aborted"]);

/** 测试钩子与参数。 */
export interface RunHooks {
  /** 终态事件已写入、释放配额与会话锁之前调用（用于构造「运行结束瞬间到达的消息」）。 */
  beforeRelease?(runId: string, conversationId: string): Promise<void>;
  /** 会话锁 TTL（毫秒），默认 `CONVERSATION_LOCK_TTL_MS`；测试调短以快速触发续租。 */
  lockTtlMs?: number;
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
  /** 流式增量出口；默认丢弃（SSE 推送在后续任务接入）。 */
  sink?: StreamSink;
  hooks?: RunHooks;
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
}

/** `broken`：编排自身出错，已尽力标记失败；不再 ensureRun（避免持续性错误造成无限重试）。 */
type ExecResult = "finished" | "interrupted" | "abandoned" | "broken";

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
  private worker: Worker<RunJobData> | undefined;
  private readonly active = new Map<string, ActiveRun>();
  private closing = false;

  constructor(private readonly d: RunWorkerDeps) {}

  start(): void {
    if (this.worker) return;
    const runtime = this.d.config().runtime;
    this.worker = new Worker<RunJobData>(RUN_QUEUE_NAME, (job, token) => this.process(job, token), {
      connection: bullConnection(this.d.redisUrl, this.d.log),
      concurrency: runtime.workerConcurrency,
      lockDuration: runtime.jobLockMs,
      stalledInterval: runtime.stalledIntervalMs,
      maxStalledCount: MAX_STALLED_COUNT,
    });
    this.worker.on("error", (err) => this.d.log.error("run worker error", { err }));
    this.worker.on("failed", (job, err) =>
      this.d.log.error("run job failed", { jobId: job?.id, runId: job?.data.runId, err }),
    );
  }

  /**
   * 优雅停机：停止领取新任务 → 向本进程的运行发停机信号（loop 在下一个步骤边界返回 `interrupted`，
   * 任务回到队列）→ 在 budgetMs 内等它们结束。超出预算的运行放弃执行（停止续租会话锁、强制关闭
   * worker，不再续任务锁），由 BullMQ 的 stalled 机制交给其他 worker 续跑。
   */
  async close(budgetMs: number): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.closing = true;
    await worker.pause(true).catch((err) => this.d.log.warn("run worker pause failed", { err }));
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
    await worker.close(!finished);
  }

  private async process(job: Job<RunJobData>, token: string | undefined): Promise<void> {
    const { runId, conversationId } = job.data;
    if (this.closing) return requeue(job, token, 0);
    const run = await this.d.db
      .selectFrom("runs")
      .select(["id", "status", "agent_version", "trigger_account_id", "trigger_seq", "started_at"])
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!run || TERMINAL.has(run.status)) return;
    const conv = await this.d.db
      .selectFrom("conversations")
      .select(["org_id", "agent_id"])
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (!conv) return;

    const lease = await this.d.lock.acquire(
      conversationId,
      runId,
      this.d.hooks?.lockTtlMs ?? CONVERSATION_LOCK_TTL_MS,
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
    let broken = false;
    try {
      const limit = await orgRunLimit(this.d.settings, this.d.config, conv.org_id);
      entered = await this.d.quota.tryEnter(conv.org_id, runId, limit, ORG_QUOTA_LEASE_MS);
      if (!entered) {
        delayMs = QUOTA_FULL_DELAY_MS;
      } else {
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
        broken = r === "broken";
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
    if (broken) return;
    try {
      await this.d.queue.ensureRun(conversationId);
    } catch (err) {
      this.d.log.error("ensureRun after run failed", { conversationId, runId, err });
    }
  }

  private async execute(
    run: {
      id: string;
      status: string;
      agent_version: number;
      trigger_account_id: string;
      trigger_seq: string;
      started_at: Date | null;
    },
    conv: { id: string; org_id: string; agent_id: string },
    state: ActiveRun,
  ): Promise<ExecResult> {
    const runId = run.id;
    const conversationId = conv.id;
    const runtime = this.d.config().runtime;
    const version = await this.d.db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", conv.agent_id)
      .where("version", "=", run.agent_version)
      .executeTakeFirstOrThrow();
    const agent = version.definition as unknown as AgentDefinition;

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
      const updated = await this.d.db
        .updateTable("runs")
        .set({ status: "running", started_at: sql<Date>`COALESCE(started_at, now())` })
        .where("id", "=", runId)
        .returning("started_at")
        .executeTakeFirstOrThrow();
      startedAt = updated.started_at as Date;
    }
    // 截止时间以首次开始为准：停机后在其他 worker 续跑也不重新计时。
    const deadline = startedAt.getTime() + runtime.maxRunSeconds * 1000;

    const ac = new AbortController();
    let abortedBy: string | null | undefined;
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
      unwatch = await this.d.abort.watch(runId, (by) => {
        abortedBy = by;
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
          conversationId,
          runId,
          agent,
          agentVersion: run.agent_version,
          signal: ac.signal,
          shutdown: state.shutdown.signal,
          sink: this.d.sink ?? noopSink,
          pendingUserMessages,
          limits: { maxSteps: runtime.maxSteps, deadline },
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
        case "aborted":
          await this.finish(conversationId, runId, "aborted", absorbed, {
            type: "run_aborted",
            payload: { byAccountId: abortedBy ?? null, reason: "user" },
          });
          break;
        default: {
          // 至少消费到触发消息（如续跑时已过截止时间、loop 一条都没吸收）。
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

  /**
   * 写终态事件，同一事务内推进 `consumed_seq` 并更新 `runs.status`；提交后发布会话通知，然后调用测试钩子。
   * `consumed_seq = GREATEST(consumed_seq, consumed, runs.trigger_seq)`：不回退，且任何终态都至少消费到
   * 触发该运行的消息——否则结束时的 ensureRun 会对同一条消息无限重试（失败）或卡住会话。
   */
  private async finish(
    conversationId: string,
    runId: string,
    status: "completed" | "failed" | "aborted",
    consumed: number | null,
    event: Pick<AppendEvent, "type" | "payload">,
  ): Promise<void> {
    const toSeq = await this.d.db.transaction().execute(async (t) => {
      const [ev] = await this.d.eventLog.append(
        conversationId,
        [{ ...event, runId, idemKey: `${event.type}:${runId}` }],
        t,
      );
      await t
        .updateTable("conversations")
        .set({
          consumed_seq: sql`GREATEST(consumed_seq, ${consumed ?? 0}::bigint, (SELECT r.trigger_seq FROM capybara.runs r WHERE r.id = ${runId}))`,
        })
        .where("id", "=", conversationId)
        .execute();
      await t
        .updateTable("runs")
        .set({ status, finished_at: sql`now()` })
        .where("id", "=", runId)
        .execute();
      return (ev as ConversationEvent).seq;
    });
    await this.d.eventLog.notify(conversationId, toSeq);
    await this.d.hooks?.beforeRelease?.(runId, conversationId);
  }
}
