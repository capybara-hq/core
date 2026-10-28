import type { Redis } from "ioredis";
import { sql } from "kysely";

export async function lock(redis: Redis, db: unknown): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext('x'))`.execute(db as never); // expect: kc-lock
  await sql`SELECT pg_try_advisory_lock(1)`.execute(db as never); // expect: kc-lock
  await redis.set("k", "v", "PX", 1000, "NX"); // expect: kc-lock
  await redis.eval("return redis.call('SET', KEYS[1], ARGV[1], 'NX')", 1, "k", "v"); // expect: kc-lock
  const timer = setInterval(() => void redis.pexpire("k", 1000), 300); // expect: kc-lock
  clearInterval(timer);
}
