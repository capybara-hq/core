import type { PluginContext } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";

/** 首次创建时原子设置 TTL；已存在的键不重置 TTL。 */
const INCR_WITH_TTL = `
local v = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1], 'NX')
return v
`;

function assertTtl(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

/** 创建带命名空间的 ctx.kv：实际键为 `cap:<namespace>:<key>`，写入必须带 TTL。 */
export function createKv(redis: Redis, namespace: string): PluginContext["kv"] {
  const k = (key: string) => `cap:${namespace}:${key}`;
  return {
    get: (key) => redis.get(k(key)),
    async set(key, value, opts) {
      assertTtl("ttlSeconds", opts?.ttlSeconds);
      await redis.set(k(key), value, "EX", opts.ttlSeconds);
    },
    async del(key) {
      await redis.del(k(key));
    },
    async incr(key, opts) {
      assertTtl("ttlSeconds", opts?.ttlSeconds);
      return Number(await redis.eval(INCR_WITH_TTL, 1, k(key), opts.ttlSeconds));
    },
  };
}
