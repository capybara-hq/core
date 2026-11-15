import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { type LeaseHandle, LockService } from "../infra/lock/lock.service.js";

/** 会话运行锁的默认 TTL（毫秒）：持有方每 `ttlMs / 3` 续租一次。 */
export const CONVERSATION_LOCK_TTL_MS = 30_000;

/** 会话运行锁的键前缀。 */
const RUN_LOCK_PREFIX = "capk:conv-run:";

/** 本进程持有的会话运行锁。 */
export interface Lease {
  readonly conversationId: string;
  readonly runId: string;
  readonly executionId: string;
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
 * holder's run id plus a unique acquisition id (`holder` exposes the run id), renewed every TTL/3 by the lock
 * service while held; a crashed holder's key expires within the TTL and another replica can take
 * it. Built by {@link ConversationLock} (the run lock) and its {@link ConversationLock.scoped}
 * views (the same lock for another purpose, e.g. the channel delivery `capk:channel-deliver:`).
 * A loss is logged once, by the lock service (`lock lost`, with the key).
 */
export class ConversationLeases {
  constructor(
    protected readonly locks: LockService,
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
    const executionId = randomUUID();
    const held = await this.locks.hold(
      this.lockKey(conversationId),
      `${runId}/${executionId}`,
      ttlMs,
    );
    if (!held) return null;
    return toLease(held, conversationId, runId, executionId);
  }

  /** The current holder's run id, independent of its unique acquisition token. */
  async holder(conversationId: string): Promise<string | null> {
    const value = await this.locks.holderOf(this.lockKey(conversationId));
    return value === null
      ? null
      : value.slice(0, value.lastIndexOf("/") < 0 ? value.length : value.lastIndexOf("/"));
  }
}

function toLease(
  held: LeaseHandle,
  conversationId: string,
  runId: string,
  executionId: string,
): Lease {
  return {
    conversationId,
    runId,
    executionId,
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

/** The run lease: each acquisition has its own token, even when the same run is taken over. */
@Injectable()
export class ConversationLock extends ConversationLeases {
  constructor(@Inject(LockService) locks: LockService) {
    super(locks, RUN_LOCK_PREFIX);
  }

  /** The same per-conversation lease under another key prefix (another purpose). */
  scoped(keyPrefix: string): ConversationLeases {
    return new ConversationLeases(this.locks, keyPrefix);
  }
}
