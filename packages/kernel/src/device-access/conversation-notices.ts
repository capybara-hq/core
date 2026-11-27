import { randomUUID } from "node:crypto";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";

/**
 * The prompt first delivery of a conversation notice (registered in `infra/outbox/registry.ts`,
 * processed by the maintenance worker); the sweep delivers what it did not.
 */
export const CONVERSATION_NOTICE_JOB = "device-conversation-notice";

/** The data of {@link CONVERSATION_NOTICE_JOB}: `orgId` gives the job its org scope (`runJob`). */
export interface ConversationNoticeJobData {
  orgId: string;
  noticeId: string;
}

/** The deterministic job id of a notice's prompt delivery (no `:`). */
export const conversationNoticeJobId = (noticeId: string): string => `dcn-${noticeId}`;

/**
 * Owes the kernel's conversation-deleted notice to the services of `deviceId` (close tabs on
 * delete design §4.1), in the caller's transaction (the conversation's deletion): one
 * `device_conversation_notices` row (the owed work, intent first; a second owing of the same
 * device and conversation is a no-op) and the outbox job of its prompt delivery. Returns whether
 * it owed a new notice. Only the kernel calls it, with the deleted conversation's own id: no
 * extension, tool or panel input names the conversation or shapes the notice.
 */
export async function oweConversationDeletedNotice(
  db: KernelSchemaDb,
  outbox: Pick<OutboxService, "add">,
  target: { orgId: string; deviceId: string; conversationId: string },
): Promise<boolean> {
  const row = await db
    .insertInto("device_conversation_notices")
    .values({
      id: randomUUID(),
      org_id: target.orgId,
      device_id: target.deviceId,
      conversation_id: target.conversationId,
      kind: "conversation_deleted",
    })
    .onConflict((oc) => oc.columns(["device_id", "conversation_id", "kind"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!row) return false;
  const data: ConversationNoticeJobData = { orgId: target.orgId, noticeId: row.id };
  await outbox.add({
    queue: MAINTENANCE_QUEUE_NAME,
    name: CONVERSATION_NOTICE_JOB,
    jobId: conversationNoticeJobId(row.id),
    data,
    orgId: target.orgId,
  });
  return true;
}
