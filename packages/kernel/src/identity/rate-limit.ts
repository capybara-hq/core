import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

/** 计数窗口（秒）：首次尝试起算，窗口内累计。 */
export const LOGIN_FAIL_WINDOW_SECONDS = 900;
/** 同一（登录名, 客户端 IP）在窗口内允许的尝试次数（成功登录会清零）。 */
export const LOGIN_FAIL_LIMIT_PER_LOGIN_IP = 10;
/** 同一客户端 IP 在窗口内允许的尝试次数（跨登录名，防撞库；成功登录退还一次）。 */
export const LOGIN_FAIL_LIMIT_PER_IP = 50;
/** 同一登录名在窗口内跨所有 IP 允许的尝试次数（防分布式爆破单个账号；成功登录会清零）。 */
export const LOGIN_FAIL_LIMIT_PER_LOGIN = 100;

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

/**
 * 删除除最后一个之外的全部键；最后一个（IP 计数）存在时减一，减到 0 及以下即删除
 * （不会凭空建出无 TTL 的负数键）。
 */
const SUCCEEDED = `
for i = 1, #KEYS - 1 do
  redis.call('DEL', KEYS[i])
end
local ip = KEYS[#KEYS]
if redis.call('EXISTS', ip) == 1 then
  if redis.call('DECR', ip) <= 0 then
    redis.call('DEL', ip)
  end
end
return 0
`;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** 登录名按与本地账号相同的方式粗规范化（不校验格式），使大小写 / 空白变体共用计数。 */
const loginHash = (login: string) => sha256(login.normalize("NFKC").trim().toLowerCase());

/** 登录计数键。 */
export const loginFailKey = {
  /** （登录名, IP）：阈值 10。 */
  loginIp: (login: string, ip: string) => `capk:login-fail:li:${loginHash(login)}:${sha256(ip)}`,
  /** 客户端 IP（跨登录名）：阈值 50。 */
  ip: (ip: string) => `capk:login-fail:ip:${ip}`,
  /** 单登录名全局（跨 IP）：阈值 100。 */
  login: (login: string) => `capk:login-fail:l:${loginHash(login)}`,
};

/** 其他凭据核对接口（改密码 `acct`、初始化令牌 `setup`、接受邀请 `inv`）的计数键，与登录的额度分开。 */
export const scopedKey = {
  key: (scope: string, key: string) => `capk:rl:${scope}:k:${sha256(key)}`,
  ip: (scope: string, ip: string) => `capk:rl:${scope}:ip:${ip}`,
};

/**
 * 凭据尝试限流，计数在 Redis 中、所有副本共享，窗口 900s。
 *
 * 登录（`reserve`）按三个键计数，任一超限即拒绝：
 * - （登录名, IP）10 次——攻击者从一个 IP 打满某登录名的额度，不影响本人从别的 IP 登录（R25）；
 * - 客户端 IP 50 次（跨登录名，防撞库）；
 * - 单登录名 100 次（跨 IP，防分布式爆破）。
 * 校验密码**之前**先原子地占用一次尝试，并发请求也无法绕过上限；登录成功后 `succeeded`
 * 清掉该登录名的两个计数并退还一次 IP 额度（成功登录不消耗 IP 预算）。
 *
 * `reserveScoped` 供其他核对凭据的接口复用：按 `(scope, key)`（上限 `limit`）与 scope 内的 IP
 * （上限 `ipLimit`，默认同登录的 50）两个键计数；IP 计数与登录的 IP 额度分开
 * （改密码失败不会挤占同 NAT 下他人的登录额度）。
 *
 * 超限后的那次自增保留（反正已拒绝），窗口到期自然清零。
 */
export class LoginRateLimiter {
  constructor(private readonly redis: Redis) {}

  async reserve(login: string, ip: string): Promise<RateLimitResult> {
    return this.reserveKeys([
      [loginFailKey.loginIp(login, ip), LOGIN_FAIL_LIMIT_PER_LOGIN_IP],
      [loginFailKey.ip(ip), LOGIN_FAIL_LIMIT_PER_IP],
      [loginFailKey.login(login), LOGIN_FAIL_LIMIT_PER_LOGIN],
    ]);
  }

  async succeeded(login: string, ip: string): Promise<void> {
    await this.redis.eval(
      SUCCEEDED,
      3,
      loginFailKey.loginIp(login, ip),
      loginFailKey.login(login),
      loginFailKey.ip(ip),
    );
  }

  async reserveScoped(
    scope: string,
    key: string,
    ip: string,
    limit: number,
    ipLimit: number = LOGIN_FAIL_LIMIT_PER_IP,
  ): Promise<RateLimitResult> {
    return this.reserveKeys([
      [scopedKey.key(scope, key), limit],
      [scopedKey.ip(scope, ip), ipLimit],
    ]);
  }

  /** 核对成功：删 `(scope, key)` 计数，scope 内 IP 计数减一。 */
  async succeededScoped(scope: string, key: string, ip: string): Promise<void> {
    await this.redis.eval(SUCCEEDED, 2, scopedKey.key(scope, key), scopedKey.ip(scope, ip));
  }

  private async reserveKeys(keys: [string, number][]): Promise<RateLimitResult> {
    const out = (await this.redis.eval(
      RESERVE,
      keys.length,
      ...keys.map(([k]) => k),
      LOGIN_FAIL_WINDOW_SECONDS,
    )) as number[];
    let retry = 0;
    keys.forEach(([, limit], i) => {
      const n = out[i * 2] as number;
      const ttl = out[i * 2 + 1] as number;
      if (n > limit) retry = Math.max(retry, clampTtl(ttl));
    });
    return retry > 0 ? { allowed: false, retryAfterSeconds: retry } : { allowed: true };
  }
}

function clampTtl(ttl: number): number {
  return Math.min(Math.max(ttl, 1), LOGIN_FAIL_WINDOW_SECONDS);
}
