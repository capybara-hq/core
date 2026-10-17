import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

/** 计数窗口（秒）：首次失败起算，窗口内累计。 */
export const LOGIN_FAIL_WINDOW_SECONDS = 900;
/** 同一登录名的失败上限。 */
export const LOGIN_FAIL_LIMIT_PER_LOGIN = 10;
/** 同一客户端 IP 的失败上限（跨登录名，防撞库）。 */
export const LOGIN_FAIL_LIMIT_PER_IP = 50;

/**
 * 原子地给每个键 INCR，并在键没有 TTL 时设 EXPIRE（首次计数，或极端情况下 TTL 丢失），
 * 保证计数键一定带 TTL。
 */
const INCR_WITH_TTL = `
for i, key in ipairs(KEYS) do
  local n = redis.call('INCR', key)
  if n == 1 or redis.call('TTL', key) < 0 then
    redis.call('EXPIRE', key, ARGV[1])
  end
end
return 0
`;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** 登录名按与本地账号相同的方式粗规范化（不校验格式），使大小写 / 空白变体共用计数。 */
const loginKey = (login: string) =>
  `capk:login-fail:l:${createHash("sha256").update(login.normalize("NFKC").trim().toLowerCase()).digest("hex")}`;
const ipKey = (ip: string) => `capk:login-fail:ip:${ip}`;

/**
 * 登录失败限流：按登录名（阈值 10）与客户端 IP（阈值 50）在 900s 窗口内计数，计数在 Redis 中，
 * 所有副本共享。只记失败；成功登录清掉该登录名的计数（IP 计数不清，避免用自己的账号洗掉撞库计数）。
 */
export class LoginRateLimiter {
  constructor(private readonly redis: Redis) {}

  async check(login: string, ip: string): Promise<RateLimitResult> {
    const lk = loginKey(login);
    const ik = ipKey(ip);
    const res = (await this.redis.pipeline().get(lk).ttl(lk).get(ik).ttl(ik).exec()) ?? [];
    const failed = res.find(([err]) => err);
    if (failed) throw failed[0];
    const [lCount, lTtl, iCount, iTtl] = res.map(([, v]) => v) as [
      string | null,
      number,
      string | null,
      number,
    ];
    let retry = 0;
    if (Number(lCount ?? 0) >= LOGIN_FAIL_LIMIT_PER_LOGIN)
      retry = Math.max(retry, ttlOrWindow(lTtl));
    if (Number(iCount ?? 0) >= LOGIN_FAIL_LIMIT_PER_IP) retry = Math.max(retry, ttlOrWindow(iTtl));
    return retry > 0 ? { allowed: false, retryAfterSeconds: retry } : { allowed: true };
  }

  async recordFailure(login: string, ip: string): Promise<void> {
    await this.redis.eval(INCR_WITH_TTL, 2, loginKey(login), ipKey(ip), LOGIN_FAIL_WINDOW_SECONDS);
  }

  async clear(login: string): Promise<void> {
    await this.redis.del(loginKey(login));
  }
}

/** GET 与 TTL 之间键恰好过期（TTL = -2）或异常无 TTL（-1）时，保守地按 1s / 整窗口给出。 */
function ttlOrWindow(ttl: number): number {
  if (ttl > 0) return Math.min(ttl, LOGIN_FAIL_WINDOW_SECONDS);
  return ttl === -2 ? 1 : LOGIN_FAIL_WINDOW_SECONDS;
}
