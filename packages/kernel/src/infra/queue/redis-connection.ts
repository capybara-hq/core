import type { RedisOptions } from "bullmq";

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
  };
}
