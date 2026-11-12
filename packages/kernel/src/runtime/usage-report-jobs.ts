import { Inject, Injectable, Module } from "@nestjs/common";
import type { ConversationEvent } from "../conversations/events.js";
import { UsageSubscribers, UsageSubscribersModule } from "../extensions/usage-subscribers.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";

/**
 * The producer half of `usage.report` delivery, and the queue's ids shared with the reporter
 * (`usage-report.ts`): a delivery is owed in the transaction that writes the usage it reports
 * (transactional outbox spec §8.1). It registers no queue (the outbox dispatcher adds the job), so
 * the `ctx.models` broker below the extension host and the step writes can use it.
 */

/** Queue of `usage.report` deliveries (no `:` in the name). */
export const USAGE_REPORT_QUEUE = "cap-kernel-usage-report";

/** The job name of every delivery (its outbox registry entry holds the job options). */
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

/**
 * Owes `usage.report` deliveries in the caller's transaction, only while the deployment has a
 * subscriber ({@link UsageSubscribers}): usage written while no plugin subscribes is never
 * reported.
 */
@Injectable()
export class UsageReportJobs {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(UsageSubscribers) private readonly subscribers: Pick<UsageSubscribers, "any">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * Owes the delivery of every `usage` event among `events` (the events this transaction wrote
   * to the conversation's log), job `usage-<conversationId>-<seq>`.
   */
  @Transactional({ propagation: "mandatory" })
  async oweEvents(conversationId: string, events: readonly ConversationEvent[]): Promise<void> {
    const usage = events.filter((e) => e.type === "usage");
    if (usage.length === 0 || !(await this.subscribers.any())) return;
    const conv = await this.kdb.db
      .selectFrom("conversations")
      .select("org_id")
      .where("id", "=", conversationId)
      .executeTakeFirst();
    for (const e of usage) {
      await this.outbox.add<UsageReportJob>({
        queue: USAGE_REPORT_QUEUE,
        name: USAGE_REPORT_JOB,
        jobId: usageReportJobId(conversationId, e.seq),
        data: { conversationId, seq: e.seq },
        ...(conv !== undefined && { orgId: conv.org_id }),
      });
    }
  }

  /** Owes the delivery of one `model_usage` row (job `usage-model-<rowId>`). */
  @Transactional({ propagation: "mandatory" })
  async oweModelUsage(usageId: string, orgId: string): Promise<void> {
    if (!(await this.subscribers.any())) return;
    await this.outbox.add<UsageReportJob>({
      queue: USAGE_REPORT_QUEUE,
      name: USAGE_REPORT_JOB,
      jobId: modelUsageJobId(usageId),
      data: { usageId },
      orgId,
    });
  }
}

/** The usage report producer (no queue, no dependency on the extension host). */
@Module({
  imports: [UsageSubscribersModule],
  providers: [UsageReportJobs],
  exports: [UsageReportJobs],
})
export class UsageReportJobsModule {}
