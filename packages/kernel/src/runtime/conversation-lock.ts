import { Inject, Injectable } from "@nestjs/common";
import { type LeaseHandle, LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";

/** 会话运行锁的默认 TTL（毫秒）：持有方每 `ttlMs / 3` 续租一次。 */
export const CONVERSATION_LOCK_TTL_MS = 30_000;

/** 会话运行锁的键前缀。 */
const RUN_LOCK_PREFIX = "capk:conv-run:";

/** 本进程持有的会话运行锁。 */
export interface Lease {
  readonly conversationId: string;
  readonly runId: string;
  /** 续租时发现锁已不属于自己（过期后被他人取得，或续租一直失败到过期）；此后不再续租。 */
  readonly lost: boolean;
  /** 立即续租一次；锁已不属于自己 → false（并标记 lost）。 */
  renew(): Promise<boolean>;
  /** 停止续租并释放（只删除自己持有的锁）。 */
  release(): Promise<void>;
  /** 只停止续租、不释放：锁在 TTL 后自然过期（停机超出预算、交给其他副本时使用）。 */
  abandon(): void;
  /** 注册「锁已丢失」回调（续租发现锁不再属于自己时调用一次；已丢失则立即调用）。 */
  onLost(cb: () => void): void;
}

/**
 * A per-conversation lease on {@link LockService.hold}: key `<prefix><conversationId>`, value the
 * holder's run id (other replicas read it with {@link holder}), renewed every TTL/3 by the lock
 * service while held; a crashed holder's key expires within the TTL and another replica can take
 * it. Built by {@link ConversationLock} (the run lock) and its {@link ConversationLock.scoped}
 * views (the same lock for another purpose, e.g. the channel delivery `capk:channel-deliver:`).
 */
export class ConversationLeases {
  constructor(
    protected readonly locks: LockService,
    protected readonly log: Pick<KernelLogger, "warn">,
    private readonly keyPrefix: string,
  ) {}

  private lockKey(conversationId: string): string {
    return `${this.keyPrefix}${conversationId}`;
  }

  async acquire(
    conversationId: string,
    runId: string,
    ttlMs = CONVERSATION_LOCK_TTL_MS,
  ): Promise<Lease | null> {
    const held = await this.locks.hold(this.lockKey(conversationId), runId, ttlMs);
    if (!held) return null;
    return toLease(held, conversationId, runId, this.log);
  }

  /**
   * 释放某个运行持有的锁（只在仍由该 runId 持有时删除），不需要 Lease：用于 BullMQ 已判定任务失败
   * （例如持有者崩溃、stalled 次数超限）后清理死去持有者留下的锁，不必等 TTL 过期。
   */
  async releaseFor(conversationId: string, runId: string): Promise<void> {
    await this.locks.releaseIf(this.lockKey(conversationId), runId);
  }

  /** 当前持有者的 runId；无人持有 → null。 */
  holder(conversationId: string): Promise<string | null> {
    return this.locks.holderOf(this.lockKey(conversationId));
  }
}

function toLease(
  held: LeaseHandle,
  conversationId: string,
  runId: string,
  log: Pick<KernelLogger, "warn">,
): Lease {
  held.lost.addEventListener(
    "abort",
    () => log.warn("conversation run lock lost", { conversationId, runId }),
    { once: true },
  );
  return {
    conversationId,
    runId,
    get lost() {
      return held.lost.aborted;
    },
    renew: () => held.renew(),
    release: () => held.release(),
    abandon: () => held.abandon(),
    onLost(cb) {
      if (held.lost.aborted) cb();
      else held.lost.addEventListener("abort", () => cb(), { once: true });
    },
  };
}

/**
 * 会话级运行锁（spec 4.3「同一会话同一时刻只跑一轮」）：Redis 键 `capk:conv-run:<id>`，值为 runId，
 * 带 TTL，由 {@link LockService} 每 TTL/3 续租。持有方崩溃时停止续租，锁在 TTL 后过期，其他副本可以取得。
 */
@Injectable()
export class ConversationLock extends ConversationLeases {
  constructor(@Inject(LockService) locks: LockService, @Inject(KERNEL_LOGGER) log: KernelLogger) {
    super(locks, log, RUN_LOCK_PREFIX);
  }

  /** The same per-conversation lease under another key prefix (another purpose). */
  scoped(keyPrefix: string): ConversationLeases {
    return new ConversationLeases(this.locks, this.log, keyPrefix);
  }
}
