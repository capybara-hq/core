import { randomUUID } from "node:crypto";
import {
  DIRECTORY_CAPABILITY,
  type Directory,
  type DirectoryMember,
  type ExternalIdentity,
  type Logger,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import type { ExternalIdentities } from "../identity/external.js";
import type { PluginHost } from "../plugins/host.js";
import type { OrgPluginConfigs } from "../plugins/org-config.js";
import { ConversationLock } from "../runtime/conversation-lock.js";
import type { Maintenance } from "../runtime/maintenance.js";
import type { Offboarding } from "./offboarding.js";
import { lockOrgAndAuthorize, tryLockOrg } from "./org-lock.js";

/** 每小时扫描：维护队列任务名、job scheduler id（不含 `:`）与周期。 */
export const DIRECTORY_SCAN_JOB = "directory-scan";
export const DIRECTORY_SCAN_SCHEDULER_ID = "directory-scan-hourly";
export const DIRECTORY_SCAN_EVERY_MS = 3_600_000;
/** 一次 (组织, 插件) 同步的维护任务名。 */
export const DIRECTORY_SYNC_JOB = "directory-sync";
/** 同步锁的 Redis 键前缀（键为 `<前缀><orgId>:<plugin>`，带 TTL、持有期间续租）。 */
export const DIRECTORY_SYNC_LOCK_PREFIX = "capk:directory-sync:";
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

interface SyncJobData {
  orgId: string;
  plugin: string;
  trigger: DirectorySyncTrigger;
  requestedBy?: string;
  requestedByToken?: string;
}

export interface DirectorySyncDeps {
  db: KernelDb;
  redis: Redis;
  host: Pick<PluginHost, "list">;
  orgPluginConfigs: Pick<OrgPluginConfigs, "get">;
  external: Pick<ExternalIdentities, "resolve">;
  offboarding: Pick<Offboarding, "offboard" | "afterCommit">;
  /** 给了就登记每小时扫描与同步任务（worker 角色执行）；不给时只能直接调用 `sync`。 */
  maintenance?: Pick<Maintenance, "add" | "handle" | "schedule">;
  log: Pick<Logger, "warn" | "info">;
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
 */
export class DirectorySync {
  private readonly lock: ConversationLock;

  constructor(private readonly d: DirectorySyncDeps) {
    this.lock = new ConversationLock(d.redis, d.log, DIRECTORY_SYNC_LOCK_PREFIX);
    const m = d.maintenance;
    if (m) {
      m.schedule({
        id: DIRECTORY_SCAN_SCHEDULER_ID,
        name: DIRECTORY_SCAN_JOB,
        everyMs: () => DIRECTORY_SCAN_EVERY_MS,
      });
      m.handle(DIRECTORY_SCAN_JOB, async () => {
        const targets = await this.scan();
        if (targets.length > 0) d.log.info("directory syncs enqueued", { count: targets.length });
      });
      m.handle(DIRECTORY_SYNC_JOB, async (job) => {
        const data = job.data as SyncJobData;
        const r = await this.sync(data.orgId, data.plugin, data);
        // 通讯录未配置（Ruling A28）静默跳过
        if (r.status === "skipped" && r.reason !== "not_configured") {
          d.log.info("directory sync skipped", {
            orgId: data.orgId,
            plugin: data.plugin,
            reason: r.reason,
          });
        }
      });
    }
  }

  /** 插件提供的 `directory@1`；未加载或不提供时 undefined。 */
  private provider(plugin: string): Directory | undefined {
    return this.d.host
      .list("directory")
      .find((e) => e.plugin === plugin && e.capability === DIRECTORY_CAPABILITY)?.impl as
      | Directory
      | undefined;
  }

  /** 组织存在、插件提供通讯录、在该组织启用且组织级配置满足 schema（复用 `OrgPluginConfigs.get` 的校验）。 */
  private async eligible(orgId: string, plugin: string): Promise<Eligible> {
    const directory = this.provider(plugin);
    if (!directory) return { ok: false, reason: "plugin_unavailable" };
    const org = await this.d.db
      .selectFrom("orgs")
      .select("id")
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!org) return { ok: false, reason: "org_not_found" };
    let cfg: { enabled: boolean; config: unknown } | undefined;
    try {
      cfg = await this.d.orgPluginConfigs.get(orgId, plugin);
    } catch (err) {
      this.d.log.warn("directory sync: stored organization config is invalid", {
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
    const m = this.d.maintenance;
    if (!m) throw new Error("directory sync: maintenance queue is not available");
    if (jobId.includes(":")) throw new Error("directory sync: job id must not contain ':'");
    const data: SyncJobData = {
      orgId,
      plugin,
      trigger,
      ...(requestedBy !== undefined && { requestedBy: requestedBy.accountId }),
      ...(requestedBy?.tokenId !== undefined && { requestedByToken: requestedBy.tokenId }),
    };
    await m.add(DIRECTORY_SYNC_JOB, data, {
      jobId,
      removeOnComplete: { age: KEEP_COMPLETED_SECONDS[trigger] },
      removeOnFail: KEEP_FAILED,
    });
    return jobId;
  }

  /**
   * 管理员手动触发：组织行锁内实时复核 `org.members.manage`，再核对插件可同步
   * （不提供通讯录 → `plugin.not_found`，未启用 → `plugin.not_enabled`，配置不再有效 → `plugin.config_invalid`，
   * 插件说通讯录未配置 → `directory.not_configured`，Ruling A28），
   * 投递一个唯一 id 的同步任务。
   */
  async request(
    orgId: string,
    plugin: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<{ jobId: string }> {
    await this.d.db
      .transaction()
      .execute((t) => lockOrgAndAuthorize(t, orgId, actorAccountId, "org.members.manage"));
    const e = await this.eligible(orgId, plugin);
    if (!e.ok) {
      switch (e.reason) {
        case "plugin_unavailable":
          throw new ApiError("plugin.not_found", `Plugin ${plugin} does not provide a directory`);
        case "org_not_found":
          throw new ApiError("org.not_found", "Organization not found");
        case "not_enabled":
          throw new ApiError(
            "plugin.not_enabled",
            `Plugin ${plugin} is not enabled for this organization`,
          );
        case "config_invalid":
          throw new ApiError(
            "plugin.config_invalid",
            `Invalid organization config for plugin ${plugin}`,
          );
        case "not_configured":
          throw new ApiError(
            "directory.not_configured",
            `The directory of plugin ${plugin} is not configured for this organization`,
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

  /**
   * 每小时扫描：给每个可同步的 (组织, 插件) 投递一次同步（job id 按小时桶），返回投递的目标。
   * 已存配置不再满足 schema 的跳过（记 warn）；单个投递失败记 warn、继续其他目标。
   */
  async scan(now: Date = new Date()): Promise<DirectorySyncTarget[]> {
    const plugins = this.d.host
      .list("directory")
      .filter((e) => e.capability === DIRECTORY_CAPABILITY)
      .map((e) => e.plugin);
    if (plugins.length === 0) return [];
    const rows = await this.d.db
      .selectFrom("plugin_org_configs")
      .innerJoin("orgs", "orgs.id", "plugin_org_configs.org_id")
      .select(["plugin_org_configs.org_id", "plugin_org_configs.plugin"])
      .where("plugin_org_configs.enabled", "=", true)
      .where("orgs.deleted_at", "is", null)
      .where("plugin_org_configs.plugin", "in", plugins)
      .orderBy("plugin_org_configs.org_id")
      .orderBy("plugin_org_configs.plugin")
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
        this.d.log.warn("cannot enqueue directory sync", {
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
    const lease = await this.lock.acquire(`${orgId}:${plugin}`, randomUUID());
    if (!lease) {
      // 在跑的那一轮可能已经读过变化之前的页：记下脏标记，由持有者跑完后补一轮
      await this.d.redis.set(dirtyKey, "1", "EX", DIRECTORY_SYNC_DIRTY_TTL_SECONDS);
      return { status: "skipped", reason: "locked" };
    }
    const abort = new AbortController();
    // 锁丢了（续租失败、过期后被他人取得）：停止本轮，不再移除任何人
    lease.onLost(() => abort.abort(new Error("directory sync lock lost")));
    try {
      return await this.run(orgId, plugin, e.directory, e.orgConfig, abort.signal, opts);
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
      if ((await this.d.redis.getdel(dirtyKey)) === null) return;
      const jobId = `directory-sync-${orgId}-${plugin}-rerun-${randomUUID()}`;
      await this.addJob(orgId, plugin, "changed", jobId);
    } catch (err) {
      this.d.log.warn("directory sync: cannot enqueue follow-up sync", { orgId, plugin, err });
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
            this.d.log.warn("directory sync: cannot add member", { orgId, plugin, err });
          }
        }
        const next = r.next;
        if (typeof next !== "string" || next === "") break;
        if (next === cursor) throw new Error("directory returned the same cursor twice");
        cursor = next;
      }
      listed = true;
    } catch (err) {
      this.d.log.warn("directory sync stopped before listing all members", { orgId, plugin, err });
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
          this.d.log.warn("directory sync: plugin no longer eligible before removals", {
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
        dirty = await this.d.redis.get(directorySyncDirtyKey(orgId, plugin));
      } catch (err) {
        this.d.log.warn("directory sync: cannot read the dirty flag; skipping removals", {
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
      const existing = await this.d.db
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
        this.d.log.warn("directory sync: mass removal blocked", {
          orgId,
          plugin,
          planned: planned.length,
          existing: existing.length,
        });
        await audit(this.d.db, {
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

    await audit(this.d.db, {
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
    return this.d.db.transaction().execute(async (t) => {
      if (!(await tryLockOrg(t, orgId))) throw new OrgGone("organization deleted during sync");
      const { accountId } = await this.d.external.resolve(identity, t, { linkedVia: "directory" });
      const excluded = await t
        .selectFrom("directory_exclusions")
        .select("account_id")
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .where("plugin", "=", plugin)
        .executeTakeFirst();
      if (excluded) return { accountId, added: false };
      const inserted = await t
        .insertInto("memberships")
        .values({ org_id: orgId, account_id: accountId, role: "member", source })
        .onConflict((oc) => oc.columns(["org_id", "account_id"]).doNothing())
        .returning("account_id")
        .executeTakeFirst();
      if (inserted) {
        await audit(t, {
          orgId,
          action: "org.member.added",
          target: accountId,
          detail: { role: "member", source },
        });
      }
      return { accountId, added: inserted !== undefined };
    });
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
      const result = await this.d.db.transaction().execute(async (t) => {
        if (!(await tryLockOrg(t, orgId))) return undefined;
        const row = await t
          .selectFrom("memberships")
          .select("source")
          .where("org_id", "=", orgId)
          .where("account_id", "=", accountId)
          .forUpdate()
          .executeTakeFirst();
        if (row?.source !== source) return undefined;
        return this.d.offboarding.offboard(t, orgId, accountId, "directory");
      });
      if (!result) return "gone";
      await this.d.offboarding.afterCommit(result);
      return "removed";
    } catch (err) {
      if (err instanceof ApiError && err.code === "org.last_owner") return "last_owner";
      this.d.log.warn("directory sync: cannot offboard member", { orgId, plugin, accountId, err });
      return "failed";
    }
  }
}
