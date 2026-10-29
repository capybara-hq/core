import type { Logger } from "@capybara-hq/plugin-sdk";
import { Redis } from "ioredis";

/**
 * A dedicated BullMQ connection for the queues and workers not converted to `@nestjs/bullmq` yet
 * (maintenance, channel outbound, evals: Tasks 3.7 / 3.9). BullMQ requires
 * `maxRetriesPerRequest: null` on a worker's blocking connection; the queues use the same.
 */
export function bullConnection(redisUrl: string, log: Pick<Logger, "error">): Redis {
  const c = new Redis(redisUrl, { maxRetriesPerRequest: null });
  c.on("error", (err: Error) => log.error("run queue redis connection error", { err }));
  return c;
}
