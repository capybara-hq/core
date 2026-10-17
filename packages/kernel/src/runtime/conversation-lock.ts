import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";

/** 会话运行锁的默认 TTL（毫秒）：持有方每 `ttlMs / 3` 续租一次。 */
export const CONVERSATION_LOCK_TTL_MS = 30_000;

const lockKey = (conversationId: string) => `capk:conv-run:${conversationId}`;

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

/** 本进程持有的会话运行锁。 */
export interface Lease {
  readonly conversationId: string;
  readonly runId: string;
  /** 续租时发现锁已不属于自己（过期后被他人取得）；此后不再续租。 */
  readonly lost: boolean;
  /** 立即续租一次；锁已不属于自己 → false（并标记 lost）。 */
  renew(): Promise<boolean>;
  /** 停止续租并释放（只删除自己持有的锁）。 */
  release(): Promise<void>;
  /** 只停止续租、不释放：锁在 TTL 后自然过期（停机超出预算、交给其他副本时使用）。 */
  abandon(): void;
}

/**
 * 会话级运行锁（spec 4.3「同一会话同一时刻只跑一轮」）：Redis 键 `capk:conv-run:<id>`，值为 runId，
 * 带 TTL；持有期间由本进程的定时器每 `ttlMs / 3` 续租（本进程持有的锁的续租，允许的进程内定时器）。
 * 持有方崩溃时停止续租，锁在 TTL 后过期，其他副本可以取得。
 */
export class ConversationLock {
  constructor(
    private readonly redis: Redis,
    private readonly log?: Pick<Logger, "warn">,
  ) {}

  async acquire(
    conversationId: string,
    runId: string,
    ttlMs = CONVERSATION_LOCK_TTL_MS,
  ): Promise<Lease | null> {
    const key = lockKey(conversationId);
    const ok = await this.redis.set(key, runId, "PX", ttlMs, "NX");
    if (ok !== "OK") return null;
    const redis = this.redis;
    const log = this.log;
    let lost = false;
    let timer: NodeJS.Timeout | undefined;
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const lease: Lease = {
      conversationId,
      runId,
      get lost() {
        return lost;
      },
      async renew() {
        if (lost) return false;
        const r = Number(await redis.eval(RENEW, 1, key, runId, ttlMs));
        if (r !== 1) {
          lost = true;
          stop();
          log?.warn("conversation run lock lost", { conversationId, runId });
        }
        return r === 1;
      },
      async release() {
        stop();
        await redis.eval(RELEASE, 1, key, runId);
      },
      abandon: stop,
    };
    timer = setInterval(
      () => {
        lease.renew().catch((err) => log?.warn("conversation run lock renew failed", { err }));
      },
      Math.max(1, Math.floor(ttlMs / 3)),
    );
    timer.unref();
    return lease;
  }

  /** 当前持有者的 runId；无人持有 → null。 */
  holder(conversationId: string): Promise<string | null> {
    return this.redis.get(lockKey(conversationId));
  }
}
