import type { OutboxService } from "../infra/outbox/outbox.service.js";

/**
 * The channel delivery job as the outbox owes it (transactional outbox spec §8.1): a leaf module
 * with no BullMQ and no Nest class, so the event log can owe it without importing the channels
 * domain. `jobs.ts` (the producer) re-exports these names.
 */

/** 渠道队列（出站投递与入站任务，不含 `:`），只在 worker 角色上消费。 */
export const CHANNEL_QUEUE_NAME = "cap-kernel-channels";
/** 投递任务名。 */
export const DELIVER_JOB = "deliver";
/** 投递任务 id（不含 `:`）：同一会话、同一日志位置只排一个任务。 */
export const deliverJobId = (conversationId: string, seq: number) =>
  `deliver-${conversationId}-${seq}`;

export interface DeliverJobData {
  conversationId: string;
}

/** The catch-up job of a connection that can deliver again (re-enabled, credentials rotated). */
export const RESUME_JOB = "channel-resume";
/** Its job id: one per connection and update (`updated_at` in ms; no `:`). */
export const resumeJobId = (connectionId: string, at: Date) =>
  `channel-resume-${connectionId}-${at.getTime()}`;

export interface ResumeJobData {
  connectionId: string;
}

/**
 * Owes the conversation's delivery job for the log position `seq` in the transaction in context:
 * the caller knows the conversation has a channel target. Shares the job id of
 * `ChannelJobs.enqueue`, so a hint for the same position is deduped by BullMQ.
 */
export function oweDelivery(
  outbox: Pick<OutboxService, "add">,
  d: { conversationId: string; orgId: string; seq: number },
): Promise<boolean> {
  return outbox.add<DeliverJobData>({
    queue: CHANNEL_QUEUE_NAME,
    name: DELIVER_JOB,
    jobId: deliverJobId(d.conversationId, d.seq),
    data: { conversationId: d.conversationId },
    orgId: d.orgId,
  });
}
