import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { EventLog } from "../conversations/event-log.js";
import type { ConversationKind, KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { KyselyCheckpointSaver } from "./checkpointer.js";
import { ConversationLock } from "./conversation-lock.js";
import { QueueLostJobs } from "./queue-lost-jobs.js";
import { notifyFinished, RunFinish } from "./run-finish.js";
import { RunJobs, runJobId, runQueueNameFor } from "./run-jobs.js";
import { RunQueue } from "./run-queue.js";
import { Waits } from "./waits.js";

/** The check's `@LockedInterval` job name (its run lock key: `cron:run-orphan-check`). */
export const RUN_ORPHAN_CHECK_JOB = "run-orphan-check";

/** The check's period: a fixed constant, not a config field. */
export const RUN_ORPHAN_CHECK_PERIOD_MS = 60_000;

/**
 * How long a run must have been in its state (queued, or running since its last start) before it
 * can count as an orphan: a transition in flight is never repaired.
 */
export const RUN_ORPHAN_MIN_AGE_MS = 60_000;

/** The candidates one page of a pass reads (a keyset page over the state's start time and id). */
export const RUN_ORPHAN_CHECK_BATCH = 500;

/**
 * The most pages one pass reads: a bound on its work. Healthy long runs and queued runs waiting
 * for a quota slot are passed over page by page, so a real orphan behind them is still reached;
 * beyond this many candidates the rest wait for the next minute.
 */
export const RUN_ORPHAN_CHECK_MAX_PAGES = 10;

/** The error the canary logs (transactional outbox spec §8.3). */
export const QUEUE_LOST_JOBS_MESSAGE = "queued run without a job: the queue lost jobs";

/** What one pass of {@link RunOrphanCheck.check} repaired. */
export interface RunOrphanCheckResult {
  /** `running` runs nobody runs, failed `run.orphaned`. */
  runningRepaired: number;
  /** `queued` runs whose job was lost, owed again (each one is the canary). */
  queuedReadded: number;
}

/** An active run that may be an orphan, with where its job lives. */
export interface OrphanCandidate {
  runId: string;
  conversationId: string;
  orgId: string;
  kind: ConversationKind;
  status: "queued" | "running";
  /** The run's job id (a resume's `runs.job_id`, else its trigger's) and queue. */
  jobId: string;
  queue: string;
  /** When the run entered its state, as PG prints it (compared again in the repair). */
  since: string;
}

/** The SQL of the time a run entered its current state (queued, or its last start). */
const SINCE = sql<Date>`GREATEST(COALESCE(r.queued_at, r.created_at), COALESCE(r.started_at, r.created_at))`;

/**
 * One page of the active runs of chat and sub-agent conversations in `statuses` that entered their
 * state more than `minAgeMs` ago, by (state start, id), after `after` (an eval's hidden
 * conversation drives its runs itself).
 */
export async function orphanCandidates(
  db: KernelSchemaDb,
  statuses: readonly ("queued" | "running")[],
  minAgeMs: number,
  limit: number,
  after?: Pick<OrphanCandidate, "since" | "runId">,
): Promise<OrphanCandidate[]> {
  let q = db
    .selectFrom("runs as r")
    .innerJoin("conversations as c", "c.id", "r.conversation_id")
    .select([
      "r.id",
      "r.conversation_id",
      "r.status",
      "r.job_id",
      "r.trigger_seq",
      "c.kind",
      "c.org_id",
      sql<string>`${SINCE}::text`.as("since"),
    ])
    .where("r.status", "in", statuses)
    .where("c.kind", "in", ["chat", "subagent"])
    .where(SINCE, "<", sql<Date>`now() - ${minAgeMs}::integer * interval '1 millisecond'`);
  if (after !== undefined) {
    q = q.where(sql<boolean>`(${SINCE}, r.id) > (${after.since}::timestamptz, ${after.runId})`);
  }
  const rows = await q.orderBy(SINCE).orderBy("r.id").limit(limit).execute();
  return rows.map((r) => ({
    runId: r.id,
    conversationId: r.conversation_id,
    orgId: r.org_id,
    kind: r.kind,
    status: r.status as "queued" | "running",
    jobId: r.job_id ?? runJobId(r.conversation_id, Number(r.trigger_seq)),
    queue: runQueueNameFor(r.kind),
    since: r.since,
  }));
}

/**
 * Whether the outbox holds the job `jobId` on `queue`: a pending row (it is still owed) or a dead
 * one (the outbox gave up on it; the super admin sees it under `outbox_dead` and retries or
 * discards it, so it is not a job the queue lost).
 */
export async function jobInOutbox(
  db: KernelSchemaDb,
  queue: string,
  jobId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("outbox")
    .select("id")
    .where("queue", "=", queue)
    .where("job_id", "=", jobId)
    .executeTakeFirst();
  return row !== undefined;
}

/** Every page of {@link orphanCandidates}, at most {@link RUN_ORPHAN_CHECK_MAX_PAGES}. */
async function* candidatePages(
  db: KernelSchemaDb,
  statuses: readonly ("queued" | "running")[],
  minAgeMs: number,
): AsyncGenerator<OrphanCandidate[]> {
  let after: OrphanCandidate | undefined;
  for (let page = 0; page < RUN_ORPHAN_CHECK_MAX_PAGES; page++) {
    const rows = await orphanCandidates(db, statuses, minAgeMs, RUN_ORPHAN_CHECK_BATCH, after);
    if (rows.length > 0) yield rows;
    if (rows.length < RUN_ORPHAN_CHECK_BATCH) return;
    after = rows[rows.length - 1];
  }
}

/**
 * The `queued` runs (in their state for over `minAgeMs`) whose job is neither in the outbox (owed,
 * or dead) nor in BullMQ (`jobExists`), and that are still queued after both looks: the run queue
 * lost their jobs. The outbox is read before BullMQ (a row is deleted only after its job was added)
 * and the run again after both (a job that finished took its run out of `queued` first), so a run
 * in flight is never reported. The `run-orphan-check` uses it; so does the dual-replica test
 * harness, which asserts at its teardown that the kernel left none (`minAgeMs` 0).
 */
export async function queuedRunsWithoutJob(
  db: KernelSchemaDb,
  jobExists: (queue: string, jobId: string) => Promise<boolean>,
  opts: { minAgeMs: number },
): Promise<OrphanCandidate[]> {
  const out: OrphanCandidate[] = [];
  for await (const page of candidatePages(db, ["queued"], opts.minAgeMs)) {
    for (const c of page) {
      if (await jobInOutbox(db, c.queue, c.jobId)) continue;
      if (await jobExists(c.queue, c.jobId)) continue;
      const now = await db
        .selectFrom("runs")
        .select("status")
        .where("id", "=", c.runId)
        .executeTakeFirst();
      if (now?.status === "queued") out.push(c);
    }
  }
  return out;
}

/**
 * The `run-orphan-check` (transactional outbox spec §6 "Replica death during a run", §8.3): once a
 * minute across replicas (worker role), the one repair of a run nobody runs. A run counts when it
 * has been in its state for over {@link RUN_ORPHAN_MIN_AGE_MS} with neither its BullMQ job nor a
 * conversation lock holder:
 * - `running`: its replica died while running it (BullMQ's stalled re-deliveries ran out, or the
 *   process died inside `onFailed`; run jobs are `attempts: 1, removeOnFail`). It is failed
 *   `run.orphaned` (its terminal transaction cancels its waits and owes what every run end owes),
 *   then, after the commit, its checkpoints are dropped, its fork child stopped (`run.orphaned`), a
 *   sub-agent's failure delivered to its parent at once and the conversation's next run started.
 * - `queued`, with no outbox row either (pending or dead): a canary. Every queued run has its job
 *   owed in its own transaction, so this means Redis lost data. It is logged as an error, counted
 *   for the admin overview ({@link QueueLostJobs}) and its job owed again so the run is not stuck.
 * Redis is read before each repair's transaction, which then re-reads the run under its
 * conversation row lock and acts only if it is still in the same state since the same time. Read
 * paths never repair runs.
 */
@Injectable()
export class RunOrphanCheck {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(RunJobs) private readonly jobs: Pick<RunJobs, "getJob" | "owe">,
    @Inject(ConversationLock) private readonly lock: Pick<ConversationLock, "holder">,
    @Inject(RunFinish) private readonly finisher: Pick<RunFinish, "finishIn">,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "notify" | "publishChanged">,
    @Inject(KyselyCheckpointSaver)
    private readonly checkpoints: Pick<KyselyCheckpointSaver, "deleteThread">,
    /** A failed sub-agent run reports to its parent at once ({@link Waits.childFinished}). */
    @Inject(Waits) private readonly waits: Pick<Waits, "childFinished">,
    /** The conversation's next run, after a repaired run's end. */
    @Inject(RunQueue) private readonly queue: Pick<RunQueue, "ensureRun">,
    @Inject(QueueLostJobs) private readonly lostJobs: Pick<QueueLostJobs, "report">,
    @Inject(KernelEvents) private readonly events: KernelEvents,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  @LockedInterval(RUN_ORPHAN_CHECK_JOB, () => RUN_ORPHAN_CHECK_PERIOD_MS)
  async run(): Promise<void> {
    await this.check();
  }

  /** One pass: repairs the orphans it finds (each on its own; a failure is logged). */
  async check(): Promise<RunOrphanCheckResult> {
    const out: RunOrphanCheckResult = { runningRepaired: 0, queuedReadded: 0 };
    const lost: OrphanCandidate[] = [];
    const pages = candidatePages(this.db, ["queued", "running"], RUN_ORPHAN_MIN_AGE_MS);
    for await (const page of pages) {
      for (const c of page) {
        try {
          if (!(await this.withoutJobOrHolder(c))) continue;
          if (c.status === "running") {
            if (await this.failRunning(c)) out.runningRepaired++;
          } else if (await this.oweAgainIn(c)) {
            out.queuedReadded++;
            lost.push(c);
          }
        } catch (err) {
          this.log.error("run-orphan-check: cannot repair a run", { runId: c.runId, err });
        }
      }
    }
    if (lost.length > 0) {
      this.log.error(QUEUE_LOST_JOBS_MESSAGE, {
        count: lost.length,
        runs: lost.map((c) => ({ runId: c.runId, conversationId: c.conversationId })),
      });
      await this.lostJobs.report(lost.length);
    }
    return out;
  }

  /**
   * Neither a conversation lock holder nor the run's job in BullMQ (nor, queued, in the outbox: an
   * owed row is delivered by the relay, a dead one waits for the super admin).
   */
  private async withoutJobOrHolder(c: OrphanCandidate): Promise<boolean> {
    if ((await this.lock.holder(c.conversationId)) !== null) return false;
    if (c.status === "queued" && (await jobInOutbox(this.db, c.queue, c.jobId))) return false;
    return (await this.jobs.getJob(c.jobId, c.queue)) === undefined;
  }

  /**
   * Fails a `running` orphan (`run.orphaned`), then does what its end causes after the commit:
   * the open pages hear it, its checkpoints go, its fork child stops, a sub-agent reports to its
   * parent and the conversation's next run starts (each also owed by the terminal transaction).
   */
  private async failRunning(c: OrphanCandidate): Promise<boolean> {
    const seq = await this.failIn(c);
    if (seq === null) return false;
    this.log.warn("run-orphan-check: failed a running run nobody runs", {
      runId: c.runId,
      conversationId: c.conversationId,
    });
    await notifyFinished(this.eventLog, c.conversationId, seq, "failed");
    await this.checkpoints
      .deleteThread(c.runId)
      .catch((err) => this.log.warn("checkpoint delete failed", { runId: c.runId, err }));
    await this.events.emit("run.orphaned", { runId: c.runId });
    await this.waits.childFinished(c.runId).catch((err) =>
      this.log.error("cannot report an orphaned sub-agent run to its parent", {
        runId: c.runId,
        err,
      }),
    );
    await this.queue.ensureRun(c.conversationId).catch((err) =>
      this.log.error("cannot start the next run after an orphan", {
        conversationId: c.conversationId,
        err,
      }),
    );
    return true;
  }

  /** {@link failRunning}'s transaction: the terminal state, if the run is still the same orphan. */
  @Transactional({ propagation: "requires_new" })
  private async failIn(c: OrphanCandidate): Promise<number | null> {
    if (!(await this.stillIn(c))) return null;
    return this.finisher.finishIn({
      conversationId: c.conversationId,
      runId: c.runId,
      status: "failed",
      consumed: null,
      event: {
        type: "run_failed",
        payload: {
          error: { code: "run.orphaned", message: "The run was lost and will not continue" },
        },
      },
    });
  }

  /** Owes a lost queued run's job again under its own id, if it is still the same orphan. */
  @Transactional({ propagation: "requires_new" })
  private async oweAgainIn(c: OrphanCandidate): Promise<boolean> {
    if (!(await this.stillIn(c))) return false;
    const data = { runId: c.runId, conversationId: c.conversationId };
    return this.jobs.owe(data, c.jobId, c.kind, c.orgId);
  }

  /**
   * Under the conversation row lock (the first lock of every path that changes a run's state): the
   * run is still in the state and since the time the pass read. Not `FOR UPDATE` on the run: the
   * terminal transaction locks it after the run's wait rows.
   */
  private async stillIn(c: OrphanCandidate): Promise<boolean> {
    await this.db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", c.conversationId)
      .forUpdate()
      .executeTakeFirst();
    const r = await this.db
      .selectFrom("runs as r")
      .select(["r.status", sql<string>`${SINCE}::text`.as("since")])
      .where("r.id", "=", c.runId)
      .executeTakeFirst();
    return r?.status === c.status && r.since === c.since;
  }
}
