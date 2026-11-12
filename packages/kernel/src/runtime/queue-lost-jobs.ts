import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../infra/tokens.js";

/** The Redis hash of the lost-jobs canary: `count` and `lastAt` (ISO). */
export const QUEUE_LOST_JOBS_KEY = "capk:queue-lost-jobs";

/** How long the canary stays after its last report (then the overview drops it). */
export const QUEUE_LOST_JOBS_TTL_SECONDS = 7 * 24 * 3600;

/** What the admin overview shows: how many run jobs the queue lost, and when it last did. */
export interface QueueLostJobsSummary {
  count: number;
  lastAt: string;
}

/**
 * The "queue lost jobs" canary (transactional outbox spec §8.3): the `run-orphan-check` found
 * queued runs whose job is neither in BullMQ nor owed by the outbox, which the outbox makes
 * impossible unless Redis lost data (its durability broke). Each report adds to a count in Redis
 * that the admin overview shows as an attention item until a week after the last report.
 */
@Injectable()
export class QueueLostJobs {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Adds `n` lost jobs to the canary (no-op for 0). */
  async report(n: number): Promise<void> {
    if (n <= 0) return;
    await this.redis
      .multi()
      .hincrby(QUEUE_LOST_JOBS_KEY, "count", n)
      .hset(QUEUE_LOST_JOBS_KEY, "lastAt", new Date().toISOString())
      .expire(QUEUE_LOST_JOBS_KEY, QUEUE_LOST_JOBS_TTL_SECONDS)
      .exec();
  }

  /** The canary, or null when no job was lost in the last week. */
  async summary(): Promise<QueueLostJobsSummary | null> {
    const h = await this.redis.hgetall(QUEUE_LOST_JOBS_KEY);
    const count = Number(h.count ?? 0);
    if (!(count > 0) || h.lastAt === undefined) return null;
    return { count, lastAt: h.lastAt };
  }
}
