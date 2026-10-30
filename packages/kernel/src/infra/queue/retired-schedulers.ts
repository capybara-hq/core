import type { Queue } from "bullmq";

/**
 * Removes job schedulers that no job uses any more (fixed-period jobs that became `@LockedCron` /
 * `@LockedInterval` jobs leave their old BullMQ schedulers in Redis on an upgraded deployment).
 * Idempotent; replicas may race.
 */
export async function removeRetiredSchedulers(
  queue: Pick<Queue, "removeJobScheduler">,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) await queue.removeJobScheduler(id);
}
