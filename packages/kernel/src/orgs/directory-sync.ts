import { randomUUID } from "node:crypto";
import {
  DIRECTORY_EXTENSION_POINT,
  type Directory,
  type DirectoryMember,
  type ExternalIdentity,
} from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { ApiError } from "../errors.js";
import { enabledExtensionsByOrg } from "../extensions/enabled.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { ExternalIdentities } from "../identity/external.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { LegacyPorts } from "../lifecycle/legacy-ports.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { Offboarding, type OffboardResult } from "./offboarding.js";
import { OrgLock } from "./org-lock.js";

/** The hourly scan: cron job name (no `:`). */
export const DIRECTORY_SCAN_JOB = "directory-scan";
/** The maintenance job scheduler id it had before it became a cron (retired at worker start). */
export const DIRECTORY_SCAN_SCHEDULER_ID = "directory-scan-hourly";
/** The job name of one (org, extension) sync on the maintenance queue. */
export const DIRECTORY_SYNC_JOB = "directory-sync";
/** The run lock's TTL (renewed while held); a crashed holder's lock expires within it. */
export const DIRECTORY_SYNC_LOCK_TTL_MS = 30_000;
/** The `LockService` key of one (org, extension) sync: one sync at a time. */
export const directorySyncLockKey = (orgId: string, plugin: string) =>
  `directory-sync:${orgId}:${plugin}`;
/** 脏标记的保留时长（秒）：锁被占时记下，持有者跑完后取走并补一轮。 */
export const DIRECTORY_SYNC_DIRTY_TTL_SECONDS = 3_600;
/** 脏标记（Redis 键）：同步进行中又有同步请求被锁挡掉。 */
export const directorySyncDirtyKey = (orgId: string, plugin: string) =>
  `capk:directory-sync-dirty:${orgId}:${plugin}`;
/**
 * Ruling A17 大批移除保护（非手动触发）：计划移除数超过 `max(下限, 比例 × 现有通讯录成员数)`，
 * 或列表里一个在职成员都没有而已有通讯录成员时，本轮当作不完整、不移除任何人。
 */
export const DIRECTORY_REMOVAL_GUARD_MIN = 5;
export const DIRECTORY_REMOVAL_GUARD_RATIO = 0.2;
/** 单页 `listMembers` 的时限。 */
export const DIRECTORY_PAGE_TIMEOUT_MS = 60_000;
/** 一轮同步最多翻的页数：防止插件反复返回游标让任务无限长（超出按中途失败处理）。 */
export const DIRECTORY_MAX_PAGES = 10_000;

/** 触发来源：每小时扫描、入站 `directory_changed` 提示、管理员手动。 */
export type DirectorySyncTrigger = "schedule" | "changed" | "manual";

/** 完成的 job id 保留时长（秒）：保留期内同一 id 的重复投递被 BullMQ 去重。 */
const KEEP_COMPLETED_SECONDS: Record<DirectorySyncTrigger, number> = {
  schedule: 7_200,
  changed: 120,
  manual: 3_600,
};
const KEEP_FAILED = { age: 86_400 };

/**
 * 不同步的原因（陈旧任务、插件已停用 / 配置不再有效、组织已删除、另一同步在跑；`not_configured`：插件的
 * `Directory.configured` 说这份组织配置没配好通讯录，Ruling A28，静默跳过）。
 */
export type DirectorySkipReason =
  | "plugin_unavailable"
  | "org_not_found"
  | "not_enabled"
  | "config_invalid"
  | "not_configured"
  | "locked";

export type DirectorySyncResult =
  | { status: "skipped"; reason: DirectorySkipReason }
  | {
      status: "synced";
      /** 新加入的成员关系数。 */
      added: number;
      /** 离职处理（撤销成员关系）的人数。 */
      removed: number;
      /** 是该组织最后一个 owner、因而跳过的人数。 */
      skippedLastOwner: number;
      /** 处理失败的成员数（资料不合规、加入或离职事务失败）。 */
      failed: number;
      /** 通讯录返回的成员总数（含离职的）。 */
      total: number;
      /** 分页没有完整走完、有成员处理失败或被大批移除保护拦下：只加人，不移除任何人。 */
      partial: boolean;
      /** 被大批移除保护（Ruling A17）拦下。 */
      removalBlocked: boolean;
      /** 本轮持锁期间来过通讯录变更（Ruling A32）：不移除，由随后的补跑移除。 */
      partialReason?: "changed_during_sync";
    };

/** 一个 (组织, 插件) 投递目标。 */
export interface DirectorySyncTarget {
  orgId: string;
  plugin: string;
  jobId: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** UTC 小时桶，如 `2026102014`（不含 `:`）。 */
export function hourBucket(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
}

/** UTC 分钟桶，如 `202610201405`。 */
export function minuteBucket(d: Date = new Date()): string {
  return `${hourBucket(d)}${pad(d.getUTCMinutes())}`;
}

/**
 * 同步任务的 job id（不含 `:`）：扫描按小时桶（`directory-sync-<org>-<plugin>-<小时桶>`）、
 * `directory_changed` 按分钟桶去重；手动触发每次唯一，不会被同一小时的扫描任务吞掉。
 */
export function directorySyncJobId(
  orgId: string,
  plugin: string,
  trigger: DirectorySyncTrigger,
  now: Date = new Date(),
): string {
  const base = `directory-sync-${orgId}-${plugin}`;
  switch (trigger) {
    case "schedule":
      return `${base}-${hourBucket(now)}`;
    case "changed":
      return `${base}-changed-${minuteBucket(now)}`;
    case "manual":
      return `${base}-manual-${randomUUID()}`;
  }
}

/** The data of a `directory-sync` job. */
export interface SyncJobData {
  orgId: string;
  plugin: string;
  trigger: DirectorySyncTrigger;
  requestedBy?: string;
  requestedByToken?: string;
}

/** 组织已删除（同步途中）：停止本轮。 */
class OrgGone extends Error {}

type Eligible =
  | { ok: true; directory: Directory; orgConfig: unknown }
  | { ok: false; reason: Exclude<DirectorySkipReason, "locked"> };

/**
 * 通讯录同步（`directory@1`）：把企业通讯录同步为组织成员。框架无关。
 *
 * - 维护队列每小时 `directory-scan`：给每个「插件提供 `directory@1`、在该组织启用、组织级配置满足 schema」的
 *   (组织, 插件) 投递一次同步（job id 按小时桶去重，多副本重复扫描只跑一次）；手动与 `directory_changed` 也投递同步。
 * - 同一 (组织, 插件) 同时只跑一个同步（Redis 锁 `capk:directory-sync:<org>:<plugin>`，持有期间续租）；
 *   锁被占时本任务记下脏标记 `capk:directory-sync-dirty:<org>:<plugin>`（1 小时）后结束；持有者释放锁后 GETDEL
 *   取走标记，有就投递一次 changed 同步（在跑的那一轮可能已经读过变化之前的页）。Ruling A32：移除阶段前 GET
 *   （不取走）脏标记，有就本轮按不完整处理、不移除任何人（审计 `partialReason = changed_during_sync`），移除留给补跑。
 *   After writing the flag, a blocked sync tries the lock once more: when the holder finished in
 *   between (and its GETDEL found no flag), this sync clears the flag and runs itself.
 * - Ruling A17：非手动触发的一轮，计划移除数超过 `max(5, 20% × 现有通讯录成员数)`，或列表里没有在职成员而已有
 *   通讯录成员时，当作不完整、不移除任何人，审计 `org.directory.removal_blocked`；手动触发不受此限。
 * - 分页 `listMembers`：在职成员按 `<插件>:<租户>` + externalId 解析外部身份（不合并既有账号、不登录、不建会话），
 *   不是成员就加入（角色 member，`memberships.source = "directory:<插件>"`），每人一个短事务；新身份行记
 *   `linked_via = directory`。被管理员手动移出（或本人离开）而记下通讯录排除的人不加回（Ruling A20），
 *   直到有人手动重新加入。
 * - **整轮分页成功走完、且没有成员处理失败**、并且移除前再次复核插件仍可同步（仍启用、配置仍有效；中途被停用或
 *   配置变得无效则本轮按不完整处理）之后，才对「离职（active = false）或不再出现、且 source 为该通讯录」的
 *   成员逐个走离职处理（每人一个事务：组织行锁 → 成员关系行锁 → `Offboarding.offboard`）；中途失败只加人不删人。
 *   手动 / 邀请加入的成员（source 为空）永远不被同步移除；账号本身不停用。最后一个 owner 跳过并计数。
 * - Ruling A28：插件实现了 `Directory.configured` 且对该组织配置返回 false（通讯录未配置，组织只用插件的别的
 *   能力）时，扫描、`directory_changed` 与执行时的复核都静默跳过（不投递、不审计、不记警告），手动触发 409
 *   `directory.not_configured`。
 * - 审计 `org.directory.synced`（计数、是否不完整）。任务执行时再核对插件与配置：已停用的插件的陈旧任务什么都不做。
 *
 * The hourly scan is a `@LockedCron`; one-off syncs are jobs on the maintenance queue (same name and
 * job ids as before), consumed by the maintenance worker until Task 3.9 builds its `@Processor`.
 */
@Injectable()
export class DirectorySync {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
    // the org extension configs (Task 3.3 converts them)
    @Inject(LegacyPorts) private readonly ports: LegacyPorts,
    @Inject(ExternalIdentities) private readonly external: Pick<ExternalIdentities, "resolve">,
    @Inject(Offboarding)
    private readonly offboarding: Pick<Offboarding, "offboard" | "afterOffboard">,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME)) private readonly queue: Pick<Queue, "add">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  /** The hourly scan (once per tick across replicas). */
  @LockedCron("0 * * * *", { name: DIRECTORY_SCAN_JOB })
  async scanJob(): Promise<void> {
    const targets = await this.scan();
    if (targets.length > 0) this.log.info("directory syncs enqueued", { count: targets.length });
  }

  /** A `directory-sync` job (the maintenance worker's handler until Task 3.9). */
  async runSyncJob(data: SyncJobData): Promise<void> {
    const r = await this.sync(data.orgId, data.plugin, data);
    // 通讯录未配置（Ruling A28）静默跳过
    if (r.status === "skipped" && r.reason !== "not_configured") {
      this.log.info("directory sync skipped", {
        orgId: data.orgId,
        plugin: data.plugin,
        reason: r.reason,
      });
    }
  }

  /** 插件提供的 `directory@1`；未加载或不提供时 undefined。 */
  private provider(plugin: string): Directory | undefined {
    return this.registry
      .list("directory")
      .find((e) => e.plugin === plugin && e.capability === DIRECTORY_EXTENSION_POINT)?.impl as
      | Directory
      | undefined;
  }

  /** The org exists, the extension provides a directory, is enabled in the org and its org config satisfies the schema (reuses the `OrgExtensionConfigs.get` validation). */
  private async eligible(orgId: string, plugin: string): Promise<Eligible> {
    const directory = this.provider(plugin);
    if (!directory) return { ok: false, reason: "plugin_unavailable" };
    const org = await this.db
      .selectFrom("orgs")
      .select("id")
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!org) return { ok: false, reason: "org_not_found" };
    let cfg: { enabled: boolean; config: unknown } | undefined;
    try {
      cfg = await this.ports.orgExtensionConfigs.get(orgId, plugin);
    } catch (err) {
      this.log.warn("directory sync: stored organization config is invalid", {
        orgId,
        plugin,
        err,
      });
      return { ok: false, reason: "config_invalid" };
    }
    if (!cfg?.enabled) return { ok: false, reason: "not_enabled" };
    // Ruling A28：插件说通讯录没配好（组织只用它的别的能力）→ 不同步；插件实现出错按未配置处理
    if (directory.configured !== undefined) {
      let configured = false;
      try {
        configured = directory.configured(cfg.config) === true;
      } catch {
        configured = false;
      }
      if (!configured) return { ok: false, reason: "not_configured" };
    }
    return { ok: true, directory, orgConfig: cfg.config };
  }

  /**
   * 投递一次 `directory_changed` 同步（按分钟桶去重）；返回 job id。入站 `directory_changed` 经
   * {@link DirectorySyncScheduler} 调用这里。通讯录未配置（`Directory.configured` 返回 false，Ruling A28）时
   * 静默不投递，返回 undefined；其他不可同步的情况照常投递，由任务执行时跳过。
   */
  async enqueue(
    orgId: string,
    plugin: string,
    now: Date = new Date(),
  ): Promise<string | undefined> {
    const e = await this.eligible(orgId, plugin);
    if (!e.ok && e.reason === "not_configured") return undefined;
    return this.addJob(orgId, plugin, "changed", directorySyncJobId(orgId, plugin, "changed", now));
  }

  private async addJob(
    orgId: string,
    plugin: string,
    trigger: DirectorySyncTrigger,
    jobId: string,
    requestedBy?: { accountId: string; tokenId?: string | undefined },
  ): Promise<string> {
    if (jobId.includes(":")) throw new Error("directory sync: job id must not contain ':'");
    const data: SyncJobData = {
      orgId,
      plugin,
      trigger,
      ...(requestedBy !== undefined && { requestedBy: requestedBy.accountId }),
      ...(requestedBy?.tokenId !== undefined && { requestedByToken: requestedBy.tokenId }),
    };
    await this.queue.add(DIRECTORY_SYNC_JOB, data, {
      jobId,
      // the maintenance queue's jobs run once (no retry), as before
      attempts: 1,
      removeOnComplete: { age: KEEP_COMPLETED_SECONDS[trigger] },
      removeOnFail: KEEP_FAILED,
    });
    return jobId;
  }

  /**
   * Manual trigger by an admin: re-checks `org.members.manage` live under the org row lock, then that
   * the extension can sync (does not provide a directory -> `extension.not_found`, not enabled ->
   * `extension.not_enabled`, config no longer valid -> `extension.config_invalid`, the extension says
   * the directory is not configured -> `directory.not_configured`, Ruling A28), and enqueues a sync
   * job with a unique id.
   */
  async request(
    orgId: string,
    plugin: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<{ jobId: string }> {
    await this.authorize(orgId, actorAccountId);
    const e = await this.eligible(orgId, plugin);
    if (!e.ok) {
      switch (e.reason) {
        case "plugin_unavailable":
          throw new ApiError(
            "extension.not_found",
            `Extension ${plugin} does not provide a directory`,
          );
        case "org_not_found":
          throw new ApiError("org.not_found", "Organization not found");
        case "not_enabled":
          throw new ApiError(
            "extension.not_enabled",
            `Extension ${plugin} is not enabled for this organization`,
          );
        case "config_invalid":
          throw new ApiError(
            "extension.config_invalid",
            `Invalid organization config for extension ${plugin}`,
          );
        case "not_configured":
          throw new ApiError(
            "directory.not_configured",
            `The directory of extension ${plugin} is not configured for this organization`,
          );
      }
    }
    const jobId = await this.addJob(
      orgId,
      plugin,
      "manual",
      directorySyncJobId(orgId, plugin, "manual"),
      { accountId: actorAccountId, tokenId: actorTokenId },
    );
    return { jobId };
  }

  @Transactional()
  private async authorize(orgId: string, actorAccountId: string): Promise<void> {
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "org.members.manage");
  }

  /**
   * 每小时扫描：给每个可同步的 (组织, 插件) 投递一次同步（job id 按小时桶），返回投递的目标。
   * 已存配置不再满足 schema 的跳过（记 warn）；单个投递失败记 warn、继续其他目标。
   */
  async scan(now: Date = new Date()): Promise<DirectorySyncTarget[]> {
    const plugins = this.registry
      .list("directory")
      .filter((e) => e.capability === DIRECTORY_EXTENSION_POINT)
      .map((e) => e.plugin);
    if (plugins.length === 0) return [];
    const rows = await this.db
      .selectFrom(enabledExtensionsByOrg(this.db.db).as("en"))
      .innerJoin("orgs", "orgs.id", "en.org_id")
      .select(["en.org_id", "en.plugin"])
      .where("orgs.deleted_at", "is", null)
      .where("en.plugin", "in", plugins)
      .orderBy("en.org_id")
      .orderBy("en.plugin")
      .execute();
    const out: DirectorySyncTarget[] = [];
    for (const r of rows) {
      const e = await this.eligible(r.org_id, r.plugin);
      if (!e.ok) continue;
      try {
        const jobId = await this.addJob(
          r.org_id,
          r.plugin,
          "schedule",
          directorySyncJobId(r.org_id, r.plugin, "schedule", now),
        );
        out.push({ orgId: r.org_id, plugin: r.plugin, jobId });
      } catch (err) {
        this.log.warn("cannot enqueue directory sync", {
          orgId: r.org_id,
          plugin: r.plugin,
          err,
        });
      }
    }
    return out;
  }

  /** 执行一轮同步（维护任务的处理函数；测试可直接调用）。 */
  async sync(
    orgId: string,
    plugin: string,
    opts: {
      trigger?: DirectorySyncTrigger;
      requestedBy?: string | undefined;
      requestedByToken?: string | undefined;
    } = {},
  ): Promise<DirectorySyncResult> {
    const e = await this.eligible(orgId, plugin);
    if (!e.ok) return { status: "skipped", reason: e.reason };
    const dirtyKey = directorySyncDirtyKey(orgId, plugin);
    const lockKey = directorySyncLockKey(orgId, plugin);
    const lockOpts = { ttlMs: DIRECTORY_SYNC_LOCK_TTL_MS };
    let lease = await this.lockService.acquire(lockKey, lockOpts);
    if (!lease) {
      // 在跑的那一轮可能已经读过变化之前的页：记下脏标记，由持有者跑完后补一轮
      await this.redis.set(dirtyKey, "1", "EX", DIRECTORY_SYNC_DIRTY_TTL_SECONDS);
      // The holder may have released the lock and taken the flag (GETDEL) between the failed
      // attempt and the write above: the flag would then wait an hour with nobody to rerun, and
      // the next sync would skip its removals. Try the lock once more after the write: if it is
      // still held, its holder takes the flag after releasing; if not, run this sync now.
      lease = await this.lockService.acquire(lockKey, lockOpts);
      if (!lease) return { status: "skipped", reason: "locked" };
      // No page has been read yet, so this run covers every change flagged so far.
      await this.redis.del(dirtyKey);
    }
    // 锁丢了（续租失败、过期后被他人取得）：停止本轮，不再移除任何人
    const signal = lease.lost;
    try {
      return await this.run(orgId, plugin, e.directory, e.orgConfig, signal, opts);
    } finally {
      await lease.release().catch(() => {});
      await this.rerunIfDirty(orgId, plugin, dirtyKey);
    }
  }

  /**
   * 释放锁之后取走脏标记（GETDEL，只有一个副本取得到）；有标记就投递一次 changed 同步。
   * job id 每次唯一（`…-rerun-<uuid>`）：不能被刚刚被挡掉的同一分钟的 changed 任务 id 吞掉。失败只记 warn。
   */
  private async rerunIfDirty(orgId: string, plugin: string, dirtyKey: string): Promise<void> {
    try {
      if ((await this.redis.getdel(dirtyKey)) === null) return;
      const jobId = `directory-sync-${orgId}-${plugin}-rerun-${randomUUID()}`;
      await this.addJob(orgId, plugin, "changed", jobId);
    } catch (err) {
      this.log.warn("directory sync: cannot enqueue follow-up sync", { orgId, plugin, err });
    }
  }

  private async run(
    orgId: string,
    plugin: string,
    directory: Directory,
    orgConfig: unknown,
    signal: AbortSignal,
    opts: {
      trigger?: DirectorySyncTrigger;
      requestedBy?: string | undefined;
      requestedByToken?: string | undefined;
    },
  ): Promise<DirectorySyncResult> {
    const source = `directory:${plugin}`;
    const counts = { added: 0, removed: 0, skippedLastOwner: 0, failed: 0, total: 0 };
    /** 本轮仍在职的账号（只在本次任务内使用）。 */
    const seen = new Set<string>();
    /** 列表里在职（active = true）的成员数（含处理失败的）。 */
    let active = 0;
    let listed = false;
    try {
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= DIRECTORY_MAX_PAGES) {
          throw new Error(`directory returned more than ${DIRECTORY_MAX_PAGES} pages`);
        }
        signal.throwIfAborted();
        const r = await directory.listMembers({
          orgConfig,
          ...(cursor !== undefined && { cursor }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(DIRECTORY_PAGE_TIMEOUT_MS)]),
        });
        signal.throwIfAborted();
        if (!Array.isArray(r?.members)) throw new Error("directory returned no members array");
        for (const m of r.members) {
          counts.total++;
          // 离职的人在整轮完成后统一处理（只处理由本通讯录加入的）
          if (m?.active !== true) continue;
          active++;
          try {
            const { accountId, added } = await this.addMember(orgId, plugin, source, m);
            seen.add(accountId);
            if (added) counts.added++;
          } catch (err) {
            if (err instanceof OrgGone) throw err;
            counts.failed++;
            this.log.warn("directory sync: cannot add member", { orgId, plugin, err });
          }
        }
        const next = r.next;
        if (typeof next !== "string" || next === "") break;
        if (next === cursor) throw new Error("directory returned the same cursor twice");
        cursor = next;
      }
      listed = true;
    } catch (err) {
      this.log.warn("directory sync stopped before listing all members", { orgId, plugin, err });
    }

    const trigger = opts.trigger ?? "manual";
    let partial = !listed || counts.failed > 0;
    let removalBlocked = false;
    if (!partial) {
      // 移除前复核：同步途中插件可能已被停用、组织级配置可能已变得无效，此时列表不再可信，不移除任何人
      const still = await this.eligible(orgId, plugin);
      if (!still.ok) {
        partial = true;
        // 途中通讯录配置被清空（Ruling A28）：照样不移除，但不记警告
        if (still.reason !== "not_configured") {
          this.log.warn("directory sync: plugin no longer eligible before removals", {
            orgId,
            plugin,
            reason: still.reason,
          });
        }
      }
    }
    // Ruling A32：本轮持锁期间来过变更（另一任务因锁被占记下了脏标记）——已读过的页可能早于变更，列表不再可信，
    // 本轮不移除任何人；结束时 rerunIfDirty 取走标记补跑一轮，由那一轮移除。这里只 GET，不能取走标记。
    let partialReason: "changed_during_sync" | undefined;
    if (!partial) {
      let dirty: string | null;
      try {
        dirty = await this.redis.get(directorySyncDirtyKey(orgId, plugin));
      } catch (err) {
        this.log.warn("directory sync: cannot read the dirty flag; skipping removals", {
          orgId,
          plugin,
          err,
        });
        dirty = "1";
      }
      if (dirty !== null) {
        partial = true;
        partialReason = "changed_during_sync";
      }
    }
    if (!partial) {
      const existing = await this.db
        .selectFrom("memberships")
        .select("account_id")
        .where("org_id", "=", orgId)
        .where("source", "=", source)
        .orderBy("account_id")
        .execute();
      const planned = existing.filter((c) => !seen.has(c.account_id));
      // Ruling A17：非手动触发的一轮要移除太多人（或通讯录忽然一个在职的人都没有）时，多半是插件或平台出错，先不删
      const threshold = Math.max(
        DIRECTORY_REMOVAL_GUARD_MIN,
        Math.floor(DIRECTORY_REMOVAL_GUARD_RATIO * existing.length),
      );
      if (
        trigger !== "manual" &&
        (planned.length > threshold || (active === 0 && existing.length > 0))
      ) {
        partial = true;
        removalBlocked = true;
        this.log.warn("directory sync: mass removal blocked", {
          orgId,
          plugin,
          planned: planned.length,
          existing: existing.length,
        });
        await audit(this.db.db, {
          orgId,
          action: "org.directory.removal_blocked",
          target: plugin,
          detail: {
            plugin,
            trigger,
            planned: planned.length,
            existing: existing.length,
            active,
            threshold,
          },
        });
      }
      for (const c of removalBlocked ? [] : planned) {
        if (signal.aborted) {
          partial = true;
          break;
        }
        const outcome = await this.offboardOne(orgId, plugin, source, c.account_id);
        if (outcome === "removed") counts.removed++;
        else if (outcome === "last_owner") counts.skippedLastOwner++;
        else if (outcome === "failed") counts.failed++;
      }
    }

    await audit(this.db.db, {
      ...(opts.requestedBy !== undefined && { actorAccountId: opts.requestedBy }),
      ...(opts.requestedByToken !== undefined && { actorTokenId: opts.requestedByToken }),
      orgId,
      action: "org.directory.synced",
      target: plugin,
      detail: {
        plugin,
        trigger,
        ...counts,
        partial,
        removalBlocked,
        ...(partialReason !== undefined && { partialReason }),
      },
    });
    return {
      status: "synced",
      ...counts,
      partial,
      removalBlocked,
      ...(partialReason !== undefined && { partialReason }),
    };
  }

  /**
   * 一个在职成员：解析外部身份（不合并、不登录，新身份行 `linked_via = directory`），不是成员就以 member 加入
   * （source = 本通讯录）；此人在该组织有本通讯录的排除（被手动移出 / 本人离开过）时不加入。
   * 组织行锁内完成（与移出成员同一把锁、与移出时写排除串行），组织已删除 → {@link OrgGone}。
   */
  private async addMember(
    orgId: string,
    plugin: string,
    source: string,
    m: DirectoryMember,
  ): Promise<{ accountId: string; added: boolean }> {
    const tenantId = typeof m.tenantId === "string" ? m.tenantId : "";
    const identity: ExternalIdentity = {
      source: `${plugin}:${tenantId}`,
      externalId: m.externalId,
      tenantId,
      ...(typeof m.email === "string" && { email: m.email }),
      emailVerified: m.emailVerified === true,
      displayName: m.displayName,
    };
    return this.addMemberIn(orgId, plugin, source, identity);
  }

  /** One short transaction per member, under the org row lock. */
  @Transactional()
  private async addMemberIn(
    orgId: string,
    plugin: string,
    source: string,
    identity: ExternalIdentity,
  ): Promise<{ accountId: string; added: boolean }> {
    if (!(await this.orgLock.tryLock(orgId))) throw new OrgGone("organization deleted during sync");
    const { accountId } = await this.external.resolve(identity, { linkedVia: "directory" });
    const excluded = await this.db
      .selectFrom("directory_exclusions")
      .select("account_id")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("plugin", "=", plugin)
      .executeTakeFirst();
    if (excluded) return { accountId, added: false };
    const inserted = await this.db
      .insertInto("memberships")
      .values({ org_id: orgId, account_id: accountId, role: "member", source })
      .onConflict((oc) => oc.columns(["org_id", "account_id"]).doNothing())
      .returning("account_id")
      .executeTakeFirst();
    if (inserted) {
      await audit(this.db.db, {
        orgId,
        action: "org.member.added",
        target: accountId,
        detail: { role: "member", source },
      });
    }
    return { accountId, added: inserted !== undefined };
  }

  /**
   * 一个离职者：独立事务内先锁组织行、再锁其成员关系行（与 `switchCurrentOrg` / 移出成员同一顺序），
   * 确认仍是本通讯录加入的，再走 `Offboarding.offboard`（吊销会话与令牌、删个人凭据、转交 agent 都在这个事务里）。
   * 最后一个 owner → 回滚并返回 `last_owner`；期间已被移除或不再是本通讯录加入的 → `gone`。
   */
  private async offboardOne(
    orgId: string,
    plugin: string,
    source: string,
    accountId: string,
  ): Promise<"removed" | "last_owner" | "gone" | "failed"> {
    try {
      const result = await this.offboardIn(orgId, source, accountId);
      return result ? "removed" : "gone";
    } catch (err) {
      if (err instanceof ApiError && err.code === "org.last_owner") return "last_owner";
      this.log.warn("directory sync: cannot offboard member", { orgId, plugin, accountId, err });
      return "failed";
    }
  }

  @Transactional()
  private async offboardIn(
    orgId: string,
    source: string,
    accountId: string,
  ): Promise<OffboardResult | undefined> {
    if (!(await this.orgLock.tryLock(orgId))) return undefined;
    const row = await this.db
      .selectFrom("memberships")
      .select("source")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
    if (row?.source !== source) return undefined;
    const result = await this.offboarding.offboard(orgId, accountId, "directory");
    // the markers, events and run stops follow the root commit (none after a rollback)
    afterCommit(() => this.offboarding.afterOffboard(result));
    return result;
  }
}
