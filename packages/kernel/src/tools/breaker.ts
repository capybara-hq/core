import type { Redis } from "ioredis";
import type { KernelConfig } from "../config/schema.js";

/** 熔断器键：每个组织 × 应用一个 hash（`f` = 连续失败次数，`o` = 打开到期的毫秒时间戳）。 */
export const breakerKey = (orgId: string, appId: string): string =>
  `capk:breaker:${orgId}:${appId}`;

/**
 * 连续失败计数的保留时间：没有新的失败也没有成功时，计数在这之后过期（多副本纪律：Redis 写入带 TTL）。
 * 打开后整个键的 TTL = 打开时长 + 该值，打开到期后进入半开（放行调用；再失败立即重新打开）。
 */
const COUNT_TTL_MS = 3_600_000;

/** 时间统一取 Redis 服务端时间（多副本时钟不一致也不影响判定）。 */
const NOW = `local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;

/**
 * 记一次失败：计数 +1；达到阈值、或处于半开（曾打开且已到期）时打开 / 重新打开；
 * 仍在打开期内的失败（打开前已发出的调用）只计数，不延长打开时间。返回失败次数。
 */
const FAILURE = `
${NOW}
local n = redis.call('HINCRBY', KEYS[1], 'f', 1)
local o = tonumber(redis.call('HGET', KEYS[1], 'o') or '0')
local openMs = tonumber(ARGV[2])
local countMs = tonumber(ARGV[3])
if o > now then
  return n
end
if n >= tonumber(ARGV[1]) or o > 0 then
  redis.call('HSET', KEYS[1], 'o', now + openMs)
  redis.call('PEXPIRE', KEYS[1], openMs + countMs)
else
  redis.call('PEXPIRE', KEYS[1], countMs)
end
return n
`;

/** 读状态：返回 {失败次数, 剩余打开毫秒}（未打开为 0）。 */
const CHECK = `
${NOW}
local v = redis.call('HMGET', KEYS[1], 'f', 'o')
local f = tonumber(v[1] or '0')
local o = tonumber(v[2] or '0')
local left = 0
if o > now then left = o - now end
return {f, left}
`;

export type BreakerState =
  | { open: false }
  | { open: true; failures: number; retryAfterSeconds: number };

/** 熔断打开时给模型的说明（英文）。 */
export function breakerOpenMessage(appName: string, failures: number, retryAfterSeconds: number) {
  return `Tool temporarily unavailable: ${appName} failed ${failures} times in a row; retry after ${retryAfterSeconds}s.`;
}

/**
 * 应用级熔断器（spec 5.4；只用于应用工具）：同一组织同一应用连续失败 `tools.breakerFailures` 次后打开
 * `tools.breakerOpenSeconds` 秒，期间直接拒绝；到期后半开放行，成功清零、失败立即重新打开。
 * 状态只在 Redis（多副本共享），计数与打开状态都带 TTL。
 */
export class Breaker {
  constructor(
    private readonly redis: Redis,
    private readonly config: () => KernelConfig,
  ) {}

  async check(orgId: string, appId: string): Promise<BreakerState> {
    const [failures, left] = (await this.redis.eval(CHECK, 1, breakerKey(orgId, appId))) as [
      number,
      number,
    ];
    if (left <= 0) return { open: false };
    return { open: true, failures, retryAfterSeconds: Math.ceil(left / 1000) };
  }

  /** 记一次失败，返回当前连续失败次数。 */
  async failure(orgId: string, appId: string): Promise<number> {
    const { breakerFailures, breakerOpenSeconds } = this.config().tools;
    return Number(
      await this.redis.eval(
        FAILURE,
        1,
        breakerKey(orgId, appId),
        breakerFailures,
        breakerOpenSeconds * 1000,
        COUNT_TTL_MS,
      ),
    );
  }

  /** 调用成功：清零。 */
  async success(orgId: string, appId: string): Promise<void> {
    await this.redis.del(breakerKey(orgId, appId));
  }
}
