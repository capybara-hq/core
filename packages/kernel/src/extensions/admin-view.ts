import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import {
  ExtensionApprovals,
  type PermissionSnapshot,
  snapshotCovers,
  writeSnapshot,
} from "./approvals.js";
import type { ExtensionBlobs } from "./blobs.js";
import type { DeclaredExtensionInfo } from "./host.js";
import type { ExtensionInstallRow, ExtensionInstalls } from "./installs.js";
import { PLUGINS_CHANGED_TOPIC, STALE_RECONCILE_PERIODS } from "./lifecycle.js";
import { permissionSetOfPackage, readExtensionPackage } from "./package.js";
import { buildPermissionSet, diffPermissions, type PermissionSet } from "./permission-set.js";
import {
  type AdminExtensionView,
  deriveExtensionStatus,
  migrationWarnings,
  type PackageWarning,
  permissionGroups,
  permissionKeyItems,
  reviewHash,
} from "./permission-view.js";
import type { ExtensionSource } from "./sources.js";

export { PLUGINS_CHANGED_TOPIC };

/** 内容寻址的包 → 权限集合（包不可变，缓存安全；只作缓存，不是跨副本状态）。 */
const PACKAGE_SET_CACHE_MAX = 256;

/** The web approval request body (`POST /api/v1/admin/extensions/:name/approve`). */
export interface ApproveBody {
  /** 安装记录的包；配置声明的插件为 null。 */
  sha256: string | null;
  reviewHash: string;
}

export interface ExtensionAdminDeps {
  db: KernelDb;
  blobs: Pick<ExtensionBlobs, "get">;
  installs: ExtensionInstalls;
  config: () => KernelConfig;
  host: {
    declaredPlugins(): DeclaredExtensionInfo[];
  };
  /**
   * 本副本 reconcile（批准后等它完成再返回视图；其他副本经 `kernel.plugins.changed` 收敛）。CLI 没有（只发布）。
   */
  reconcile?: (reason: string) => Promise<void>;
  bus: { publish(topic: string, payload: unknown): Promise<void> };
  log: {
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
  };
}

/** The raw material for one extension in the admin console (before building the {@link AdminExtensionView}). */
interface Subject {
  name: string;
  source: ExtensionSource;
  version: string;
  set: PermissionSet;
  install: ExtensionInstallRow | null;
  configurable: boolean;
  /** 内置 / 配置声明：宿主按 schema 校验的结果；安装记录：看副本行。 */
  configValid: boolean | null;
  /** 安装记录的包读不到时的说明（此时 `set` 为空集合）。 */
  broken?: string;
  /** 安装记录包里迁移 SQL 的审阅警告（内置 / 配置声明为空）。 */
  warnings: PackageWarning[];
}

/** 空权限集合（包读不到的降级项）。 */
const EMPTY_SET: PermissionSet = buildPermissionSet({
  provides: [],
  config: { deployment: [], org: [] },
  tables: [],
});

/** The package cannot be read -> `extension.package_unavailable` (details and approval cannot be based on an unreadable package). */
function assertReadable(s: Subject): void {
  if (s.broken !== undefined) {
    throw new ApiError(
      "extension.package_unavailable",
      `The package of extension ${s.name} cannot be read: ${s.broken}`,
    );
  }
}

/**
 * 部署级插件后台（企业管理员）：列表 / 详情与网页批准权限（D8）。无状态，多副本共用；
 * 状态由 PG（安装记录、快照、各副本状态行）与本副本宿主（内置 / 配置声明插件的清单）推出。
 */
export class ExtensionAdmin {
  private readonly packageSets = new Map<
    string,
    { set: PermissionSet; warnings: PackageWarning[] }
  >();

  constructor(private readonly d: ExtensionAdminDeps) {}

  /** 全部插件（内置 → 配置声明 → 安装记录，各自按名字）。 */
  async list(): Promise<AdminExtensionView[]> {
    const subjects = await this.subjects();
    return this.views(subjects);
  }

  /**
   * A single extension; unknown -> `extension.not_found`; package unreadable ->
   * `extension.package_unavailable`. With `allowUnreadable` an unreadable package returns the same
   * degraded item as {@link list} (status failed, with `error`): used after a write has committed, so
   * an operation that took effect is not reported as failed.
   */
  async get(name: string, opts: { allowUnreadable?: boolean } = {}): Promise<AdminExtensionView> {
    const s = (await this.subjects(name))[0];
    if (!s)
      throw new ApiError(
        "extension.not_found",
        `Extension ${name} is not known to this deployment`,
      );
    if (!opts.allowUnreadable) assertReadable(s);
    return (await this.views([s]))[0] as AdminExtensionView;
  }

  /**
   * Web approval: re-checks the enterprise admin under the lock, compares the reviewed package
   * (`sha256`) and permission digest (`reviewHash`), writes the snapshot (source web) and the
   * `extension.permissions_approved` audit; after the commit publishes `kernel.plugins.changed` (a
   * failure only warns) and waits for one reconcile on this replica (other replicas converge through
   * the bus, the periodic job catches lost messages). Returns the view after approval.
   * - Builtin extensions are pre-approved -> `extension.builtin`; unknown -> `extension.not_found`;
   * - the install record's `sha256` differs from the current one, or `reviewHash` differs from the one
   *   recomputed now -> `extension.approval_stale`; a config-declared extension's `sha256` must be
   *   null (otherwise `validation_failed`);
   * - the snapshot already covers the current permission set (nothing to approve, F-N) ->
   *   `extension.not_pending`.
   */
  async approve(
    actor: string,
    name: string,
    body: ApproveBody,
    opts: { actorTokenId?: string } = {},
  ): Promise<AdminExtensionView> {
    const s = (await this.subjects(name))[0];
    if (!s)
      throw new ApiError(
        "extension.not_found",
        `Extension ${name} is not known to this deployment`,
      );
    assertReadable(s);
    if (s.source === "builtin") {
      throw new ApiError(
        "extension.builtin",
        `Extension ${name} is built into this deployment and pre-approved; it needs no approval`,
      );
    }
    if (s.install === null && body.sha256 !== null) {
      throw new ApiError(
        "validation_failed",
        `Extension ${name} is declared in the startup config; approve it with sha256 null`,
      );
    }
    const stale = () =>
      new ApiError(
        "extension.approval_stale",
        `The permissions of extension ${name} changed since they were reviewed; review them again`,
      );
    if (s.install !== null && body.sha256 !== s.install.sha256) throw stale();
    if (body.reviewHash !== reviewHash(s.set, s.warnings)) throw stale();

    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-approve:${name}`}))`.execute(
        trx,
      );
      if (s.install !== null) {
        // 审阅之后安装记录可能已换包（T14 升级）：锁行复核
        const row = await trx
          .selectFrom("extension_installs")
          .select("sha256")
          .where("name", "=", name)
          .forUpdate()
          .executeTakeFirst();
        if (row?.sha256 !== s.install.sha256) throw stale();
      }
      const snapRow = await trx
        .selectFrom("extension_permission_snapshots")
        .select(["version", "permissions"])
        .where("plugin", "=", name)
        .forUpdate()
        .executeTakeFirst();
      const snap = snapRow && {
        version: snapRow.version,
        permissions: snapRow.permissions as PermissionSet,
      };
      if (snapshotCovers(snap, s.set)) {
        throw new ApiError(
          "extension.not_pending",
          `Extension ${name} ${s.version} has no new permissions awaiting approval`,
        );
      }
      const { added, removed } = diffPermissions(snap?.permissions, s.set);
      await writeSnapshot(trx, name, s.version, s.set, {
        source: "web",
        approvedBy: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        audit: { added, removed, sha256: s.install?.sha256 ?? null },
      });
    });

    try {
      await this.d.bus.publish(PLUGINS_CHANGED_TOPIC, { plugin: name });
    } catch (err) {
      // 快照已写入；其他副本由周期 reconcile（T14）兜底
      this.d.log.warn("cannot publish plugins.changed after approval", { plugin: name, err });
    }
    try {
      await this.d.reconcile?.(`approved:${name}`);
    } catch (err) {
      this.d.log.error("loading approved plugins on this replica failed", { plugin: name, err });
    }
    return this.get(name);
  }

  /** 内置 → 配置声明 → 安装记录（与内置 / 配置声明重名的安装记录不生效，不单列）。`only` 给出时只取这一个。 */
  private async subjects(only?: string): Promise<Subject[]> {
    const declared = this.d.host
      .declaredPlugins()
      .filter((p) => only === undefined || p.name === only);
    const taken = new Set(this.d.host.declaredPlugins().map((p) => p.name));
    const order = { builtin: 0, config: 1 } as const;
    const out: Subject[] = [...declared]
      .sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name))
      .map((p) => ({
        name: p.name,
        source: p.source,
        version: p.version,
        set: p.permissions,
        install: null,
        configurable: p.configurable,
        configValid: p.configValid,
        warnings: [],
      }));
    if (only !== undefined && out.length > 0) return out;
    const rows = (await this.d.installs.list()).filter(
      (r) => !taken.has(r.name) && (only === undefined || r.name === only),
    );
    for (const r of rows) {
      let info: { set: PermissionSet; configurable: boolean; warnings: PackageWarning[] };
      try {
        info = await this.packageInfo(r.sha256);
      } catch (err) {
        // 一个包读不到（字节缺失 / 损坏、超过现行上限）不拖垮整个列表：降级为 failed 项
        const detail = `package ${r.name} ${r.version} (${r.sha256}) cannot be read: ${err instanceof Error ? err.message : String(err)}`;
        this.d.log.warn("plugin package unreadable for the admin view", {
          plugin: r.name,
          sha256: r.sha256,
          err,
        });
        out.push({
          name: r.name,
          source: "install",
          version: r.version,
          set: EMPTY_SET,
          install: r,
          configurable: false,
          configValid: null,
          broken: detail,
          warnings: [],
        });
        continue;
      }
      const { set, configurable, warnings } = info;
      out.push({
        name: r.name,
        source: "install",
        version: r.version,
        set,
        install: r,
        configurable,
        configValid: null,
        warnings,
      });
    }
    return out;
  }

  /**
   * 包的权限集合（静态清单 + 迁移 SQL，与上传时的审阅相同）、迁移审阅警告与是否有部署级配置字段；按 sha256 缓存。
   */
  private async packageInfo(
    sha256: string,
  ): Promise<{ set: PermissionSet; configurable: boolean; warnings: PackageWarning[] }> {
    let cached = this.packageSets.get(sha256);
    if (!cached) {
      const pkg = await readExtensionPackage(await this.d.blobs.get(sha256), {
        maxBytes: this.d.config().packages.maxBytes,
        hostSdkVersion: SDK_VERSION,
      });
      cached = {
        set: permissionSetOfPackage(pkg),
        warnings: migrationWarnings(pkg.migrationSql, pkg.section.manifest.name),
      };
      if (this.packageSets.size >= PACKAGE_SET_CACHE_MAX) this.packageSets.clear();
      this.packageSets.set(sha256, cached);
    }
    return { ...cached, configurable: cached.set.config.deployment.length > 0 };
  }

  private async views(subjects: Subject[]): Promise<AdminExtensionView[]> {
    if (subjects.length === 0) return [];
    const names = subjects.map((s) => s.name);
    const snapshots = await new ExtensionApprovals(this.d.db).all();
    const staleSeconds =
      STALE_RECONCILE_PERIODS * this.d.config().pluginHost.reconcileIntervalSeconds;
    const rows = await this.d.db
      .selectFrom("extension_replica_status")
      .selectAll()
      .where("plugin", "in", names)
      .where("heartbeat_at", ">", sql<Date>`now() - make_interval(secs => ${staleSeconds})`)
      .orderBy("replica_id")
      .execute();
    return subjects.map((s) => {
      const replicas = rows.filter((r) => r.plugin === s.name);
      const builtin = s.source === "builtin";
      const snap = builtin ? undefined : snapshots.get(s.name);
      const { added, removed } = builtin
        ? { added: [], removed: [] }
        : diffPermissions(snap?.permissions, s.set);
      const target = s.install?.sha256 ?? null;
      const configValid =
        s.configValid ??
        !replicas.some(
          (r) => r.state === "pending" && r.reason === "config" && r.sha256 === target,
        );
      const install = s.install;
      if (s.broken !== undefined) {
        return {
          name: s.name,
          version: s.version,
          source: s.source,
          sha256: target,
          status: "failed" as const,
          desired: install && {
            version: install.version,
            sha256: install.sha256,
            state: install.desiredState,
          },
          replicas: replicas.map(replicaView),
          permissions: [],
          added: [],
          addedItems: [],
          removed: [],
          reviewHash: reviewHash(s.set),
          sensitive: false,
          warnings: [],
          snapshot: snapshotView(snap),
          configurable: false,
          configValid,
          removable: true,
          error: s.broken,
        };
      }
      const permissions = permissionGroups(s.set);
      return {
        name: s.name,
        version: s.version,
        source: s.source,
        sha256: target,
        status: deriveExtensionStatus({
          source: s.source,
          desired: install && { sha256: install.sha256, state: install.desiredState },
          pendingApproval: !builtin && !snapshotCovers(snap, s.set),
          configValid,
          migratedSha: install?.migratedSha ?? null,
          replicas: replicas.map((r) => ({ state: r.state, reason: r.reason, sha256: r.sha256 })),
        }),
        desired: install && {
          version: install.version,
          sha256: install.sha256,
          state: install.desiredState,
        },
        replicas: replicas.map(replicaView),
        permissions,
        added,
        addedItems: permissionKeyItems(added),
        removed,
        reviewHash: reviewHash(s.set, s.warnings),
        sensitive: permissions.some((g) => g.sensitive),
        warnings: s.warnings,
        snapshot: snapshotView(snap),
        configurable: s.configurable,
        configValid,
        removable: s.source === "install",
      };
    });
  }
}

type ReplicaRow = {
  replica_id: string;
  version: string;
  state: string;
  reason: string | null;
  detail: string | null;
  serving_version: string | null;
  heartbeat_at: Date;
};

const replicaView = (r: ReplicaRow): AdminExtensionView["replicas"][number] => ({
  replicaId: r.replica_id,
  version: r.version,
  state: r.state,
  reason: r.reason,
  detail: r.detail,
  servingVersion: r.serving_version,
  heartbeatAt: r.heartbeat_at.toISOString(),
});

const snapshotView = (snap: PermissionSnapshot | undefined): AdminExtensionView["snapshot"] =>
  snap
    ? {
        version: snap.version,
        approvedAt: snap.approvedAt.toISOString(),
        approvedBy: snap.approvedBy,
        source: snap.source,
      }
    : null;
