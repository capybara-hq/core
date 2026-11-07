import type { Logger } from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, Module, type OnApplicationShutdown, Optional } from "@nestjs/common";
import type { JobsOptions, Queue } from "bullmq";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { enabledExtensionsQuery } from "../extensions/enabled.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";

/**
 * The producer half of `usage.report` delivery for `model_usage` rows, and the queue's ids and job
 * options shared with the reporter (`usage-report.ts`). The `ctx.models` broker sits below the
 * extension host and must not register a queue there (CLI contexts that build the extensions
 * module never connect to Redis eagerly), so it only announces a row (`model_usage.recorded`) and
 * {@link ModelUsageJobs} enqueues it here.
 */

/** Queue of `usage.report` deliveries (no `:` in the name). */
export const USAGE_REPORT_QUEUE = "cap-kernel-usage-report";

/** The job name of every delivery. */
export const USAGE_REPORT_JOB = "usage-report";

/** One job per `usage` event (no `:`: conversation ids are UUIDs, seq is a number). */
export const usageReportJobId = (conversationId: string, seq: number) =>
  `usage-${conversationId}-${seq}`;

/** One job per `model_usage` row (spec B §5.4; row ids are UUIDs, so no clash with the above). */
export const modelUsageJobId = (usageId: string) => `usage-model-${usageId}`;

/**
 * Job data: ids only (the payload is read when the job runs): a conversation `usage` event
 * (`conversationId` + `seq`), or a `model_usage` row (`usageId`).
 */
export type UsageReportJob = (
  | { conversationId: string; seq: number; usageId?: undefined }
  | { usageId: string; conversationId?: undefined; seq?: undefined }
) & {
  /** Plugins not yet succeeded; absent = every subscriber (decided on the first attempt). */
  pending?: string[];
  /**
   * Targets dropped so far (plugin → why), accumulated across attempts (m-2): when the job would
   * otherwise complete it fails naming them, and `pending` is then exactly these plugins, so a
   * manual retry reaches only them (m-1). A later delivery to one of them removes it.
   */
  dropped?: Record<string, string>;
};

/** First attempt plus 5 retries (F11). */
export const USAGE_REPORT_ATTEMPTS = 6;
/** Retry backoff: 2 s, doubling (2, 4, 8, 16, 32 s). */
export const USAGE_REPORT_BACKOFF_MS = 2000;
/** The delivery retry policy: attempts and the first exponential backoff. */
export interface UsageReportRetry {
  attempts: number;
  backoffMs: number;
}
/** Optional provider: the {@link UsageReportRetry} instead of the defaults above (tests). */
export const USAGE_REPORT_RETRY = Symbol("USAGE_REPORT_RETRY");
/** Failed jobs (given up) are kept for inspection, at most {@link KEEP_FAILED_MAX} of them. */
const KEEP_FAILED_S = 7 * 86_400;
/** Upper bound on kept failed jobs (I-2): a long outage of a billing endpoint cannot grow Redis. */
const KEEP_FAILED_MAX = 100_000;
/**
 * Upper bound on kept finished jobs (Redis memory). At the default retention it only bites above
 * ~1.1 usage events per second sustained for a day; dedupe needs the jobs only for the sweeper overlap.
 */
const KEEP_COMPLETED_MAX = 100_000;

/** The options of one delivery job: its id, the retry policy and the retention of finished jobs. */
export function usageReportJobOpts(
  jobId: string,
  retry: UsageReportRetry,
  keepHours: number,
): JobsOptions {
  return {
    jobId,
    attempts: retry.attempts,
    backoff: { type: "exponential", delay: retry.backoffMs },
    removeOnComplete: { age: keepHours * 3600, count: KEEP_COMPLETED_MAX },
    removeOnFail: { age: KEEP_FAILED_S, count: KEEP_FAILED_MAX },
  };
}

/**
 * Plugins that subscribe to `usage.report` according to deployment state: an approved permission
 * snapshot that declares the `usage.report` hook, for a plugin the deployment still knows: an enabled
 * install, or a config-declared plugin with a replica status row that is not `unloaded`. With `orgId`, only plugins
 * the organization enabled (org config rows and required bootstrap plugins).
 */
export async function queryUsageSubscribers(
  db: KernelSchemaDb,
  orgId?: string,
): Promise<Set<string>> {
  let q = db
    .selectFrom("extension_permission_snapshots as s")
    .select("s.plugin")
    .where(sql<boolean>`s.permissions -> 'permissions' -> 'hooks' ? 'usage.report'`)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom("extension_installs as i")
            .select(sql`1`.as("one"))
            .whereRef("i.name", "=", "s.plugin")
            .where("i.desired_state", "=", "enabled"),
        ),
        // config-declared plugins still declared (and not unloaded) on some replica; installs are
        // covered by desired_state above (their replica rows linger as `unloaded` when disabled)
        eb.exists(
          eb
            .selectFrom("extension_replica_status as r")
            .select(sql`1`.as("one"))
            .whereRef("r.plugin", "=", "s.plugin")
            .where("r.source", "=", "config")
            .where("r.state", "<>", "unloaded"),
        ),
      ]),
    );
  if (orgId !== undefined) {
    q = q.where("s.plugin", "in", enabledExtensionsQuery(db, orgId));
  }
  return new Set((await q.execute()).map((r) => r.plugin));
}

/**
 * Enqueues the `usage.report` delivery of `model_usage` rows on `model_usage.recorded` (fast path;
 * the reporter's sweep re-enqueues rows still unreported, so a lost event or enqueue is caught up).
 */
@Injectable()
export class ModelUsageJobs implements OnApplicationShutdown {
  private readonly unsubscribe: () => void;
  /** Set at shutdown: a late event enqueues nothing (the sweep offers the row later). */
  private closed = false;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(getQueueToken(USAGE_REPORT_QUEUE)) private readonly queue: Queue<UsageReportJob>,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
    @Optional()
    @Inject(USAGE_REPORT_RETRY)
    private readonly retry: UsageReportRetry = {
      attempts: USAGE_REPORT_ATTEMPTS,
      backoffMs: USAGE_REPORT_BACKOFF_MS,
    },
    @Inject(KernelEvents) events: KernelEvents,
  ) {
    this.unsubscribe = events.on("model_usage.recorded", ({ id }) => this.enqueue(id));
  }

  onApplicationShutdown(): void {
    this.closed = true;
    this.unsubscribe();
  }

  /**
   * Enqueues the delivery of one row (job `usage-model-<rowId>`). Without any subscriber nothing is
   * enqueued (the sweep marks the row). Never throws: a failure only logs; the sweep catches up.
   */
  async enqueue(usageId: string): Promise<void> {
    if (this.closed) return;
    try {
      if ((await queryUsageSubscribers(this.kdb.db)).size === 0) return;
      await this.queue.add(
        USAGE_REPORT_JOB,
        { usageId },
        usageReportJobOpts(
          modelUsageJobId(usageId),
          this.retry,
          this.config.get().hooks.usageReportKeepHours,
        ),
      );
    } catch (err) {
      this.log.warn("cannot enqueue model usage report", { usageId, err });
    }
  }
}

/** The usage report queue's registration, shared by the producer and the reporter's module. */
const USAGE_REPORT_QUEUE_MODULE = QueueModule.registerQueue(USAGE_REPORT_QUEUE);

/** The usage report queue and its `model_usage` producer (no dependency on the extension host). */
@Module({
  imports: [USAGE_REPORT_QUEUE_MODULE],
  providers: [ModelUsageJobs],
  exports: [ModelUsageJobs, USAGE_REPORT_QUEUE_MODULE],
})
export class UsageReportJobsModule {}
