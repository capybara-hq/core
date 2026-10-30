import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { EnterpriseAdminLock } from "../identity/enterprise-admin.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  ExtensionApprovals,
  type PermissionSnapshot,
  snapshotCovers,
  writeSnapshot,
} from "./approvals.js";
import { ExtensionBlobs } from "./blobs.js";
import { ExtensionHost } from "./host.js";
import { type ExtensionInstallRow, ExtensionInstalls } from "./installs.js";
import { ExtensionLifecycle, PLUGINS_CHANGED_TOPIC, STALE_RECONCILE_PERIODS } from "./lifecycle.js";
import { PluginApproveLock } from "./locks.js";
import { ExtensionPackageError, permissionSetOfPackage, readExtensionPackage } from "./package.js";
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

/** The kernel bus as the admin operations use it (publish only). */
export interface PublishBus {
  publish(topic: string, payload: unknown): Promise<void>;
}

/** The raw material for one extension in the admin console (before building the {@link AdminExtensionView}). */
interface Subject {
  name: string;
  source: ExtensionSource;
  version: string;
  set: PermissionSet;
  install: ExtensionInstallRow | null;
  configurable: boolean;
  /** 配置声明：宿主按 schema 校验的结果；安装记录：看副本行。 */
  configValid: boolean | null;
  /** Why the install record's package cannot be read (`set` is then empty). */
  broken?: string;
  /** The package is in the pre-0.1.0 format (`broken` holds the legacy-format message). */
  legacy?: boolean;
  /** 安装记录包里迁移 SQL 的审阅警告（配置声明为空）。 */
  warnings: PackageWarning[];
}

/** 空权限集合（包读不到的降级项）。 */
const EMPTY_SET: PermissionSet = buildPermissionSet({
  provides: [],
  config: { deployment: [], org: [] },
  tables: [],
});

/**
 * The package cannot be read -> `extension.package_unavailable`, or is in the pre-0.1.0 format ->
 * `extension.legacy_format` (details and approval cannot be based on an unreadable package).
 */
function assertReadable(s: Subject): void {
  if (s.legacy) throw new ApiError("extension.legacy_format", s.broken as string);
  if (s.broken !== undefined) {
    throw new ApiError(
      "extension.package_unavailable",
      `The package of extension ${s.name} cannot be read: ${s.broken}`,
    );
  }
}

/**
 * 部署级插件后台（企业管理员）：列表 / 详情与网页批准权限（D8）。无状态，多副本共用；
 * 状态由 PG（安装记录、快照、各副本状态行）与本副本宿主（配置声明插件的清单）推出。
 */
@Injectable()
export class ExtensionAdmin {
  private readonly packageSets = new Map<
    string,
    { set: PermissionSet; warnings: PackageWarning[] }
  >();

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** The enterprise admin lock (identity/enterprise-admin.ts): joins the transaction. */
    @Inject(EnterpriseAdminLock) private readonly adminLock: EnterpriseAdminLock,
    @Inject(PluginApproveLock) private readonly approveLock: PluginApproveLock,
    @Inject(ExtensionBlobs) private readonly blobs: ExtensionBlobs,
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    @Inject(ExtensionApprovals) private readonly approvals: ExtensionApprovals,
    /** The config-declared extensions (this replica's host; the CLI fills it from its inspection). */
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
    /** This replica's reconcile after an approval (a no-op where the lifecycle never started: the CLI). */
    @Inject(ExtensionLifecycle) private readonly lifecycle: ExtensionLifecycle,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KERNEL_BUS) private readonly bus: PublishBus,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** 全部插件（配置声明 → 安装记录，各自按名字）。 */
  async list(): Promise<AdminExtensionView[]> {
    const subjects = await this.subjects();
    return this.views(subjects);
  }

  /**
   * A single extension; unknown -> `extension.not_found`; package unreadable ->
   * `extension.package_unavailable`. With `allowUnreadable` an unreadable package returns the same
   * degraded item as {@link list} (status failed, with `error`): used after a write has committed, so
   * an operation that took effect is not reported as failed. A package in the pre-0.1.0 format is
   * a state, not an error: it always returns the item with status `legacy_format` (so the admin can
   * see it and uninstall it).
   */
  async get(name: string, opts: { allowUnreadable?: boolean } = {}): Promise<AdminExtensionView> {
    const s = (await this.subjects(name))[0];
    if (!s)
      throw new ApiError(
        "extension.not_found",
        `Extension ${name} is not known to this deployment`,
      );
    if (!opts.allowUnreadable && !s.legacy) assertReadable(s);
    return (await this.views([s]))[0] as AdminExtensionView;
  }

  /**
   * Web approval: re-checks the enterprise admin under the lock, compares the reviewed package
   * (`sha256`) and permission digest (`reviewHash`), writes the snapshot (source web) and the
   * `extension.permissions_approved` audit; after the commit publishes `kernel.plugins.changed` (a
   * failure only warns) and waits for one reconcile on this replica (other replicas converge through
   * the bus, the periodic job catches lost messages). Returns the view after approval.
   * - Unknown -> `extension.not_found`;
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

    await this.writeApproval(actor, name, s, opts.actorTokenId, stale);

    try {
      await this.bus.publish(PLUGINS_CHANGED_TOPIC, { plugin: name });
    } catch (err) {
      // 快照已写入；其他副本由周期 reconcile（T14）兜底
      this.log.warn("cannot publish plugins.changed after approval", { plugin: name, err });
    }
    try {
      await this.lifecycle.reconcile(`approved:${name}`);
    } catch (err) {
      this.log.error("loading approved plugins on this replica failed", { plugin: name, err });
    }
    return this.get(name);
  }

  @Transactional()
  private async writeApproval(
    actor: string,
    name: string,
    s: Subject,
    actorTokenId: string | undefined,
    stale: () => ApiError,
  ): Promise<void> {
    const db = this.db;
    await this.adminLock.lockAndAuthorize(actor);
    await this.approveLock.lock(name);
    if (s.install !== null) {
      // 审阅之后安装记录可能已换包（T14 升级）：锁行复核
      const row = await db
        .selectFrom("extension_installs")
        .select("sha256")
        .where("name", "=", name)
        .forUpdate()
        .executeTakeFirst();
      if (row?.sha256 !== s.install.sha256) throw stale();
    }
    const snapRow = await db
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
    await writeSnapshot(db, name, s.version, s.set, {
      source: "web",
      approvedBy: actor,
      ...(actorTokenId !== undefined && { actorTokenId }),
      audit: { added, removed, sha256: s.install?.sha256 ?? null },
    });
  }

  /** 配置声明 → 安装记录（与配置声明重名的安装记录不生效，不单列）。`only` 给出时只取这一个。 */
  private async subjects(only?: string): Promise<Subject[]> {
    const declared = this.host
      .declaredPlugins()
      .filter((p) => only === undefined || p.name === only);
    const taken = new Set(this.host.declaredPlugins().map((p) => p.name));
    const out: Subject[] = [...declared]
      .sort((a, b) => a.name.localeCompare(b.name))
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
    const rows = (await this.installs.list()).filter(
      (r) => !taken.has(r.name) && (only === undefined || r.name === only),
    );
    for (const r of rows) {
      let info: { set: PermissionSet; configurable: boolean; warnings: PackageWarning[] };
      try {
        info = await this.packageInfo(r.sha256);
      } catch (err) {
        // One unreadable package (bytes missing / corrupt, over the current limit) does not break
        // the list: it becomes a failed item; a pre-0.1.0 package becomes a legacy_format item.
        const legacy =
          err instanceof ExtensionPackageError && err.code === "extension.legacy_format";
        const detail = legacy
          ? err.message
          : `package ${r.name} ${r.version} (${r.sha256}) cannot be read: ${err instanceof Error ? err.message : String(err)}`;
        // A pre-0.1.0 package is an expected state (repack needed), logged without a stack trace.
        this.log.warn("plugin package unreadable for the admin view", {
          plugin: r.name,
          sha256: r.sha256,
          ...(legacy ? { reason: detail } : { err }),
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
          ...(legacy && { legacy }),
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
      const pkg = await readExtensionPackage(await this.blobs.get(sha256), {
        maxBytes: this.config.get().packages.maxBytes,
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
    const snapshots = await this.approvals.all();
    const staleSeconds =
      STALE_RECONCILE_PERIODS * this.config.get().extensionHost.reconcileIntervalSeconds;
    const rows = await this.db
      .selectFrom("extension_replica_status")
      .selectAll()
      .where("plugin", "in", names)
      .where("heartbeat_at", ">", sql<Date>`now() - make_interval(secs => ${staleSeconds})`)
      .orderBy("replica_id")
      .execute();
    return subjects.map((s) => {
      const replicas = rows.filter((r) => r.plugin === s.name);
      const snap = snapshots.get(s.name);
      const { added, removed } = diffPermissions(snap?.permissions, s.set);
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
          status: s.legacy ? ("legacy_format" as const) : ("failed" as const),
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
          removable: install?.required !== true,
          required: install?.required === true,
          installSource: install?.source ?? null,
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
          pendingApproval: !snapshotCovers(snap, s.set),
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
        removable: s.source === "install" && install?.required !== true,
        required: install?.required === true,
        installSource: install?.source ?? null,
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
