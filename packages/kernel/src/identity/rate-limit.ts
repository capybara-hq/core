import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

/** 计数窗口（秒）：首次尝试起算，窗口内累计。 */
export const LOGIN_FAIL_WINDOW_SECONDS = 900;
/** 同一登录名在窗口内允许的尝试次数（成功登录会清零）。 */
export const LOGIN_FAIL_LIMIT_PER_LOGIN = 10;
/** 同一客户端 IP 在窗口内允许的尝试次数（跨登录名，防撞库；成功登录退还一次）。 */
export const LOGIN_FAIL_LIMIT_PER_IP = 50;

/**
 * 原子地给每个键 INCR，并在首次计数或键没有 TTL 时设 EXPIRE（保证计数键一定带 TTL）；
 * 返回 `[n1, ttl1, n2, ttl2, …]`。
 */
const RESERVE = `
local out = {}
for i, key in ipairs(KEYS) do
  local n = redis.call('INCR', key)
  local ttl = redis.call('TTL', key)
  if n == 1 or ttl < 0 then
    redis.call('EXPIRE', key, ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  out[#out + 1] = n
  out[#out + 1] = ttl
end
return out
`;

/** 删除登录名计数；IP 计数存在时减一，减到 0 及以下即删除（不会凭空建出无 TTL 的负数键）。 */
const SUCCEEDED = `
redis.call('DEL', KEYS[1])
if redis.call('EXISTS', KEYS[2]) == 1 then
  if redis.call('DECR', KEYS[2]) <= 0 then
    redis.call('DEL', KEYS[2])
  end
end
return 0
`;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** 计数键。登录名按与本地账号相同的方式粗规范化（不校验格式），使大小写 / 空白变体共用计数。 */
export const loginFailKey = {
  login: (login: string) =>
    `capk:login-fail:l:${createHash("sha256").update(login.normalize("NFKC").trim().toLowerCase()).digest("hex")}`,
  ip: (ip: string) => `capk:login-fail:ip:${ip}`,
};

/**
 * 登录限流：按登录名（10 次）与客户端 IP（50 次）在 900s 窗口内计数，计数在 Redis 中，所有副本共享。
 * 校验密码**之前**先原子地 `reserve` 一次尝试，并发请求也无法绕过上限；
 * 登录成功后 `succeeded` 清掉该登录名的计数并退还一次 IP 额度（成功登录不消耗 IP 预算）。
 * 超限后的那次自增保留（反正已拒绝），窗口到期自然清零。
 */
export class LoginRateLimiter {
  constructor(private readonly redis: Redis) {}

  async reserve(login: string, ip: string): Promise<RateLimitResult> {
    const [lCount, lTtl, iCount, iTtl] = (await this.redis.eval(
      RESERVE,
      2,
      loginFailKey.login(login),
      loginFailKey.ip(ip),
      LOGIN_FAIL_WINDOW_SECONDS,
    )) as [number, number, number, number];
    let retry = 0;
    if (lCount > LOGIN_FAIL_LIMIT_PER_LOGIN) retry = Math.max(retry, clampTtl(lTtl));
    if (iCount > LOGIN_FAIL_LIMIT_PER_IP) retry = Math.max(retry, clampTtl(iTtl));
    return retry > 0 ? { allowed: false, retryAfterSeconds: retry } : { allowed: true };
  }

  async succeeded(login: string, ip: string): Promise<void> {
    await this.redis.eval(SUCCEEDED, 2, loginFailKey.login(login), loginFailKey.ip(ip));
  }
}

function clampTtl(ttl: number): number {
  return Math.min(Math.max(ttl, 1), LOGIN_FAIL_WINDOW_SECONDS);
}
