import type { Redis } from "ioredis";
import type { SettingsService } from "../identity/settings.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { LeaseHandle, LockService } from "../infra/lock/lock.service.js";

/** 组织配额租约的默认时长（毫秒）：持有方每 `leaseMs / 3` 续租一次。 */
export const ORG_QUOTA_LEASE_MS = 60_000;

/** 运行配额的键前缀（`capk:org-runs:<orgId>`）；评测运行用 {@link EVAL_QUOTA_PREFIX}。 */
export const RUN_QUOTA_PREFIX = "capk:org-runs:";
/** 评测运行的组织并发配额（C7）：`capk:org-evals:<orgId>`，成员为评测任务的 jobId。 */
export const EVAL_QUOTA_PREFIX = "capk:org-evals:";

/** 毫秒级当前时间取 Redis 服务器时钟，各副本一致。 */
const NOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/**
 * 先清理过期成员；已在集合中（同一 runId 再次进入）→ 续期；否则计数小于上限才加入。
 * 成员为 runId，分数为租约到期时间（毫秒）。整个键 PEXPIRE leaseMs*2。
 */
const TRY_ENTER = `${NOW}
local lease = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) or redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], now + lease, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], lease * 2)
  return 1
end
return 0
`;

/** 成员仍在（未过期）才续期。 */
const RENEW = `${NOW}
local lease = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + lease, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], lease * 2)
  return 1
end
return 0
`;

/**
 * 组织级运行并发配额（spec 4.3）：Redis ZSET `<keyPrefix><orgId>`（默认 `capk:org-runs:<orgId>`），
 * 成员 runId（评测为 jobId）、分数为租约到期时间。
 * 持有方崩溃时不 `leave`，成员在租约到期后被下一次 `tryEnter` 清理，名额不泄漏。
 * One instance per key prefix, provided under {@link RUN_QUOTA} / {@link EVAL_QUOTA}.
 */
export class OrgQuota {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string = RUN_QUOTA_PREFIX,
    private readonly locks?: LockService,
  ) {}

  private key(orgId: string): string {
    return `${this.keyPrefix}${orgId}`;
  }

  async tryEnter(
    orgId: string,
    runId: string,
    limit: number,
    leaseMs = ORG_QUOTA_LEASE_MS,
  ): Promise<boolean> {
    return (
      Number(await this.redis.eval(TRY_ENTER, 1, this.key(orgId), runId, limit, leaseMs)) === 1
    );
  }

  /** 续期；成员已过期被清理 → false。 */
  async renew(orgId: string, runId: string, leaseMs = ORG_QUOTA_LEASE_MS): Promise<boolean> {
    return Number(await this.redis.eval(RENEW, 1, this.key(orgId), runId, leaseMs)) === 1;
  }

  async leave(orgId: string, runId: string): Promise<void> {
    await this.redis.zrem(this.key(orgId), runId);
  }

  /**
   * Takes a slot ({@link tryEnter}) and keeps it while held: renewed every `leaseMs / 3` by the
   * lock service's watchdog; `release()` leaves. Undefined when the organization is at its limit.
   * A slot that could not be renewed (it expired meanwhile) aborts `lost` with one WARN; the
   * holder may go on (the slot is a fair-share limit, not mutual exclusion).
   */
  async enter(
    orgId: string,
    runId: string,
    limit: number,
    leaseMs = ORG_QUOTA_LEASE_MS,
  ): Promise<LeaseHandle | undefined> {
    const locks = this.locks;
    if (!locks) throw new Error("OrgQuota.enter needs the lock service");
    const sentAt = Date.now();
    if (!(await this.tryEnter(orgId, runId, limit, leaseMs))) return undefined;
    return locks.keepAlive(
      `${this.key(orgId)}/${runId}`,
      leaseMs,
      {
        renew: () => this.renew(orgId, runId, leaseMs),
        release: () => this.leave(orgId, runId),
      },
      sentAt,
    );
  }
}

/** The organization run quota (`capk:org-runs:<orgId>`). */
export const RUN_QUOTA = Symbol("RUN_QUOTA");
/** The organization eval quota (`capk:org-evals:<orgId>`). */
export const EVAL_QUOTA = Symbol("EVAL_QUOTA");

/**
 * 组织的运行并发上限：部署设置 `runConcurrencyOverrides[orgId]`，没有则用 `runtime.orgConcurrency`
 * （热更新字段，每次经 `config()` 读当前值）。
 */
export async function orgRunLimit(
  settings: Pick<SettingsService, "get">,
  config: Pick<KernelConfigService, "get">,
  orgId: string,
): Promise<number> {
  const { runConcurrencyOverrides } = await settings.get();
  return runConcurrencyOverrides[orgId] ?? config.get().runtime.orgConcurrency;
}
