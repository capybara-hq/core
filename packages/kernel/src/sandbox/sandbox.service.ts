import { randomUUID } from "node:crypto";
import type {
  Logger,
  SandboxHandle,
  SandboxLimits,
  SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { type ExpressionBuilder, type Selectable, sql } from "kysely";
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
  /** 之前有过沙箱、但已不在（被销毁、提供方返回 gone、换了提供方），这是重建的空沙箱。 */
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
  config: () => Pick<KernelConfig, "sandbox">;
  log: Pick<Logger, "info" | "warn">;
  /** 等锁的轮询间隔（毫秒），默认 100；测试可调小。 */
  lockPollMs?: number;
}

type Row = Selectable<SandboxesTable>;

/** 没有沙箱提供方时的错误（503）。 */
export const sandboxUnavailable = (): ApiError =>
  new ApiError(
    "sandbox.unavailable",
    "Sandbox is not available in this deployment; install a sandbox plugin",
  );

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
 *   （TTL 60 秒，持有期间续租）。并发调用在锁上排队，两个副本同时首次使用也只创建一个。
 * - **休眠与销毁**由维护队列定期调用 {@link suspendIdle} / {@link destroyInactive}；它们只试一次锁，
 *   锁被持有（正在执行命令）就跳过这一个，下次扫描再说。
 * - **透明恢复**：已休眠的在下次使用时恢复；恢复返回 `gone`、已销毁、或记录的提供方不是当前提供方时重建空沙箱，
 *   `recreated` 为 true（由工具层告诉模型「之前的文件已不在」）。
 *
 * 没有提供方时 {@link available} 为 false，使用时抛 `sandbox.unavailable`（503）。本身无进程内状态，可多副本共用。
 */
export class SandboxService {
  private readonly lock: ConversationLock;
  private readonly pollMs: number;

  constructor(private readonly d: SandboxServiceDeps) {
    this.lock = new ConversationLock(d.redis, d.log, SANDBOX_LOCK_PREFIX);
    this.pollMs = d.lockPollMs ?? 100;
  }

  /** 是否有沙箱提供方。 */
  get available(): boolean {
    return this.d.provider() !== undefined;
  }

  /**
   * 在该对话的沙箱上执行 `fn`：拿锁 → 确保沙箱在运行（创建 / 恢复 / 重建）→ `fn` → 更新 `last_used_at` → 放锁。
   * `signal` 中止等锁与创建 / 恢复；`fn` 自己用调用方的 signal。`fn` 的错误原样抛出。
   */
  async withSandbox<T>(
    ctx: { orgId: string; conversationId: string },
    fn: (h: SandboxHandle, p: SandboxProvider, info: SandboxUseInfo) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const p = this.require();
    const lease = await this.acquire(ctx.conversationId, signal);
    try {
      const { handle, info } = await this.ensure(ctx, p, signal);
      try {
        return await fn(handle, p.impl, info);
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
      await this.release(lease);
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
    const rows = await this.d.db
      .selectFrom("sandboxes")
      .select("conversation_id")
      .where(due)
      .orderBy("last_used_at")
      .limit(SWEEP_BATCH)
      .execute();
    let n = 0;
    await inPool(rows, SWEEP_CONCURRENCY, async ({ conversation_id: id }) => {
      const done = await this.tryLocked(id, async () => {
        const row = await this.d.db
          .selectFrom("sandboxes")
          .selectAll()
          .where("conversation_id", "=", id)
          .where(due)
          .executeTakeFirst();
        if (!row?.handle) return false;
        await p.impl.suspend(row.handle, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS));
        await this.d.db
          .updateTable("sandboxes")
          .set({ status: "suspended", suspended_at: sql<Date>`now()`, running_since: null })
          .where("conversation_id", "=", id)
          .execute();
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
    const rows = await this.d.db
      .selectFrom("sandboxes")
      .select("conversation_id")
      .where(due)
      .orderBy("last_used_at")
      .limit(SWEEP_BATCH)
      .execute();
    let n = 0;
    await inPool(rows, SWEEP_CONCURRENCY, async ({ conversation_id: id }) => {
      const done = await this.tryLocked(id, async () => {
        const row = await this.d.db
          .selectFrom("sandboxes")
          .selectAll()
          .where("conversation_id", "=", id)
          .where(due)
          .executeTakeFirst();
        if (!row) return false;
        await this.destroyRow(row, p);
        return true;
      });
      if (done) n++;
    });
    // 早先已销毁、对话后来才删除的记录
    await this.d.db
      .deleteFrom("sandboxes")
      .where("status", "=", "destroyed")
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
    const lease = await this.acquire(conversationId, AbortSignal.timeout(DESTROY_FOR_WAIT_MS));
    try {
      const current = await this.d.db
        .selectFrom("sandboxes")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("status", "<>", "destroyed")
        .executeTakeFirst();
      if (current) await this.destroyRow(current, p);
    } finally {
      await this.release(lease);
    }
  }

  private require(): SandboxProviderEntry {
    const p = this.d.provider();
    if (!p) throw sandboxUnavailable();
    return p;
  }

  /** 等到拿到锁（`signal` 中止时以其原因失败）。 */
  private async acquire(conversationId: string, signal: AbortSignal): Promise<Lease> {
    const token = randomUUID();
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      const lease = await this.lock.acquire(conversationId, token, SANDBOX_LOCK_TTL_MS);
      if (lease) return lease;
      await sleep(this.pollMs + Math.floor(Math.random() * this.pollMs), signal);
    }
  }

  private async release(lease: Lease): Promise<void> {
    await lease.release().catch((err: unknown) =>
      this.d.log.warn("cannot release sandbox lock", {
        conversationId: lease.conversationId,
        err,
      }),
    );
  }

  /** 只试一次锁：拿不到返回 false；拿到就执行 `fn`（失败记 warn 返回 false）。 */
  private async tryLocked(conversationId: string, fn: () => Promise<boolean>): Promise<boolean> {
    let lease: Lease | null;
    try {
      lease = await this.lock.acquire(conversationId, randomUUID(), SANDBOX_LOCK_TTL_MS);
    } catch (err) {
      this.d.log.warn("cannot take sandbox lock", { conversationId, err });
      return false;
    }
    if (!lease) return false;
    try {
      return await fn();
    } catch (err) {
      this.d.log.warn("sandbox maintenance failed; will retry", { conversationId, err });
      return false;
    } finally {
      await this.release(lease);
    }
  }

  /** 在锁内：让该对话有一个运行中的沙箱。 */
  private async ensure(
    ctx: { orgId: string; conversationId: string },
    p: SandboxProviderEntry,
    signal: AbortSignal,
  ): Promise<{ handle: SandboxHandle; info: SandboxUseInfo }> {
    const row = await this.d.db
      .selectFrom("sandboxes")
      .selectAll()
      .where("conversation_id", "=", ctx.conversationId)
      .executeTakeFirst();
    if (row && row.org_id !== ctx.orgId) {
      throw new Error("sandbox belongs to another organization");
    }
    const handle = row?.handle ?? null;
    if (row && handle && row.provider === p.plugin) {
      if (row.status === "running") return { handle, info: { fresh: false, recreated: false } };
      if (row.status === "suspended") {
        const r = await p.impl.resume(handle, signal);
        if (r === "resumed") {
          await this.d.db
            .updateTable("sandboxes")
            .set({ status: "running", running_since: sql<Date>`now()`, suspended_at: null })
            .where("conversation_id", "=", ctx.conversationId)
            .execute();
          return { handle, info: { fresh: false, recreated: false } };
        }
        this.d.log.info("sandbox is gone at the provider; recreating", {
          conversationId: ctx.conversationId,
        });
      }
    } else if (row && handle && row.status !== "destroyed") {
      // 换了提供方：旧实例由旧提供方管理，这里无法销毁
      this.d.log.warn("sandbox was created by another provider; recreating", {
        conversationId: ctx.conversationId,
        provider: row.provider,
      });
    }
    // 之前有过实例（已销毁 / gone / 换了提供方）→ 重建；从未成功创建过（无记录或停在 creating）→ 首次创建
    const recreated = handle !== null;
    return { handle: await this.create(ctx, p, signal), info: { fresh: true, recreated } };
  }

  private async create(
    ctx: { orgId: string; conversationId: string },
    p: SandboxProviderEntry,
    signal: AbortSignal,
  ): Promise<SandboxHandle> {
    const reset = {
      org_id: ctx.orgId,
      provider: p.plugin,
      handle: null,
      status: "creating" as const,
      last_used_at: sql<Date>`now()`,
      running_since: null,
      suspended_at: null,
      destroyed_at: null,
    };
    await this.d.db
      .insertInto("sandboxes")
      .values({ conversation_id: ctx.conversationId, ...reset })
      .onConflict((oc) => oc.column("conversation_id").doUpdateSet(reset))
      .execute();
    const cfg = this.d.config().sandbox;
    const limits: SandboxLimits = {
      cpu: cfg.limits.cpu,
      memoryMb: cfg.limits.memoryMb,
      diskMb: cfg.limits.diskMb,
      egress: cfg.limits.egress,
      allowHosts: [...cfg.limits.allowHosts],
    };
    const handle = await p.impl.create({
      name: `cap-${ctx.conversationId}`,
      image: cfg.image,
      limits,
      signal,
    });
    await this.d.db
      .updateTable("sandboxes")
      .set({
        status: "running",
        handle: JSON.stringify(handle),
        created_at: sql<Date>`now()`,
        running_since: sql<Date>`now()`,
        last_used_at: sql<Date>`now()`,
      })
      .where("conversation_id", "=", ctx.conversationId)
      .execute();
    this.d.log.info("sandbox created", { conversationId: ctx.conversationId, provider: p.plugin });
    return handle;
  }

  /** 在锁内：销毁实例；对话已不存在的删掉记录，否则标记 destroyed。 */
  private async destroyRow(row: Row, p: SandboxProviderEntry): Promise<void> {
    const id = row.conversation_id;
    if (row.handle && row.provider === p.plugin) {
      await p.impl.destroy(row.handle, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS));
    } else if (row.handle) {
      this.d.log.warn("cannot destroy sandbox created by another provider", {
        conversationId: id,
        provider: row.provider,
      });
    }
    const conversation = await this.d.db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (conversation) {
      await this.d.db
        .updateTable("sandboxes")
        .set({ status: "destroyed", destroyed_at: sql<Date>`now()`, running_since: null })
        .where("conversation_id", "=", id)
        .execute();
    } else {
      await this.d.db.deleteFrom("sandboxes").where("conversation_id", "=", id).execute();
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
