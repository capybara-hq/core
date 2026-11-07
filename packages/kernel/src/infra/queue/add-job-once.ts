import { type JobsOptions, Queue } from "bullmq";
import type { Redis } from "ioredis";

/** One job to add: its name, data and options (a deterministic `jobId` makes the add idempotent). */
export interface OneJob<T> {
  name: string;
  data: T;
  opts: JobsOptions;
}

/**
 * Adds one job to a kernel queue from a process that hosts no queue of its own (a CLI command),
 * over the caller's Redis connection (left open), with BullMQ's default key prefix like the
 * kernel's queues. The queue handle is closed again before returning.
 */
export async function addJobOnce<T>(
  connection: Redis,
  queue: string,
  job: OneJob<T>,
): Promise<void> {
  const q = new Queue<T>(queue, { connection });
  try {
    // biome-ignore lint/suspicious/noExplicitAny: BullMQ's name and data generics do not line up here
    await (q as Queue<any>).add(job.name, job.data, job.opts);
  } finally {
    await q.close();
  }
}
