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
import {
  SANDBOX_LOCK_TTL_MS,
  type SandboxLease,
  SandboxLeases,
  SandboxLockLostError,
  type SandboxPathLease,
  sandboxBusy,
} from "./leases.js";

// Moved to leases.ts (phase C); re-exported for existing importers
export {
  SANDBOX_BUSY_PREFIX,
  SANDBOX_LOCK_PREFIX,
  SANDBOX_LOCK_TTL_MS,
  SandboxLockLostError,
  sandboxBusy,
} from "./leases.js";

/** Margin (ms) of a holder record's TTL beyond the longest command: by then the in-sandbox limit has ended its commands. */
const HOLDER_TTL_MARGIN_MS = 10 * 60_000;
/** How long the kernel's own read-modify-write of one file waits for another holder's (ms, spec §10.4). */
const PATH_LEASE_WAIT_MS = 30_000;
/** 维护扫描里单个提供方操作（休眠 / 销毁）的超时。 */
const SWEEP_OP_TIMEOUT_MS = 120_000;
/** How long the suspension sweep holds the intent on a sandbox past `maxRunningMinutes` (ms). */
const SWEEP_INTENT_WAIT_MS = 1000;
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
  /** Poll interval while waiting for a lease (ms), default 100; tests make it shorter. */
  lockPollMs?: number;
  /** Lease TTL (ms), default {@link SANDBOX_LOCK_TTL_MS}; tests make it shorter to notice a lost lease quickly. */
  lockTtlMs?: number;
  /** Lease implementation, default a {@link SandboxLeases} on `redis` (tests may wrap one). */
  leases?: SandboxLeases;
}

type Row = Selectable<SandboxesTable>;
type Patch = UpdateObject<KernelDatabase, "sandboxes">;
/** 锁内读到的防护号（每次防护写入后加一）。 */
interface Fence {
  gen: number;
}

/**
 * One instance of a conversation's sandbox: its handle and the row's `created_at`, which the
 * fenced write after every `create` sets. The handle alone is not enough: sandbox-docker's handle
 * is the instance name, the same after a rebuild (spec §10.10).
 */
interface Instance {
  handle: SandboxHandle;
  createdAt: number;
}

/** A holder ready to run `fn`: a shared lease, the running instance, the use info. */
interface Entered {
  lease: SandboxLease;
  handle: SandboxHandle;
  createdAt: number;
  info: SandboxUseInfo;
}

/** 维护里一次提供方操作的 signal：超时或锁丢失时中止。 */
const opSignal = (lease: SandboxLease): AbortSignal =>
  AbortSignal.any([lease.signal, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)]);

/** The row still records the instance `gone` (same handle and same `created_at`). */
const isInstance = (row: Pick<Row, "handle" | "created_at">, gone: Instance | null): boolean =>
  gone !== null &&
  row.handle !== null &&
  JSON.stringify(row.handle) === JSON.stringify(gone.handle) &&
  row.created_at.getTime() === gone.createdAt;

/**
 * Concurrent commands a provider gets (spec §10.7): `max` when it declares both `concurrentExec`
 * and `killTagged`, else 1 (one call at a time, the behavior before phase C).
 */
export function sandboxConcurrency(
  impl: Pick<SandboxProvider, "concurrentExec" | "killTagged">,
  max: number,
): number {
  return impl.concurrentExec === true && typeof impl.killTagged === "function" ? max : 1;
}

/**
 * `impl` with every `exec` labelled with the holder's tag; `before` runs first (it refreshes the
 * holder's record, so a callback that runs several long commands in a row stays recorded).
 */
function tagged(impl: SandboxProvider, tag: string, before: () => Promise<void>): SandboxProvider {
  const wrapped = Object.create(impl) as SandboxProvider;
  Object.defineProperty(wrapped, "exec", {
    value: async (h: SandboxHandle, args: Parameters<SandboxProvider["exec"]>[1]) => {
      await before();
      return impl.exec(h, { ...args, tag });
    },
  });
  return wrapped;
}

/**
 * 启动时要提醒运维的沙箱配置问题（英文日志）：
 * - `runtime.maxRunSeconds` 小于 `sandbox.limits.maxCommandSeconds`：长命令会被运行时限截断（Ruling M20）；
 * - `sandbox.limits.egress` 为 open、但当前提供方插件没打开 `allowOpenEgress`：每次创建沙箱都会被拒。
 * 两个时限都是默认值（900 < 7200，已知的取舍）时只记 info；运维改过其中一个却仍不一致时才 warn。
 * - the provider declares only one of `concurrentExec` and `killTagged`: it is used one call at a
 *   time (spec §10.7).
 */
export function sandboxConfigWarnings(
  cfg: Pick<KernelConfig, "runtime" | "sandbox" | "extensionConfig">,
  providerPlugin?: string,
  impl?: Pick<SandboxProvider, "concurrentExec" | "killTagged">,
): { level: "info" | "warn"; message: string }[] {
  const out: { level: "info" | "warn"; message: string }[] = [];
  if (impl && (impl.concurrentExec === true) !== (typeof impl.killTagged === "function")) {
    out.push({
      level: "warn",
      message: `the sandbox plugin ${providerPlugin ?? ""} declares only one of concurrentExec and killTagged; concurrent commands need both, so its sandboxes run one command at a time`,
    });
  }
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
 * - **Leases** (phase C, spec §10, {@link SandboxLeases}): using a sandbox recorded `running` with
 *   the current provider takes a **shared** lease, so up to `sandbox.maxConcurrentCommands` holders
 *   (commands of parallel sub-agents) run at once ({@link sandboxConcurrency}: 1 for a provider
 *   without `concurrentExec` + `killTagged`). Every lifecycle change (create, resume, rebuild,
 *   suspend, destroy) takes the **exclusive** lease, alone; a caller that needs one on the use path
 *   sets the intent so new shared leases wait for it, and downgrades to a shared lease to run its
 *   own command once the sandbox is running. Waiting is capped at `sandbox.lockWaitSeconds`
 *   (`sandbox.busy`); two replicas using it for the first time at once still build only one.
 * - **防护**：exclusive holders read `generation` and compare-and-increment it with every write of
 *   status / handle ({@link SandboxLockLostError}); every acquisition (shared ones too) bumps it
 *   first, so a stale exclusive holder's later writes fail. Shared holders write nothing else but
 *   `last_used_at` (monotonic). A lost
 *   lease aborts the signal passed to `fn` and to maintenance provider calls.
 * - **休眠与销毁**由维护队列定期调用 {@link suspendIdle} / {@link destroyInactive}；它们只试一次 exclusive
 *   lease and skip a sandbox with any holder; a sandbox past `maxRunningMinutes` gets the intent for
 *   a short window (about a second) so the suspension can get in when its commands end.
 * - **透明恢复**：已休眠的在下次使用时恢复；恢复返回 `gone`、已销毁、记录的提供方不是当前提供方、
 *   或 `fn` 抛 `SandboxGoneError`（重试一次）时重建空沙箱，`recreated` 为 true（工具层告诉模型「之前的文件已不在」）。
 *   Several holders hitting `gone` together rebuild once: the others find the new instance.
 * - **Takeover** (spec §10.5): every holder records itself in `capk:sandbox-holders:<conv>` (again
 *   before each `exec`) and its commands carry its lease token as `tag`. An acquirer that finds a
 *   record without a live lease (a crashed holder) kills its commands: `killTagged` on the shared
 *   path whenever the provider has it (else `killAll` only while it is the one shared holder),
 *   `killAll` under the exclusive lease (no live sibling can exist). The single marker
 *   `capk:sandbox-busy:<conv>` of kernels before phase C sends the next use down the exclusive
 *   path, which `killAll`s; holders of this kernel write it as `v2` for older replicas (§10.8),
 *   which this kernel ignores. A sandbox just resumed from `suspended` is `killAll`ed too. Failures
 *   are only warned (the in-sandbox time limit is the backstop).
 * - **Instance identity**: a holder that hits `gone` names the instance by its handle and the
 *   row's `created_at` (set by the fenced write after each `create`); the handle alone is the same
 *   after a rebuild on providers whose handle is the instance name (sandbox-docker).
 *
 * 换提供方会泄漏旧实例：新提供方销毁不了旧提供方的实例，只有旧提供方仍加载时才能清理（记在 `prev_*` 列）。
 * 没有提供方时 {@link available} 为 false，使用时抛 `sandbox.unavailable`（503）。本身无进程内状态，可多副本共用。
 */
export class SandboxService {
  private readonly leases: SandboxLeases;
  private readonly pollMs: number;

  constructor(private readonly d: SandboxServiceDeps) {
    this.pollMs = d.lockPollMs ?? 100;
    this.leases =
      d.leases ??
      new SandboxLeases({
        redis: d.redis,
        log: d.log,
        ttlMs: d.lockTtlMs ?? SANDBOX_LOCK_TTL_MS,
        pollMs: this.pollMs,
      });
  }

  /** 是否有沙箱提供方。 */
  get available(): boolean {
    return this.d.provider() !== undefined;
  }

  /** Concurrent holders the provider gets ({@link sandboxConcurrency} with the current config). */
  effectiveCap(p: SandboxProviderEntry): number {
    return sandboxConcurrency(p.impl, this.d.config().sandbox.maxConcurrentCommands);
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
   * A short lease on one path of the conversation's sandbox around the kernel's own
   * read-modify-write of that file (spec §10.4); waits up to 30 s, then throws
   * `SandboxPathBusyError`. Its `signal` aborts when a renewal finds it lost.
   */
  pathLease(conversationId: string, path: string, signal: AbortSignal): Promise<SandboxPathLease> {
    return this.leases.pathLease(conversationId, path, signal, PATH_LEASE_WAIT_MS);
  }

  /**
   * 在该对话（the sandbox conversation）的沙箱上执行 `fn`: take a lease → make sure the sandbox runs
   * (create / resume / rebuild, under the exclusive lease) → `fn` under a shared lease → update
   * `last_used_at` → release.
   * - 等待超过 `sandbox.lockWaitSeconds` 抛 `sandbox.busy`（409）；`signal` 中止等待与创建 / 恢复。
   * - `fn` 的第四个参数是 `signal` 与「lease 已丢失」的合并：执行命令时用它，lease 丢失就中止。
   * - The provider passed to `fn` labels every `exec` with this holder's tag.
   * - `fn` 抛 `SandboxGoneError`（实例已不在）时重建（or take the instance another holder rebuilt）、
   *   以 `recreated: true` 再调用一次；再次 gone 则抛出。其余错误原样抛出。
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
    let e = await this.enter(ctx, p, signal, null);
    try {
      try {
        return await this.runAs(e, p, fn, signal);
      } catch (err) {
        if (!isSandboxGoneError(err)) throw err;
        this.d.log.info("sandbox instance is gone during use; recreating", {
          conversationId: ctx.conversationId,
        });
        const gone: Instance = { handle: e.handle, createdAt: e.createdAt };
        const prev = e;
        await this.leave(ctx.conversationId, prev);
        e = await this.enter(ctx, p, signal, gone);
        return await this.runAs({ ...e, info: { fresh: true, recreated: true } }, p, fn, signal);
      }
    } finally {
      await this.leave(ctx.conversationId, e);
    }
  }

  /** Runs `fn` as the holder `e`: its tag on every exec, its lease's signal. */
  private runAs<T>(
    e: Entered,
    p: SandboxProviderEntry,
    fn: (
      h: SandboxHandle,
      p: SandboxProvider,
      info: SandboxUseInfo,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const sig = AbortSignal.any([signal, e.lease.signal]);
    const conv = e.lease.conversationId;
    const impl = tagged(p.impl, e.lease.token, () => this.register(conv, e.lease.token));
    return fn(e.handle, impl, e.info, sig);
  }

  /**
   * Becomes a holder: loops until it has a shared lease on a running instance, or `sandbox.busy`.
   * A sandbox recorded `running` (with the current provider, not the `gone` instance, and no legacy
   * busy marker) is used under a shared lease; otherwise the exclusive lease (with intent) makes it
   * run and is downgraded. One token serves both, so the waiter passes its own intent.
   */
  private async enter(
    ctx: { orgId: string; conversationId: string },
    p: SandboxProviderEntry,
    signal: AbortSignal,
    gone: Instance | null,
  ): Promise<Entered> {
    const conv = ctx.conversationId;
    const cap = this.effectiveCap(p);
    const deadline = Date.now() + this.d.config().sandbox.lockWaitSeconds * 1000;
    const token = randomUUID();
    let intent = false;
    try {
      for (;;) {
        if (signal.aborted) throw abortReason(signal);
        const row = await this.readRow(ctx);
        if (this.usable(row, p, gone) && !(await this.leases.legacyMarker(conv))) {
          const lease = await this.leases.tryShared(conv, cap, token);
          if (lease) {
            if (intent) await this.clearIntent(conv, token);
            intent = false;
            const e = await this.asShared(ctx, p, lease, gone, signal);
            if (e) return e;
          }
        } else {
          const lease = await this.leases.tryExclusive(conv, { token, intent: true });
          intent = lease === null;
          if (lease) return await this.asExclusive(ctx, p, lease, gone, signal);
        }
        if (Date.now() + this.pollMs > deadline) throw sandboxBusy();
        await sleep(this.pollMs + Math.floor(Math.random() * this.pollMs), signal);
      }
    } catch (err) {
      if (intent) await this.clearIntent(conv, token);
      throw err;
    }
  }

  private async clearIntent(conv: string, token: string): Promise<void> {
    await this.leases
      .clearIntent(conv, token)
      .catch((err: unknown) =>
        this.d.log.warn("cannot clear sandbox intent", { conversationId: conv, err }),
      );
  }

  private async readRow(ctx: { orgId: string; conversationId: string }): Promise<Row | undefined> {
    const row = await this.d.db
      .selectFrom("sandboxes")
      .selectAll()
      .where("conversation_id", "=", ctx.conversationId)
      .executeTakeFirst();
    if (row && row.org_id !== ctx.orgId) {
      throw new ApiError(
        "forbidden",
        `The sandbox of conversation ${ctx.conversationId} does not belong to organization ${ctx.orgId}`,
      );
    }
    return row;
  }

  /** Recorded running with the current provider, and not the instance found gone. */
  private usable(
    row: Row | undefined,
    p: SandboxProviderEntry,
    gone: Instance | null,
  ): row is Row & { handle: SandboxHandle } {
    return (
      row !== undefined &&
      row.status === "running" &&
      row.provider === p.plugin &&
      row.handle !== null &&
      !isInstance(row, gone)
    );
  }

  /**
   * Under a just-taken shared lease: confirms the row is still usable (else releases and returns
   * null), records the holder and kills crashed holders' commands.
   */
  private async asShared(
    ctx: { orgId: string; conversationId: string },
    p: SandboxProviderEntry,
    lease: SandboxLease,
    gone: Instance | null,
    signal: AbortSignal,
  ): Promise<Entered | null> {
    const conv = ctx.conversationId;
    try {
      const row = await this.readRow(ctx);
      if (!this.usable(row, p, gone)) {
        await lease.release();
        return null;
      }
      // Bump the fence as every acquisition did before phase C: an exclusive holder whose lease
      // expired unnoticed (a stalled sweep) then fails its next write instead of suspending or
      // destroying the instance under this holder. Shared holders never compare it.
      await this.d.db
        .updateTable("sandboxes")
        .set((eb) => ({ generation: eb("generation", "+", 1) }))
        .where("conversation_id", "=", conv)
        .execute();
      await this.register(conv, lease.token);
      // a shared caller never claims an older kernel's busy marker (it holds no exclusive lease)
      const dead = await this.claim(conv);
      if (dead.tags.length > 0) {
        const sig = AbortSignal.any([signal, lease.signal]);
        const impl = p.impl;
        if (impl.killTagged) {
          // by tag whenever the provider can, even with cap 1: while a hot change of
          // maxConcurrentCommands spreads, a replica on a larger cap may have let a sibling in
          await this.kill(
            conv,
            "takeover",
            async () => impl.killTagged?.(row.handle, dead.tags, sig),
            sig,
          );
        } else if ((await this.leases.sharedCount(conv)) <= 1) {
          // cap 1 and this holder is alone: killing everything cannot hit a sibling
          await this.killLeftovers(conv, row.handle, p, sig, "takeover");
        } else {
          this.d.log.warn(
            "cannot kill leftover sandbox commands: the provider has no killTagged and another holder is live; the in-sandbox time limit ends them",
            { conversationId: conv },
          );
        }
      }
      return {
        lease,
        handle: row.handle,
        createdAt: row.created_at.getTime(),
        info: { fresh: false, recreated: false },
      };
    } catch (err) {
      await this.unregister(conv, lease.token);
      await lease.release();
      throw err;
    }
  }

  /**
   * Under a just-taken exclusive lease: makes the sandbox run (create / resume / rebuild when the
   * recorded instance is the one found gone), kills leftovers, then downgrades to a shared lease.
   */
  private async asExclusive(
    ctx: { orgId: string; conversationId: string },
    p: SandboxProviderEntry,
    lease: SandboxLease,
    gone: Instance | null,
    signal: AbortSignal,
  ): Promise<Entered> {
    const conv = ctx.conversationId;
    const sig = AbortSignal.any([signal, lease.signal]);
    try {
      const s = await this.ensure(ctx, p, lease, sig, gone);
      const dead = await this.claim(conv, lease.token);
      if (!s.info.fresh && (s.resumed || dead.legacyMarker || dead.tags.length > 0)) {
        await this.killLeftovers(
          conv,
          s.handle,
          p,
          sig,
          s.resumed && !dead.legacyMarker && dead.tags.length === 0 ? "resume" : "takeover",
        );
      }
      const shared = await lease.downgrade();
      await this.register(conv, shared.token);
      return { lease: shared, handle: s.handle, createdAt: s.createdAt, info: s.info };
    } catch (err) {
      await this.unregister(conv, lease.token);
      // releases the lease in whatever kind it has now (also after a downgrade)
      await lease.release();
      throw err;
    }
  }

  /** Ends a holder: unregisters it before releasing its lease, then moves `last_used_at` forward. */
  private async leave(conv: string, e: Entered): Promise<void> {
    await this.unregister(conv, e.lease.token);
    await e.lease.release();
    await this.d.db
      .updateTable("sandboxes")
      .set({ last_used_at: sql<Date>`GREATEST(last_used_at, now())` })
      .where("conversation_id", "=", conv)
      .where("status", "=", "running")
      .execute()
      .catch((err: unknown) =>
        this.d.log.warn("cannot update sandbox last_used_at", { conversationId: conv, err }),
      );
  }

  private async register(conv: string, token: string): Promise<void> {
    const ttl = this.d.config().sandbox.limits.maxCommandSeconds * 1000 + HOLDER_TTL_MARGIN_MS;
    await this.leases
      .registerHolder(conv, token, ttl)
      .catch((err: unknown) =>
        this.d.log.warn("cannot record sandbox holder", { conversationId: conv, err }),
      );
  }

  private async unregister(conv: string, token: string): Promise<void> {
    await this.leases
      .unregisterHolder(conv, token)
      .catch((err: unknown) =>
        this.d.log.warn("cannot clear sandbox holder record", { conversationId: conv, err }),
      );
  }

  /**
   * Crashed holders' tags (claimed), and an older kernel's busy marker when `exclusiveToken` is
   * the caller's exclusive lease; a Redis error counts as none.
   */
  private async claim(
    conv: string,
    exclusiveToken?: string,
  ): Promise<{ tags: string[]; legacyMarker: boolean }> {
    try {
      return await this.leases.claimDeadHolders(conv, exclusiveToken);
    } catch (err) {
      this.d.log.warn("cannot read sandbox holder records", { conversationId: conv, err });
      return { tags: [], legacyMarker: false };
    }
  }

  /** Runs one kill call: gone and abort are thrown, other failures only warned. */
  private async kill(
    conversationId: string,
    why: "takeover" | "resume",
    call: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await call();
      if (why === "takeover") {
        this.d.log.info(
          "sandbox taken over from a holder that did not finish; leftover commands killed",
          { conversationId },
        );
      }
    } catch (err) {
      if (signal?.aborted || isSandboxGoneError(err)) throw err;
      this.d.log.warn("cannot kill leftover sandbox commands", { conversationId, err });
    }
  }

  /**
   * 休眠：空闲超过 `suspendAfterIdleMinutes`、或连续运行超过 `maxRunningMinutes` 的运行中沙箱。
   * Skips a sandbox with any holder; one past `maxRunningMinutes` gets the intent for one poll
   * window (about a second) first. 返回本次休眠的个数。由维护队列每分钟调用。
   */
  async suspendIdle(now: Date): Promise<number> {
    const p = this.d.provider();
    if (!p) return 0;
    const due = this.suspendDue(now, p.plugin);
    const runningBefore = new Date(
      now.getTime() - this.d.config().sandbox.limits.maxRunningMinutes * 60_000,
    );
    const rows = await this.candidates(due);
    let n = 0;
    await inPool(rows, SWEEP_CONCURRENCY, async (c) => {
      const overdue = c.running_since !== null && c.running_since < runningBefore;
      const done = await this.tryLocked(
        c.conversation_id,
        async (lease) => {
          const id = c.conversation_id;
          const row = await this.d.db
            .selectFrom("sandboxes")
            .selectAll()
            .where("conversation_id", "=", id)
            .where(due)
            .executeTakeFirst();
          if (!row?.handle) return false;
          const fence = { gen: row.generation };
          await p.impl.suspend(row.handle, opSignal(lease));
          if (!(await lease.renew())) throw new SandboxLockLostError(id);
          await this.fenced(lease, id, fence, {
            status: "suspended",
            suspended_at: sql<Date>`now()`,
            running_since: null,
            sweep_failed_at: null,
          });
          this.d.log.info("sandbox suspended", { conversationId: id });
          return true;
        },
        overdue,
      );
      if (done) n++;
    });
    return n;
  }

  /**
   * 销毁：超过 `destroyAfterInactiveDays` 没用过的、所属组织已删除的、对话已不存在的沙箱
   * （对话已不存在的，销毁后删掉记录）。有 holder 的跳过。返回本次销毁的个数。由维护队列每小时调用。
   */
  async destroyInactive(now: Date): Promise<number> {
    const p = this.d.provider();
    if (!p) return 0;
    const due = this.destroyDue(now);
    const rows = await this.candidates(due);
    let n = 0;
    await inPool(rows, SWEEP_CONCURRENCY, async ({ conversation_id: id }) => {
      const done = await this.tryLocked(id, async (lease) => {
        const row = await this.d.db
          .selectFrom("sandboxes")
          .selectAll()
          .where("conversation_id", "=", id)
          .where(due)
          .executeTakeFirst();
        if (!row) return false;
        await this.destroyRow(row, p, lease);
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
   * Waits for the exclusive lease (with intent, so running commands finish and new ones wait) up
   * to 10 minutes. 没有提供方时只记 warn。
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
    const lease = await this.leases.acquireExclusive(
      conversationId,
      AbortSignal.timeout(DESTROY_FOR_WAIT_MS),
      undefined,
      { intent: true },
    );
    try {
      const current = await this.d.db
        .selectFrom("sandboxes")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("status", "<>", "destroyed")
        .executeTakeFirst();
      if (current) await this.destroyRow(current, p, lease);
    } finally {
      await lease.release();
    }
  }

  /**
   * 接手前任：杀掉沙箱里遗留的全部命令（killAll）。实例已不在（SandboxGoneError）与中止照常抛出（交给 withSandbox 重建 /
   * 结束）；其余失败只记 warn。提供方没有 `killAll` 时只记 info。
   */
  private async killLeftovers(
    conversationId: string,
    handle: SandboxHandle,
    p: SandboxProviderEntry,
    signal: AbortSignal,
    why: "takeover" | "resume",
  ): Promise<void> {
    const killAll = p.impl.killAll;
    if (!killAll) {
      if (why === "takeover") {
        this.d.log.info(
          "sandbox taken over from a holder that did not finish; provider cannot kill its commands",
          { conversationId },
        );
      }
      return;
    }
    await this.kill(conversationId, why, () => killAll.call(p.impl, handle, signal), signal);
  }

  private require(): SandboxProviderEntry {
    const p = this.d.provider();
    if (!p) throw sandboxUnavailable();
    return p;
  }

  /**
   * 防护写入：lease 仍在、且记录的 generation 仍是锁内读到的值时才写（并加一）；否则抛 {@link SandboxLockLostError}。
   */
  private async fenced(lease: SandboxLease, id: string, fence: Fence, set: Patch): Promise<Date> {
    if (lease.signal.aborted) throw new SandboxLockLostError(id);
    const r = await this.d.db
      .updateTable("sandboxes")
      .set({ ...set, generation: fence.gen + 1 })
      .where("conversation_id", "=", id)
      .where("generation", "=", fence.gen)
      .returning("created_at")
      .executeTakeFirst();
    if (!r) throw new SandboxLockLostError(id, "generation");
    fence.gen++;
    return r.created_at;
  }

  /** 扫描的候选：上次扫描失败的排在后面，其余按最久未用在前。 */
  private async candidates(
    due: (eb: ExpressionBuilder<KernelDatabase, "sandboxes">) => Expression<SqlBool>,
  ): Promise<{ conversation_id: string; running_since: Date | null }[]> {
    return await this.d.db
      .selectFrom("sandboxes")
      .select(["conversation_id", "running_since"])
      .where(due)
      .orderBy(sql`sweep_failed_at ASC NULLS FIRST`)
      .orderBy("last_used_at")
      .limit(SWEEP_BATCH)
      .execute();
  }

  /**
   * One try at the exclusive lease: null → false; else runs `fn`. With `overdue` (past
   * `maxRunningMinutes`) a busy sandbox gets the intent for about a second, so new commands wait
   * briefly and the sweep gets in if the running ones end. Failures are warned, recorded in
   * `sweep_failed_at` (sorted last next time) and return false.
   */
  private async tryLocked(
    conversationId: string,
    fn: (lease: SandboxLease) => Promise<boolean>,
    overdue = false,
  ): Promise<boolean> {
    let lease: SandboxLease | null;
    try {
      lease = await this.leases.tryExclusive(conversationId);
      if (!lease && overdue) {
        lease = await this.leases
          .acquireExclusive(
            conversationId,
            AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS),
            Math.max(this.pollMs * 2, SWEEP_INTENT_WAIT_MS),
            { intent: true },
          )
          .catch((err: unknown) => {
            if (err instanceof ApiError && err.code === "sandbox.busy") return null;
            throw err;
          });
      }
    } catch (err) {
      this.d.log.warn("cannot take sandbox lock", { conversationId, err });
      return false;
    }
    if (!lease) return false;
    try {
      return await fn(lease);
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
      await lease.release();
    }
  }

  /**
   * Under the exclusive lease: make the conversation's sandbox run. `gone`: the instance a holder
   * found gone; when it is still the recorded one it is rebuilt, when another holder already
   * rebuilt it the new one is used.
   */
  private async ensure(
    ctx: { orgId: string; conversationId: string },
    p: SandboxProviderEntry,
    held: SandboxLease,
    signal: AbortSignal,
    gone: Instance | null,
  ): Promise<{
    handle: SandboxHandle;
    createdAt: number;
    info: SandboxUseInfo;
    fence: Fence;
    resumed?: boolean;
  }> {
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
    const createdAt = row.created_at.getTime();
    if (handle && row.provider === p.plugin && isInstance(row, gone) && row.status === "running") {
      const created = await this.create(ctx, p, held, fence, signal, {});
      return { ...created, info: { fresh: true, recreated: true }, fence };
    }
    if (handle && row.provider === p.plugin) {
      if (row.status === "running") {
        return { handle, createdAt, info: { fresh: false, recreated: false }, fence };
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
          return {
            handle,
            createdAt,
            info: { fresh: false, recreated: false },
            fence,
            resumed: true,
          };
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
    return { ...created, info: { fresh: true, recreated: row.had_instance }, fence };
  }

  /**
   * 在锁内创建：先防护地重置为 creating，再调提供方，最后防护地写入句柄。
   * 写句柄时发现锁已丢失：尽力销毁刚建好的实例，再抛 {@link SandboxLockLostError}。
   */
  private async create(
    ctx: { orgId: string; conversationId: string },
    p: SandboxProviderEntry,
    held: SandboxLease,
    fence: Fence,
    signal: AbortSignal,
    extra: Patch,
  ): Promise<Instance> {
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
    let createdAt: Date;
    try {
      createdAt = await this.fenced(held, id, fence, {
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
    return { handle, createdAt: createdAt.getTime() };
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
  private async destroyRow(row: Row, p: SandboxProviderEntry, held: SandboxLease): Promise<void> {
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
