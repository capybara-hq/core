import type { PluginManifest } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import semver from "semver";
import type { KernelDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import {
  blockingKeys,
  diffPermissions,
  type PermissionSet,
  permissionKeys,
} from "./permission-set.js";

/** 已批准的权限快照（`capybara.plugin_permission_snapshots` 一行）。 */
export interface PermissionSnapshot {
  plugin: string;
  version: string;
  permissions: PermissionSet;
  approvedBy: string | null;
  approvedAt: Date;
  source: "cli" | "auto";
}

/**
 * 待批准、本次不加载的插件（`PluginHost.pending()` / `capybara plugins review` 的一项）。
 * reason：new = 没有快照（首次出现）；added = 比快照多出权限；
 * dependency = 自身无需批准，但 `requires` 的某个能力只由待批准（或因此不加载）的插件提供。
 */
export interface PendingPlugin {
  plugin: string;
  version: string;
  added: string[];
  removed: string[];
  reason: "new" | "added" | "dependency";
  /** reason 为 dependency 时：阻塞它的能力与提供方（只有不加载的提供方）。 */
  blockedBy?: { capability: string; providers: string[] }[];
}

/** {@link planApprovals} 对单个插件的结论。 */
export type ApprovalDecision =
  | {
      plugin: string;
      action: "load";
      /** 需要批准但 autoApprove 开启：调用方以 source auto 写快照。 */
      autoApprove: boolean;
      added: string[];
      removed: string[];
      /** 快照需要写入或更新（无快照、权限或版本变了）。 */
      changed: boolean;
    }
  | { plugin: string; action: "pending"; pending: PendingPlugin };

/**
 * 按依赖拓扑序（`ordered`）比对快照，决定每个插件加载还是待批准：
 * - 无快照或比快照多出任何需要批准的一项（{@link blockingKeys}：`ui.view:*` 除外）→ 待批准
 *   （`autoApprove` 时改为加载，由调用方写快照）；只多出 `ui.view:*` 时照常加载，`changed` 为真，
 *   调用方经 `refresh` 把它们补进快照；
 * - 权限变少或不变 → 加载，`changed` 表示快照需要更新（权限或版本变了）；版本比快照旧时照常加载但不更新快照；
 * - 某个 `requires` 能力的提供方全都不加载 → 同样不加载（reason dependency）；`optional` 不受影响。
 */
export function planApprovals(
  ordered: PluginManifest[],
  sets: Map<string, PermissionSet>,
  snapshots: Map<string, PermissionSnapshot>,
  opts: { autoApprove?: boolean } = {},
): ApprovalDecision[] {
  const skipped = new Set<string>();
  const out: ApprovalDecision[] = [];
  for (const m of ordered) {
    const set = sets.get(m.name) as PermissionSet;
    const snap = snapshots.get(m.name);
    const { added, removed } = diffPermissions(snap?.permissions, set);
    const needsApproval = !snap || blockingKeys(added).length > 0;
    if (needsApproval && !opts.autoApprove) {
      skipped.add(m.name);
      out.push({
        plugin: m.name,
        action: "pending",
        pending: {
          plugin: m.name,
          version: m.version,
          added,
          removed,
          reason: snap ? "added" : "new",
        },
      });
      continue;
    }
    const blockedBy: { capability: string; providers: string[] }[] = [];
    for (const cap of m.requires ?? []) {
      const providers = ordered.filter((p) => p.provides.includes(cap)).map((p) => p.name);
      if (providers.length > 0 && providers.every((p) => skipped.has(p))) {
        blockedBy.push({ capability: cap, providers });
      }
    }
    if (blockedBy.length > 0) {
      skipped.add(m.name);
      out.push({
        plugin: m.name,
        action: "pending",
        pending: {
          plugin: m.name,
          version: m.version,
          added,
          removed,
          reason: "dependency",
          blockedBy,
        },
      });
      continue;
    }
    // 权限集合由清单规范化得到，键相同即集合相同（jsonb 会重排对象键，不能比 JSON 文本）
    // 比快照版本旧（滚动升级中重启的旧副本、或有意回滚）：照常加载但不缩减快照，
    // 否则旧副本会把新版本已批准的权限写没，之后的新副本又变成待批准
    const changed =
      !snap ||
      (!isOlder(m.version, snap.version) &&
        (snap.version !== m.version ||
          permissionKeys(snap.permissions).join("\n") !== permissionKeys(set).join("\n")));
    out.push({
      plugin: m.name,
      action: "load",
      autoApprove: needsApproval,
      added,
      removed,
      changed,
    });
  }
  return out;
}

/** `version` 是否比 `than` 旧（任一方不是合法 semver 时视为不旧）。 */
const isOlder = (version: string, than: string) =>
  semver.valid(version) !== null && semver.valid(than) !== null && semver.lt(version, than);

/** 读写权限快照（直连 PG；内核启动与 CLI 共用）。 */
export class PluginApprovals {
  constructor(private readonly db: KernelDb) {}

  /** 全部快照，按插件名索引。 */
  async all(): Promise<Map<string, PermissionSnapshot>> {
    const rows = await this.db.selectFrom("plugin_permission_snapshots").selectAll().execute();
    return new Map(
      rows.map((r) => [
        r.plugin,
        {
          plugin: r.plugin,
          version: r.version,
          permissions: r.permissions as PermissionSet,
          approvedBy: r.approved_by,
          approvedAt: r.approved_at,
          source: r.source,
        },
      ]),
    );
  }

  /**
   * 批准（新增或覆盖）快照：写入当前权限集合与版本，approved_at 取当前时间。
   * `audit` 给出时在同一事务里写审计 `plugin.permissions_approved`（actor 为 `approvedBy`，CLI 为空）。
   */
  async approve(
    plugin: string,
    version: string,
    permissions: PermissionSet,
    opts: {
      source: "cli" | "auto";
      approvedBy?: string | null;
      audit?: { added: string[]; removed: string[] };
    },
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const values = {
        plugin,
        version,
        permissions: JSON.stringify(permissions),
        approved_by: opts.approvedBy ?? null,
        approved_at: sql<Date>`now()` as unknown as Date,
        source: opts.source,
      };
      await trx
        .insertInto("plugin_permission_snapshots")
        .values(values)
        .onConflict((oc) =>
          oc.column("plugin").doUpdateSet({
            version: values.version,
            permissions: values.permissions,
            approved_by: values.approved_by,
            approved_at: values.approved_at,
            source: values.source,
          }),
        )
        .execute();
      if (opts.audit) {
        await audit(trx, {
          ...(opts.approvedBy && { actorAccountId: opts.approvedBy }),
          action: "plugin.permissions_approved",
          target: plugin,
          detail: { plugin, version, source: opts.source, ...opts.audit },
        });
      }
    });
  }

  /**
   * 权限变少、不变或只多出 `ui.view:*`（不卡加载）时更新快照的权限集合与版本；批准人、批准时间与来源保持不变，
   * 不写审计（与 autoApprove 一样，Ruling A4；调用方记日志）。
   * 在事务内锁行后重新核对（多副本并发启动时以库里的当前快照为准）：快照不存在、`version` 比快照旧、
   * 或当前集合相对快照有需要批准的新增时不更新。返回是否更新。
   */
  async refresh(plugin: string, version: string, permissions: PermissionSet): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("plugin_permission_snapshots")
        .select(["version", "permissions"])
        .where("plugin", "=", plugin)
        .forUpdate()
        .executeTakeFirst();
      if (!row || isOlder(version, row.version)) return false;
      const { added } = diffPermissions(row.permissions as PermissionSet, permissions);
      if (blockingKeys(added).length > 0) {
        return false;
      }
      await trx
        .updateTable("plugin_permission_snapshots")
        .set({ version, permissions: JSON.stringify(permissions) })
        .where("plugin", "=", plugin)
        .execute();
      return true;
    });
  }
}
