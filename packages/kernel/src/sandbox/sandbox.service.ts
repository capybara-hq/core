import { randomUUID } from "node:crypto";
import {
  isSandboxGoneError,
  type Logger,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import {
  type Expression,
  type ExpressionBuilder,
  type Selectable,
  type SqlBool,
  sql,
  type UpdateObject,
} from "kysely";
import {
  DEFAULT_MAX_COMMAND_SECONDS,
  DEFAULT_MAX_RUN_SECONDS,
  type KernelConfig,
} from "../config/schema.js";
import type { KernelDatabase, KernelDb, SandboxesTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { readSandboxLimitOverride } from "../identity/settings.js";
import {
  effectiveSandboxEgress,
  effectiveSandboxLimits,
  readOrgSettings,
} from "../orgs/settings.service.js";
import { ConversationLock, type Lease } from "../runtime/conversation-lock.js";

/** 沙箱锁的键前缀：`capk:sandbox:<conversationId>`。 */
export const SANDBOX_LOCK_PREFIX = "capk:sandbox:";
/** 沙箱锁的 TTL（毫秒）：持有期间每 TTL / 3 续租。 */
export const SANDBOX_LOCK_TTL_MS = 60_000;
/**
 * 「沙箱正在使用」标记的键前缀：`capk:sandbox-busy:<conversationId>`。持锁方在执行 `fn` 前写下、结束后删掉；
 * 拿到锁时标记还在，说明前任持锁方没有正常结束（副本崩溃），它的命令可能还在沙箱里跑。
 */
export const SANDBOX_BUSY_PREFIX = "capk:sandbox-busy:";
/** 标记的 TTL 在最长命令时间之外的余量（毫秒）：过期时前任的命令早已被沙箱里的时限杀掉。 */
const BUSY_TTL_MARGIN_MS = 10 * 60_000;

/** 写下自己的标记并返回之前的值（原子）。 */
const BUSY_SWAP = `
local old = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return old
`;
/** 只删自己写的标记。 */
const BUSY_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
/** 维护扫描里单个提供方操作（休眠 / 销毁）的超时。 */
const SWEEP_OP_TIMEOUT_MS = 120_000;
/** 每次扫描最多处理的沙箱数，与同时进行的提供方操作数。 */
const SWEEP_BATCH = 200;
const SWEEP_CONCURRENCY = 4;
/** destroyFor 等锁的上限：持有者在跑命令时最多等这么久。 */
const DESTROY_FOR_WAIT_MS = 10 * 60_000;

/** `withSandbox` 回调的第三个参数。 */
export interface SandboxUseInfo {
  /** 本次调用新建了沙箱（首次使用或重建）。 */
  fresh: boolean;
  /** 之前有过实例、但已不在（被销毁、提供方返回 gone、换了提供方），这是重建的空沙箱。 */
  recreated: boolean;
}

/** 当前的 `sandbox@1` 提供方：插件名与实现。 */
export interface SandboxProviderEntry {
  plugin: string;
  impl: SandboxProvider;
}

export interface SandboxServiceDeps {
  db: KernelDb;
  redis: Redis;
  /** 每次调用时取（提供方在插件加载后才就绪）；没有提供方为 undefined。 */
  provider: () => SandboxProviderEntry | undefined;
  /** 按插件名找仍加载着的提供方（销毁换提供方前的旧实例）；省略则视为找不到。 */
  lookup?: (plugin: string) => SandboxProvider | undefined;
  config: () => Pick<KernelConfig, "sandbox">;
  log: Pick<Logger, "info" | "warn">;
  /** 等锁的轮询间隔（毫秒），默认 100；测试可调小。 */
  lockPollMs?: number;
  /** 锁的 TTL（毫秒），默认 {@link SANDBOX_LOCK_TTL_MS}；测试可调小以便很快发现锁丢失。 */
  lockTtlMs?: number;
  /** 锁实现，默认前缀为 {@link SANDBOX_LOCK_PREFIX} 的 `ConversationLock`（测试可替换）。 */
  lock?: Pick<ConversationLock, "acquire">;
}

type Row = Selectable<SandboxesTable>;
type Patch = UpdateObject<KernelDatabase, "sandboxes">;
/** 锁内读到的防护号（每次防护写入后加一）。 */
interface Fence {
  gen: number;
}

/**
 * 本进程持有的沙箱锁：在 `Lease` 之外自己续租，并记下最后一次成功续租的时间。
 * `ConversationLock` 吞掉续租的报错（Redis 超时等），这里超过 TTL 没有成功续租就视为锁已丢失。
 * `signal` 在锁丢失时中止（原因是 {@link SandboxLockLostError}）。
 */
interface Held {
  readonly signal: AbortSignal;
  /** 锁已丢失（`Lease` 报告的，或超过 TTL 没有成功续租）。 */
  lost(): boolean;
  /** 立即续租一次；锁已丢失 → false。 */
  renew(): Promise<boolean>;
  /** 停止本地续租并释放锁。 */
  release(): Promise<void>;
}

/** 维护里一次提供方操作的 signal：超时或锁丢失时中止。 */
const opSignal = (held: Held): AbortSignal =>
  AbortSignal.any([held.signal, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)]);

/**
 * 启动时要提醒运维的沙箱配置问题（英文日志）：
 * - `runtime.maxRunSeconds` 小于 `sandbox.limits.maxCommandSeconds`：长命令会被运行时限截断（Ruling M20）；
 * - `sandbox.limits.egress` 为 open、但当前提供方插件没打开 `allowOpenEgress`：每次创建沙箱都会被拒。
 * 两个时限都是默认值（900 < 7200，已知的取舍）时只记 info；运维改过其中一个却仍不一致时才 warn。
 */
export function sandboxConfigWarnings(
  cfg: Pick<KernelConfig, "runtime" | "sandbox" | "extensionConfig">,
  providerPlugin?: string,
): { level: "info" | "warn"; message: string }[] {
  const out: { level: "info" | "warn"; message: string }[] = [];
  if (cfg.sandbox.limits.egress === "open" && providerPlugin !== undefined) {
    const pc = cfg.extensionConfig[providerPlugin] as { allowOpenEgress?: unknown } | undefined;
    if (pc?.allowOpenEgress !== true) {
      out.push({
        level: "warn",
        message: `sandbox.limits.egress is "open" but extensionConfig."${providerPlugin}".allowOpenEgress is not true: the ${providerPlugin} plugin refuses to create sandboxes with open egress; set allowOpenEgress to true (trusted environments only) or use "allowlist" or "none"`,
      });
    }
  }
  const run = cfg.runtime.maxRunSeconds;
  const cmd = cfg.sandbox.limits.maxCommandSeconds;
  if (run < cmd) {
    const defaults = run === DEFAULT_MAX_RUN_SECONDS && cmd === DEFAULT_MAX_COMMAND_SECONDS;
    out.push({
      level: defaults ? "info" : "warn",
      message: `runtime.maxRunSeconds (${run}) is less than sandbox.limits.maxCommandSeconds (${cmd}): sandbox commands are limited to the time left in the run, so commands longer than about ${run} seconds cannot finish; raise runtime.maxRunSeconds to at least ${cmd} if agents need long commands`,
    });
  }
  return out;
}

/** 没有沙箱提供方时的错误（503）。 */
export const sandboxUnavailable = (): ApiError =>
  new ApiError(
    "sandbox.unavailable",
    "Sandbox is not available in this deployment; install a sandbox plugin",
  );

/** 同一对话的沙箱被别的命令占着、等锁超过 `sandbox.lockWaitSeconds`（409）。 */
export const sandboxBusy = (): ApiError =>
  new ApiError(
    "sandbox.busy",
    "The sandbox for this conversation is busy with another command; wait for it to finish and try again",
  );

/** 持锁期间锁已丢失、或记录已被别人改过（防护号不符）：放弃本次操作。 */
export class SandboxLockLostError extends Error {
  /** `lock`：锁已丢失（Lease 报告、续租失败或超时没有成功续租）；`generation`：记录的防护号已被别人改过。 */
  readonly reason: "lock" | "generation";

  constructor(conversationId: string, reason: "lock" | "generation" = "lock") {
    super(
      reason === "lock"
        ? `sandbox lock lost for conversation ${conversationId}`
        : `sandbox state of conversation ${conversationId} changed concurrently (generation mismatch)`,
    );
    this.name = "SandboxLockLostError";
    this.reason = reason;
  }
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("This operation was aborted", "AbortError");

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 按 `limit` 个一组并发执行。 */
async function inPool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const x = items[next++] as T;
      await fn(x);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * 内核的沙箱服务（M5 T7）：在 `sandbox@1` 提供方之上，每个对话一个沙箱。
 *
 * - **懒创建**：第一次 {@link withSandbox} 才创建；状态在 PG 表 `sandboxes`。
 * - **串行**：同一对话的一切操作（创建、恢复、执行、休眠、销毁）都在 Redis 锁 `capk:sandbox:<对话>` 下
 *   （TTL 60 秒，持有期间续租）。并发调用在锁上排队（最多 `sandbox.lockWaitSeconds`，之后 `sandbox.busy`），
 *   两个副本同时首次使用也只创建一个。
 * - **防护**：锁可能在持有期间丢失（续租失败、进程卡顿）。锁内读到记录的 `generation`，之后每次改 status / handle
 *   都按它比较并加一，不符就放弃（{@link SandboxLockLostError}）；每次拿到锁都先加一，旧持有者之后的写入必然失败。
 *   锁丢失（含超过 TTL 没有成功续租）时中止传给 `fn` 的 signal 与维护里提供方调用的 signal。
 * - **休眠与销毁**由维护队列定期调用 {@link suspendIdle} / {@link destroyInactive}；它们只试一次锁，
 *   锁被持有（正在执行命令）就跳过这一个，下次扫描再说。
 * - **透明恢复**：已休眠的在下次使用时恢复；恢复返回 `gone`、已销毁、记录的提供方不是当前提供方、
 *   或 `fn` 抛 `SandboxGoneError`（重试一次）时重建空沙箱，`recreated` 为 true（工具层告诉模型「之前的文件已不在」）。
 *   记录是 `running`、实例却被内核之外的原因停了时，由提供方的自动启动（`sandbox@1` 契约）接上。
 * - **接手崩溃的前任**：执行 `fn` 期间 Redis 里有标记 `capk:sandbox-busy:<对话>`（TTL 为最长命令时间加余量）；
 *   拿到锁时标记还在（前任没正常结束），先调提供方的 `killAll` 杀掉前任遗留的命令，再执行 `fn`（尽力而为，
 *   失败只记 warn：提供方在沙箱里也有命令时限兜底）。刚从 `suspended` 恢复的沙箱同样先 `killAll`（所有提供方：
 *   休眠的沙箱里不会有正当的命令；E2B 暂停保留内存且停住沙箱里的时钟，前任的命令可能比标记活得久；Docker 的
 *   休眠本来就结束了全部进程，多一次 exec 的代价很小）。
 *
 * 换提供方会泄漏旧实例：新提供方销毁不了旧提供方的实例，只有旧提供方仍加载时才能清理（记在 `prev_*` 列）。
 * 没有提供方时 {@link available} 为 false，使用时抛 `sandbox.unavailable`（503）。本身无进程内状态，可多副本共用。
 */
export class SandboxService {
  private readonly lock: Pick<ConversationLock, "acquire">;
  private readonly pollMs: number;
  private readonly ttlMs: number;

  constructor(private readonly d: SandboxServiceDeps) {
    this.lock = d.lock ?? new ConversationLock(d.redis, d.log, SANDBOX_LOCK_PREFIX);
    this.pollMs = d.lockPollMs ?? 100;
    this.ttlMs = d.lockTtlMs ?? SANDBOX_LOCK_TTL_MS;
  }

  /** 是否有沙箱提供方。 */
  get available(): boolean {
    return this.d.provider() !== undefined;
  }

  /**
   * 该对话沙箱的对外状态（只读，不拿锁）：`running` / `suspended` 与最近使用时间。
   * 还没有、已销毁、或停在 `creating`（正在创建，或创建失败等下次使用重建）的都返回 null（界面显示「未创建」）。
   */
  async status(
    orgId: string,
    conversationId: string,
  ): Promise<{ status: "running" | "suspended"; lastUsedAt: Date } | null> {
    const row = await this.d.db
      .selectFrom("sandboxes")
      .select(["status", "last_used_at"])
      .where("conversation_id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row || (row.status !== "running" && row.status !== "suspended")) return null;
    return { status: row.status, lastUsedAt: row.last_used_at };
  }

  /**
   * 在该对话的沙箱上执行 `fn`：拿锁 → 确保沙箱在运行（创建 / 恢复 / 重建）→ `fn` → 更新 `last_used_at` → 放锁。
   * - 等锁超过 `sandbox.lockWaitSeconds` 抛 `sandbox.busy`（409）；`signal` 中止等锁与创建 / 恢复。
   * - `fn` 的第四个参数是 `signal` 与「锁已丢失」的合并：执行命令时用它，锁丢失就中止。
   * - `fn` 抛 `SandboxGoneError`（实例已不在）时原地重建、以 `recreated: true` 再调用一次；再次 gone 则抛出。
   * 其余错误原样抛出。
   */
  async withSandbox<T>(
    ctx: { orgId: string; conversationId: string },
    fn: (
      h: SandboxHandle,
      p: SandboxProvider,
      info: SandboxUseInfo,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const p = this.require();
    const capMs = this.d.config().sandbox.lockWaitSeconds * 1000;
    const held = this.hold(await this.acquire(ctx.conversationId, signal, capMs));
    const sig = AbortSignal.any([signal, held.signal]);
    const busy = randomUUID();
    try {
      const s = await this.ensure(ctx, p, held, sig);
      const leftover = await this.markBusy(ctx.conversationId, busy);
      try {
        try {
          // 新建的实例里不会有前任的命令
          // 刚从 suspended 恢复的也清一遍：休眠期间不可能有正当的命令，而 E2B 的暂停连内存一起保留——
          // 前任的命令随恢复回来，暂停时沙箱里的时钟也停了（沙箱里的时限没走），标记却可能已按墙钟过期
          if ((leftover || s.resumed) && !s.info.fresh)
            await this.killLeftovers(
              ctx.conversationId,
              s.handle,
              p,
              sig,
              leftover ? "takeover" : "resume",
            );
          return await fn(s.handle, p.impl, s.info, sig);
        } catch (e) {
          if (!isSandboxGoneError(e)) throw e;
          this.d.log.info("sandbox instance is gone during use; recreating", {
            conversationId: ctx.conversationId,
          });
          const handle = await this.create(ctx, p, held, s.fence, sig, {});
          return await fn(handle, p.impl, { fresh: true, recreated: true }, sig);
        }
      } finally {
        await this.d.redis
          .eval(BUSY_RELEASE, 1, `${SANDBOX_BUSY_PREFIX}${ctx.conversationId}`, busy)
          .catch((err: unknown) =>
            this.d.log.warn("cannot clear sandbox busy marker", {
              conversationId: ctx.conversationId,
              err,
            }),
          );
        await this.d.db
          .updateTable("sandboxes")
          .set({ last_used_at: sql<Date>`now()` })
          .where("conversation_id", "=", ctx.conversationId)
          .where("status", "=", "running")
          .execute()
          .catch((err: unknown) =>
            this.d.log.warn("cannot update sandbox last_used_at", {
              conversationId: ctx.conversationId,
              err,
            }),
          );
      }
    } finally {
      await held.release();
    }
  }

  /**
   * 休眠：空闲超过 `suspendAfterIdleMinutes`、或连续运行超过 `maxRunningMinutes` 的运行中沙箱。
   * 锁被持有（正在执行）的跳过。返回本次休眠的个数。由维护队列每分钟调用。
   */
  async suspendIdle(now: Date): Promise<number> {
    const p = this.d.provider();
    if (!p) return 0;
    const due = this.suspendDue(now, p.plugin);
    const rows = await this.candidates(due);
    let n = 0;
    await inPool(rows, SWEEP_CONCURRENCY, async (id) => {
      const done = await this.tryLocked(id, async (held) => {
        const row = await this.d.db
          .selectFrom("sandboxes")
          .selectAll()
          .where("conversation_id", "=", id)
          .where(due)
          .executeTakeFirst();
        if (!row?.handle) return false;
        const fence = { gen: row.generation };
        await p.impl.suspend(row.handle, opSignal(held));
        if (!(await held.renew())) throw new SandboxLockLostError(id);
        await this.fenced(held, id, fence, {
          status: "suspended",
          suspended_at: sql<Date>`now()`,
          running_since: null,
          sweep_failed_at: null,
        });
        this.d.log.info("sandbox suspended", { conversationId: id });
        return true;
      });
      if (done) n++;
    });
    return n;
  }

  /**
   * 销毁：超过 `destroyAfterInactiveDays` 没用过的、所属组织已删除的、对话已不存在的沙箱
   * （对话已不存在的，销毁后删掉记录）。锁被持有的跳过。返回本次销毁的个数。由维护队列每小时调用。
   */
  async destroyInactive(now: Date): Promise<number> {
    const p = this.d.provider();
    if (!p) return 0;
    const due = this.destroyDue(now);
    const rows = await this.candidates(due);
    let n = 0;
    await inPool(rows, SWEEP_CONCURRENCY, async (id) => {
      const done = await this.tryLocked(id, async (held) => {
        const row = await this.d.db
          .selectFrom("sandboxes")
          .selectAll()
          .where("conversation_id", "=", id)
          .where(due)
          .executeTakeFirst();
        if (!row) return false;
        await this.destroyRow(row, p, held);
        return true;
      });
      if (done) n++;
    });
    // 早先已销毁、对话后来才删除、且没有遗留旧实例的记录
    await this.d.db
      .deleteFrom("sandboxes")
      .where("status", "=", "destroyed")
      .where("prev_handle", "is", null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("conversations")
              .select("conversations.id")
              .whereRef("conversations.id", "=", "sandboxes.conversation_id"),
          ),
        ),
      )
      .execute();
    return n;
  }

  /**
   * 立即销毁该对话的沙箱（对话删除、离职处理时调用）；没有沙箱或已销毁时什么也不做。
   * 等锁（正在执行的命令跑完）最多 10 分钟。没有提供方时只记 warn。
   */
  async destroyFor(conversationId: string): Promise<void> {
    const row = await this.d.db
      .selectFrom("sandboxes")
      .select("status")
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    if (!row || row.status === "destroyed") return;
    const p = this.d.provider();
    if (!p) {
      this.d.log.warn("cannot destroy sandbox: no sandbox provider", { conversationId });
      return;
    }
    const held = this.hold(
      await this.acquire(conversationId, AbortSignal.timeout(DESTROY_FOR_WAIT_MS)),
    );
    try {
      const current = await this.d.db
        .selectFrom("sandboxes")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("status", "<>", "destroyed")
        .executeTakeFirst();
      if (current) await this.destroyRow(current, p, held);
    } finally {
      await held.release();
    }
  }

  /**
   * 写下本次的「正在使用」标记；返回之前是否已有标记（前任没正常结束）。Redis 出错只记 warn、按没有处理。
   */
  private async markBusy(conversationId: string, token: string): Promise<boolean> {
    const ttl = this.d.config().sandbox.limits.maxCommandSeconds * 1000 + BUSY_TTL_MARGIN_MS;
    try {
      const old = await this.d.redis.eval(
        BUSY_SWAP,
        1,
        `${SANDBOX_BUSY_PREFIX}${conversationId}`,
        token,
        ttl,
      );
      return old !== null;
    } catch (err) {
      this.d.log.warn("cannot write sandbox busy marker", { conversationId, err });
      return false;
    }
  }

  /**
   * 接手前任：杀掉沙箱里前任遗留的命令。实例已不在（SandboxGoneError）与中止照常抛出（交给 withSandbox 重建 /
   * 结束）；其余失败只记 warn。提供方没有 `killAll` 时只记 info。
   */
  private async killLeftovers(
    conversationId: string,
    handle: SandboxHandle,
    p: SandboxProviderEntry,
    signal: AbortSignal,
    why: "takeover" | "resume",
  ): Promise<void> {
    if (!p.impl.killAll) {
      if (why === "takeover") {
        this.d.log.info(
          "sandbox taken over from a holder that did not finish; provider cannot kill its commands",
          { conversationId },
        );
      }
      return;
    }
    try {
      await p.impl.killAll(handle, signal);
      if (why === "takeover") {
        this.d.log.info(
          "sandbox taken over from a holder that did not finish; leftover commands killed",
          { conversationId },
        );
      }
    } catch (err) {
      if (signal.aborted || isSandboxGoneError(err)) throw err;
      this.d.log.warn("cannot kill leftover sandbox commands", { conversationId, err });
    }
  }

  private require(): SandboxProviderEntry {
    const p = this.d.provider();
    if (!p) throw sandboxUnavailable();
    return p;
  }

  /**
   * 等到拿到锁（`signal` 中止时以其原因失败）。给了 `capMs` 时最多等这么久，之后抛 `sandbox.busy`。
   */
  private async acquire(
    conversationId: string,
    signal: AbortSignal,
    capMs?: number,
  ): Promise<Lease> {
    const token = randomUUID();
    const deadline = capMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + capMs;
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      const lease = await this.lock.acquire(conversationId, token, this.ttlMs);
      if (lease) return lease;
      const wait = this.pollMs + Math.floor(Math.random() * this.pollMs);
      if (Date.now() + wait > deadline) throw sandboxBusy();
      await sleep(wait, signal);
    }
  }

  /**
   * 包装刚拿到的锁：每 TTL / 3 自己续租一次（本进程持有的锁的续租，与 `ConversationLock` 同样的许可），
   * 记下最后一次成功续租的时间；超过 TTL 没有成功续租（续租报错也算失败）或 `Lease` 报告丢失时中止 `signal`。
   */
  private hold(lease: Lease): Held {
    const id = lease.conversationId;
    const ctl = new AbortController();
    const lose = () => {
      if (ctl.signal.aborted) return;
      this.d.log.warn("sandbox lock lost", { conversationId: id });
      ctl.abort(new SandboxLockLostError(id));
    };
    lease.onLost(lose);
    let lastOk = Date.now();
    let inFlight = false;
    // 键在最后一次成功续租后 TTL 过期；提前到 2/3 TTL 判为丢失，留出余量让中止先于键过期生效
    const staleMs = Math.floor((this.ttlMs * 2) / 3);
    const stale = () => Date.now() - lastOk > staleMs;
    const renew = async (): Promise<boolean> => {
      if (ctl.signal.aborted) return false;
      try {
        if (await lease.renew()) lastOk = Date.now();
        else lose();
      } catch (err) {
        this.d.log.warn("sandbox lock renew failed", { conversationId: id, err });
      }
      if (stale()) lose();
      return !ctl.signal.aborted;
    };
    // 更细的检查定时器（最多每 5 秒）：续租卡住不返回时也能及时判为丢失
    const watchdog = setInterval(
      () => {
        if (stale()) lose();
        if (ctl.signal.aborted) clearInterval(watchdog);
      },
      Math.min(5000, Math.max(1, Math.floor(this.ttlMs / 6))),
    );
    watchdog.unref();
    const timer = setInterval(
      () => {
        if (stale()) lose();
        if (ctl.signal.aborted) {
          clearInterval(timer);
          return;
        }
        if (inFlight) return;
        inFlight = true;
        void renew().finally(() => {
          inFlight = false;
        });
      },
      Math.max(1, Math.floor(this.ttlMs / 3)),
    );
    timer.unref();
    return {
      signal: ctl.signal,
      lost: () => ctl.signal.aborted || lease.lost || stale(),
      renew,
      release: async () => {
        clearInterval(timer);
        clearInterval(watchdog);
        await lease
          .release()
          .catch((err: unknown) =>
            this.d.log.warn("cannot release sandbox lock", { conversationId: id, err }),
          );
      },
    };
  }

  /**
   * 防护写入：锁仍在、且记录的 generation 仍是锁内读到的值时才写（并加一）；否则抛 {@link SandboxLockLostError}。
   */
  private async fenced(held: Held, id: string, fence: Fence, set: Patch): Promise<void> {
    if (held.lost()) throw new SandboxLockLostError(id);
    const r = await this.d.db
      .updateTable("sandboxes")
      .set({ ...set, generation: fence.gen + 1 })
      .where("conversation_id", "=", id)
      .where("generation", "=", fence.gen)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) throw new SandboxLockLostError(id, "generation");
    fence.gen++;
  }

  /** 扫描的候选：上次扫描失败的排在后面，其余按最久未用在前。 */
  private async candidates(
    due: (eb: ExpressionBuilder<KernelDatabase, "sandboxes">) => Expression<SqlBool>,
  ): Promise<string[]> {
    const rows = await this.d.db
      .selectFrom("sandboxes")
      .select("conversation_id")
      .where(due)
      .orderBy(sql`sweep_failed_at ASC NULLS FIRST`)
      .orderBy("last_used_at")
      .limit(SWEEP_BATCH)
      .execute();
    return rows.map((r) => r.conversation_id);
  }

  /**
   * 只试一次锁：拿不到返回 false；拿到就执行 `fn`。失败记 warn、写 `sweep_failed_at`（下次排在后面）并返回 false。
   */
  private async tryLocked(
    conversationId: string,
    fn: (held: Held) => Promise<boolean>,
  ): Promise<boolean> {
    let lease: Lease | null;
    try {
      lease = await this.lock.acquire(conversationId, randomUUID(), this.ttlMs);
    } catch (err) {
      this.d.log.warn("cannot take sandbox lock", { conversationId, err });
      return false;
    }
    if (!lease) return false;
    const held = this.hold(lease);
    try {
      return await fn(held);
    } catch (err) {
      this.d.log.warn("sandbox maintenance failed; will retry", { conversationId, err });
      await this.d.db
        .updateTable("sandboxes")
        .set({ sweep_failed_at: sql<Date>`now()` })
        .where("conversation_id", "=", conversationId)
        .execute()
        .catch(() => {});
      return false;
    } finally {
      await held.release();
    }
  }

  /** 在锁内：让该对话有一个运行中的沙箱。 */
  private async ensure(
    ctx: { orgId: string; conversationId: string },
    p: SandboxProviderEntry,
    held: Held,
    signal: AbortSignal,
  ): Promise<{ handle: SandboxHandle; info: SandboxUseInfo; fence: Fence; resumed?: boolean }> {
    const id = ctx.conversationId;
    await this.d.db
      .insertInto("sandboxes")
      .values({ conversation_id: id, org_id: ctx.orgId, provider: p.plugin, status: "creating" })
      .onConflict((oc) => oc.column("conversation_id").doNothing())
      .execute();
    const row = await this.d.db
      .selectFrom("sandboxes")
      .selectAll()
      .where("conversation_id", "=", id)
      .executeTakeFirstOrThrow();
    if (row.org_id !== ctx.orgId) {
      throw new ApiError(
        "forbidden",
        `The sandbox of conversation ${id} does not belong to organization ${ctx.orgId}`,
      );
    }
    const fence = { gen: row.generation };
    // 每次拿到锁先防护地加一：锁已过期、却还在跑的旧持有者（如卡住的扫描）之后的写入一定失败
    await this.fenced(held, id, fence, {});
    const handle = row.handle;
    if (handle && row.provider === p.plugin) {
      if (row.status === "running") {
        return { handle, info: { fresh: false, recreated: false }, fence };
      }
      if (row.status === "suspended") {
        const r = await p.impl.resume(handle, signal);
        if (r === "resumed") {
          await this.fenced(held, id, fence, {
            status: "running",
            running_since: sql<Date>`now()`,
            suspended_at: null,
            sweep_failed_at: null,
          });
          return { handle, info: { fresh: false, recreated: false }, fence, resumed: true };
        }
        this.d.log.info("sandbox is gone at the provider; recreating", { conversationId: id });
      }
    }
    // 换了提供方且旧实例还没销毁：交给旧提供方（仍加载时）销毁，否则记进 prev_*
    let prev: Patch = {};
    if (handle && row.provider !== p.plugin && row.status !== "destroyed") {
      const kept = await this.retire(id, row.provider, handle, signal);
      if (kept) {
        if (row.prev_handle) {
          this.d.log.warn("sandbox instance of an earlier provider is leaked", {
            conversationId: id,
            provider: row.prev_provider,
          });
        }
        prev = { prev_provider: row.provider, prev_handle: JSON.stringify(handle) };
      }
    }
    const created = await this.create(ctx, p, held, fence, signal, prev);
    // had_instance 只会置 true：之前成功创建过（哪怕后来重建失败）都算重建
    return { handle: created, info: { fresh: true, recreated: row.had_instance }, fence };
  }

  /**
   * 在锁内创建：先防护地重置为 creating，再调提供方，最后防护地写入句柄。
   * 写句柄时发现锁已丢失：尽力销毁刚建好的实例，再抛 {@link SandboxLockLostError}。
   */
  private async create(
    ctx: { orgId: string; conversationId: string },
    p: SandboxProviderEntry,
    held: Held,
    fence: Fence,
    signal: AbortSignal,
    extra: Patch,
  ): Promise<SandboxHandle> {
    const id = ctx.conversationId;
    await this.fenced(held, id, fence, {
      org_id: ctx.orgId,
      provider: p.plugin,
      handle: null,
      status: "creating",
      last_used_at: sql<Date>`now()`,
      running_since: null,
      suspended_at: null,
      destroyed_at: null,
      sweep_failed_at: null,
      ...extra,
    });
    const cfg = this.d.config().sandbox;
    // 出站按组织设置收窄（Ruling M19）；只在创建时生效，改设置只影响之后新建的沙箱
    const egress = effectiveSandboxEgress(
      cfg.limits,
      (await readOrgSettings(this.d.db, ctx.orgId)).sandboxEgress,
    );
    // cpu / 内存按企业管理员的组织覆盖（C19 / Ruling M16），同样只在创建时生效
    const sized = effectiveSandboxLimits(
      { ...cfg.limits, ...egress },
      await readSandboxLimitOverride(this.d.db, ctx.orgId),
    );
    const limits: SandboxLimits = {
      cpu: sized.cpu,
      memoryMb: sized.memoryMb,
      diskMb: sized.diskMb,
      egress: sized.egress,
      allowHosts: sized.allowHosts,
    };
    const handle = await p.impl.create({ name: `cap-${id}`, image: cfg.image, limits, signal });
    try {
      await this.fenced(held, id, fence, {
        status: "running",
        handle: JSON.stringify(handle),
        had_instance: true,
        created_at: sql<Date>`now()`,
        running_since: sql<Date>`now()`,
        last_used_at: sql<Date>`now()`,
      });
    } catch (e) {
      // 锁已丢失、没能记下句柄：尽力销毁刚建好的实例，免得泄漏。
      // 提供方按名字（cap-<对话>）复用实例时（Ruling M10），这个 destroy 可能打到新持有者刚恢复 / 创建的同一个实例。
      // 这能自愈：新持有者下一次提供方调用抛 SandboxGoneError（或 resume 返回 gone），withSandbox 原地重建并重试。
      await p.impl.destroy(handle, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)).catch((err: unknown) =>
        this.d.log.warn("cannot destroy sandbox created after the lock was lost", {
          conversationId: id,
          err,
        }),
      );
      throw e;
    }
    this.d.log.info("sandbox created", { conversationId: id, provider: p.plugin });
    return handle;
  }

  /**
   * 用旧提供方销毁别的提供方创建的实例：旧提供方仍加载且销毁成功 → false；否则 warn 并返回 true（需要留着记录）。
   */
  private async retire(
    id: string,
    provider: string,
    handle: SandboxHandle,
    signal: AbortSignal,
  ): Promise<boolean> {
    const old = this.d.lookup?.(provider);
    if (old) {
      try {
        await old.destroy(
          handle,
          AbortSignal.any([signal, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)]),
        );
        return false;
      } catch (err) {
        this.d.log.warn("cannot destroy sandbox instance of the previous provider", {
          conversationId: id,
          provider,
          err,
        });
        return true;
      }
    }
    this.d.log.warn(
      "sandbox was created by another provider that is not loaded; its instance may leak",
      { conversationId: id, provider },
    );
    return true;
  }

  /** 在锁内：销毁实例（与遗留的旧提供方实例）；对话已不存在的删掉记录，否则标记 destroyed。 */
  private async destroyRow(row: Row, p: SandboxProviderEntry, held: Held): Promise<void> {
    const id = row.conversation_id;
    const fence = { gen: row.generation };
    const signal = opSignal(held);
    let prev: Patch = {};
    if (row.handle && row.provider === p.plugin) {
      await p.impl.destroy(row.handle, signal);
    } else if (row.handle && row.status !== "destroyed") {
      if (await this.retire(id, row.provider, row.handle, signal)) {
        prev = { prev_provider: row.provider, prev_handle: JSON.stringify(row.handle) };
      }
    } else if (!row.handle && row.provider === p.plugin && p.impl.destroyByName) {
      // 创建中途退出：提供方那边可能已有实例，只能按名字清理
      await p.impl.destroyByName(`cap-${id}`, signal);
    }
    if (row.prev_handle && row.prev_provider && !("prev_handle" in prev)) {
      if (!(await this.retire(id, row.prev_provider, row.prev_handle, signal))) {
        prev = { prev_provider: null, prev_handle: null };
      }
    }
    if (!(await held.renew())) throw new SandboxLockLostError(id);
    const conversation = await this.d.db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    const keepRow = conversation !== undefined || (prev.prev_handle ?? row.prev_handle) != null;
    if (keepRow) {
      await this.fenced(held, id, fence, {
        status: "destroyed",
        destroyed_at: sql<Date>`now()`,
        running_since: null,
        sweep_failed_at: null,
        ...prev,
      });
    } else {
      const r = await this.d.db
        .deleteFrom("sandboxes")
        .where("conversation_id", "=", id)
        .where("generation", "=", fence.gen)
        .executeTakeFirst();
      if (Number(r.numDeletedRows) !== 1) throw new SandboxLockLostError(id, "generation");
    }
    this.d.log.info("sandbox destroyed", { conversationId: id });
  }

  /** 该休眠的：本提供方创建、运行中，且空闲到期或连续运行超时。 */
  private suspendDue(now: Date, plugin: string) {
    const lim = this.d.config().sandbox.limits;
    const idleBefore = new Date(now.getTime() - lim.suspendAfterIdleMinutes * 60_000);
    const runningBefore = new Date(now.getTime() - lim.maxRunningMinutes * 60_000);
    return (eb: ExpressionBuilder<KernelDatabase, "sandboxes">) =>
      eb.and([
        eb("status", "=", "running"),
        eb("provider", "=", plugin),
        eb.or([eb("last_used_at", "<", idleBefore), eb("running_since", "<", runningBefore)]),
      ]);
  }

  /** 该销毁的：未销毁，且不活跃到期、组织已删除或对话已不存在。 */
  private destroyDue(now: Date) {
    const days = this.d.config().sandbox.limits.destroyAfterInactiveDays;
    const before = new Date(now.getTime() - days * 24 * 3_600_000);
    return (eb: ExpressionBuilder<KernelDatabase, "sandboxes">) =>
      eb.and([
        eb("status", "<>", "destroyed"),
        eb.or([
          eb("last_used_at", "<", before),
          eb.exists(
            eb
              .selectFrom("orgs")
              .select("orgs.id")
              .whereRef("orgs.id", "=", "sandboxes.org_id")
              .where("orgs.deleted_at", "is not", null),
          ),
          eb.not(
            eb.exists(
              eb
                .selectFrom("conversations")
                .select("conversations.id")
                .whereRef("conversations.id", "=", "sandboxes.conversation_id"),
            ),
          ),
        ]),
      ]);
  }
}
