import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { assertNamespace } from "./namespace.js";

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** 创建带命名空间的 ctx.lock：键为 `cap:<namespace>:lock:<key>`，token 比对保证只操作自己持有的锁。 */
export function createLock(redis: Redis, namespace: string): ExtensionContext["lock"] {
  assertNamespace(namespace);
  return {
    async acquire(key, opts) {
      const ttlMs = opts?.ttlMs;
      if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0) {
        throw new TypeError("ttlMs must be a positive integer");
      }
      const redisKey = `cap:${namespace}:lock:${key}`;
      const token = randomUUID();
      const ok = await redis.set(redisKey, token, "PX", ttlMs, "NX");
      if (ok !== "OK") return null;
      return {
        async renew() {
          return Number(await redis.eval(RENEW, 1, redisKey, token, ttlMs)) === 1;
        },
        async release() {
          await redis.eval(RELEASE, 1, redisKey, token);
        },
      };
    },
  };
}
