import type { RedisOptions } from "bullmq";

/**
 * TCP keepalive of every long-lived kernel Redis connection: probes start after 10 s idle (the OS
 * default is 2 hours), so a connection a dropped network left half-open is found and reconnected
 * before a command waits on it, not at the next write (EPIPE).
 */
export const REDIS_KEEPALIVE_MS = 10_000;

/**
 * BullMQ connection options from the kernel's Redis URL, the same connection the hand-made
 * `new Redis(url, { maxRetriesPerRequest: null })` workers use: BullMQ requires
 * `maxRetriesPerRequest: null` on the blocking connection.
 */
export function bullConnectionOptions(url: string): RedisOptions {
  const u = new URL(url);
  const db = u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined;
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    ...(u.username && { username: decodeURIComponent(u.username) }),
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(db !== undefined && Number.isInteger(db) && { db }),
    ...(u.protocol === "rediss:" && { tls: {} }),
    maxRetriesPerRequest: null,
    keepAlive: REDIS_KEEPALIVE_MS,
  };
}
