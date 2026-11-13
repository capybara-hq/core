import type { OutboxService } from "../../infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../maintenance-queue.js";
import type { Waits } from "../waits.js";

/**
 * The stops a transaction owes a sub-agent tree (transactional outbox spec §6 "Sub-agents"), on
 * the maintenance queue. Two shapes:
 * - `{ runId }`: what a run's terminal transaction owes its children: its active fork invocation
 *   child stops (`Waits.stopChildren`, sub-agents spec §12), and a sub-agent run a person stopped
 *   stops its descendants (`Waits.stopDescendantsOfStopped`, agent map spec §6);
 * - `{ conversationId, byAccountId }`: a deleted root's whole tree below it stops
 *   (`Waits.stopTree` without the root, agent map spec §10).
 *
 * The caller still stops them right after its commit; the job is the backstop for a process that
 * died in between, {@link TREE_JOB_BACKSTOP_MS} later.
 */
export const STOP_TREE_JOB = "stop-tree";

/**
 * A finished sub-agent run's delivery to its parent (`Waits.childFinished`: a background child's
 * `subagent_finished` and `finished` delivery, a fork child's `subagent_finished` and its parent
 * run's resume), owed by the child run's terminal transaction. The delivery is not written in that
 * transaction: it holds the child's conversation and run rows, and the parent's conversation row
 * comes before the child's in the dispatch's lock order (parent conversation, parent run, budget
 * run, child conversation), so taking it there could deadlock with a follow-up dispatch. The
 * caller delivers right after its commit; the job is the backstop, {@link TREE_JOB_BACKSTOP_MS}
 * later.
 */
export const DELIVER_TO_PARENT_JOB = "deliver-to-parent";

/** How long after its transaction a tree job fires (a backstop of the direct call, not a second). */
export const TREE_JOB_BACKSTOP_MS = 30_000;

/** The `stop-tree` job's data. */
export type StopTreeJobData =
  | { runId: string }
  | { conversationId: string; byAccountId: string | null };

/** The `deliver-to-parent` job's data. */
export interface DeliverToParentJobData {
  childRunId: string;
}

/** The `stop-tree` job id of a finished run's children (no `:`). */
export const stopChildrenJobId = (runId: string): string => `stop-tree-run-${runId}`;

/** The `stop-tree` job id of a deleted root's tree (a conversation is deleted once; no `:`). */
export const stopDeletedTreeJobId = (conversationId: string): string =>
  `stop-tree-deleted-${conversationId}`;

/** The `deliver-to-parent` job id: one per child run (no `:`). */
export const deliverToParentJobId = (childRunId: string): string =>
  `deliver-to-parent-${childRunId}`;

const backstopAt = (): Date => new Date(Date.now() + TREE_JOB_BACKSTOP_MS);

/** Owes the stops of `runId`'s children in the caller's transaction (throws outside one). */
export function oweStopChildren(
  outbox: Pick<OutboxService, "add">,
  runId: string,
  orgId: string,
): Promise<boolean> {
  return outbox.add<StopTreeJobData>({
    queue: MAINTENANCE_QUEUE_NAME,
    name: STOP_TREE_JOB,
    jobId: stopChildrenJobId(runId),
    data: { runId },
    runAt: backstopAt(),
    orgId,
  });
}

/** Owes the stop of a deleted root's tree in the caller's transaction (throws outside one). */
export function oweStopDeletedTree(
  outbox: Pick<OutboxService, "add">,
  conversationId: string,
  byAccountId: string | null,
  orgId: string,
): Promise<boolean> {
  return outbox.add<StopTreeJobData>({
    queue: MAINTENANCE_QUEUE_NAME,
    name: STOP_TREE_JOB,
    jobId: stopDeletedTreeJobId(conversationId),
    data: { conversationId, byAccountId },
    runAt: backstopAt(),
    orgId,
  });
}

/** Owes a finished child run's delivery to its parent in the caller's transaction. */
export function oweDeliverToParent(
  outbox: Pick<OutboxService, "add">,
  childRunId: string,
  orgId: string,
): Promise<boolean> {
  return outbox.add<DeliverToParentJobData>({
    queue: MAINTENANCE_QUEUE_NAME,
    name: DELIVER_TO_PARENT_JOB,
    jobId: deliverToParentJobId(childRunId),
    data: { childRunId },
    runAt: backstopAt(),
    orgId,
  });
}

/**
 * The `stop-tree` job (`MaintenanceProcessor`): every stop reads the active runs and stops only
 * those, so a run the direct call already stopped is not stopped again.
 */
export async function processStopTree(
  waits: Pick<Waits, "stopChildren" | "stopDescendantsOfStopped" | "stopTree">,
  data: StopTreeJobData,
): Promise<void> {
  if ("runId" in data) {
    await waits.stopChildren(data.runId, null);
    await waits.stopDescendantsOfStopped(data.runId);
    return;
  }
  await waits.stopTree(data.conversationId, data.byAccountId, { includeSelf: false });
}

/**
 * The `deliver-to-parent` job (`MaintenanceProcessor`): `Waits.childFinished` writes the delivery
 * once by the child run (idempotency keys under the parent conversation's row lock).
 */
export async function processDeliverToParent(
  waits: Pick<Waits, "childFinished">,
  data: DeliverToParentJobData,
): Promise<void> {
  await waits.childFinished(data.childRunId);
}
