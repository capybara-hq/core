import type { Redis } from "ioredis";
import { type Kysely, sql } from "kysely";

/** One readiness check: resolves when the dependency is ready, rejects when it is not. */
export type ReadinessCheck = () => Promise<void>;

/** Injection token of the named readiness checks (`Record<string, ReadinessCheck>`). */
export const HEALTH_CHECKS = Symbol("HEALTH_CHECKS");

/** `select 1` on the pool. */
export const databaseCheck =
  // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
    (pool: Kysely<any>): ReadinessCheck =>
    async () => {
      await sql`select 1`.execute(pool);
    };

/** PING on a connection that must already be `ready` (a reconnecting client is not ready). */
export const redisCheck =
  (redis: Redis): ReadinessCheck =>
  async () => {
    if (redis.status !== "ready") throw new Error(`redis status ${redis.status}`);
    await redis.ping();
  };
