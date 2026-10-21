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
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb, SandboxesTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ConversationLock, type Lease } from "../runtime/conversation-lock.js";

/** 沙箱锁的键前缀：`capk:sandbox:<conversationId>`。 */
export const SANDBOX_LOCK_PREFIX = "capk:sandbox:";
/** 沙箱锁的 TTL（毫秒）：持有期间每 TTL / 3 续租。 */
export const SANDBOX_LOCK_TTL_MS = 60_000;
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
    try {
      const s = await this.ensure(ctx, p, held, sig);
      try {
        try {
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
  ): Promise<{ handle: SandboxHandle; info: SandboxUseInfo; fence: Fence }> {
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
          return { handle, info: { fresh: false, recreated: false }, fence };
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
    const limits: SandboxLimits = {
      cpu: cfg.limits.cpu,
      memoryMb: cfg.limits.memoryMb,
      diskMb: cfg.limits.diskMb,
      egress: cfg.limits.egress,
      allowHosts: [...cfg.limits.allowHosts],
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
