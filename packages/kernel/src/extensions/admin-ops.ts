import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import semver from "semver";
import { pluginSchemaName } from "../ctx/create-ctx.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { EnterpriseAdminLock } from "../identity/enterprise-admin.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ExtensionAdmin, type PublishBus } from "./admin-view.js";
import { ExtensionBlobs } from "./blobs.js";
import { ExtensionLifecycle, PLUGINS_CHANGED_TOPIC } from "./lifecycle.js";
import { PluginInstallLock } from "./locks.js";
import { unrunMigrations } from "./migrate-lock.js";
import {
  ExtensionPackageError,
  extensionPackageApiError,
  readExtensionPackage,
} from "./package.js";
import type { AdminExtensionView } from "./permission-view.js";
import { ExtensionRegistry } from "./registry.js";

/**
 * Deployment-level extension install / enable / disable / uninstall (C16 / D15): writes only the PG
 * desired state (`extension_installs`) and the audit, then publishes `kernel.plugins.changed` after
 * the commit (a failure only warns; the periodic reconcile catches up); replicas converge through
 * reconcile, no restart. It does not wait for replicas: the returned view may say `converging`.
 * Stateless, shared by every replica; the CLI uses it too (`actor` is null).
 * Every write runs in a transaction: first `lockEnterpriseAdminsAndAuthorize` (skipped by the CLI),
 * then an advisory lock by extension name and a lock on the install record row.
 */
@Injectable()
export class ExtensionAdminOps {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** The enterprise admin lock (R12): joins the transaction. */
    @Inject(EnterpriseAdminLock) private readonly adminLock: EnterpriseAdminLock,
    @Inject(PluginInstallLock) private readonly installLock: PluginInstallLock,
    /**
     * The admin view after the operation, degraded when the package cannot be read
     * (`get(name, { allowUnreadable: true })`). If it throws, the operation has already committed:
     * ops logs an error and returns {@link fallbackView}, so an operation that took effect is not
     * reported as failed.
     */
    @Inject(ExtensionAdmin) private readonly admin: ExtensionAdmin,
    /** The config-declared extension names (they cannot be installed / disabled / uninstalled, C15). */
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    /** Reads packages (a downgrade checks the target version's migration files). */
    @Inject(ExtensionBlobs) private readonly blobs: ExtensionBlobs,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    /** Publishes `kernel.plugins.changed`. */
    @Inject(KERNEL_BUS) private readonly bus: PublishBus,
    /**
     * When the publish fails this replica reconciles itself (not awaited; other replicas catch up
     * periodically). A no-op where the lifecycle never started (the CLI).
     */
    @Inject(ExtensionLifecycle) private readonly lifecycle: ExtensionLifecycle,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * New install or version change (upgrade / downgrade): the install record points at package
   * `sha256`; the desired state is unchanged (a new install is disabled). Audit `extension.installed`.
   * - Config-declared -> `extension.config_declared`; a required bootstrap plugin may be
   *   installed at another version (an enterprise admin upgrades it; `required` is kept);
   * - package not in the package store -> `extension.package_not_found`; the extension name in the
   *   package is not `name` -> `extension.name_mismatch`;
   * - an install record of the same name exists but comes from another npm package ->
   *   `extension.name_conflict` (decided under a row lock in the transaction, no race);
   *   an extension name belongs to the npm package that first installed it (`extension_name_owners`,
   *   not deleted on uninstall): after an uninstall, another package installing an extension of the
   *   same name gets `extension.name_conflict` too (Ruling P3: uninstall keeps data, secrets, the
   *   snapshot and org enablement); the same npm package reinstalls as usual;
   *   config-declared extensions register ownership at startup too (I4); a name without an owner but
   *   with a snapshot / deployment config / org config left -> also `extension.name_conflict`;
   * - downgrade (target version below the current one) whose target version has migration files not
   *   run yet -> `extension.downgrade_unsupported` (migrations are expand-only, a downgrade can only
   *   go back to a version whose migrations are a subset of those already run).
   * Already pointing at the same package: nothing changes (no audit; for a changed source item only,
   * see below).
   * `opts.catalogItemId`: the source item when installing through the enterprise catalog, stored
   * in `extension_installs.catalog_item_id` (F-AA) and registered in `extension_catalog_sources`;
   * installing outside the catalog (upload / npm / CLI) **keeps** the existing source items (T26
   * fix: clearing them would let org enablement bypass catalog policy, C22). The detail of the
   * `extension.installed` audit carries `catalogItemId`; when it already points at the same package
   * and only the source item changed, only that column changes, audit
   * `extension.install_source_changed`.
   */
  async install(
    name: string,
    sha256: string,
    actor: string | null,
    actorTokenId?: string,
    opts: { catalogItemId?: string } = {},
  ): Promise<AdminExtensionView> {
    this.assertInstallable(name);
    const pkg = await this.db
      .selectFrom("extension_packages")
      .select(["sha256", "name", "package_name", "version", "source"])
      .where("sha256", "=", sha256)
      .executeTakeFirst();
    if (!pkg) {
      throw new ApiError(
        "extension.package_not_found",
        `Extension package ${sha256} is not in the package store; upload it first`,
      );
    }
    if (pkg.name !== name) {
      throw new ApiError(
        "extension.name_mismatch",
        `Package ${sha256} contains extension ${pkg.name}, not ${name}`,
      );
    }
    // The downgrade check needs the target package's migration files: read and parse the package
    // outside the transaction (inside it only _migrations is compared). A stored package in the
    // pre-0.1.0 format -> extension.legacy_format.
    const target = await readExtensionPackage(await this.blobs.get(sha256), {
      maxBytes: this.config.get().packages.maxBytes,
      hostSdkVersion: SDK_VERSION,
    }).catch((e: unknown) => {
      throw e instanceof ExtensionPackageError ? extensionPackageApiError(e) : e;
    });
    const changed = await this.writeInstall(name, sha256, pkg, target, actor, actorTokenId, opts);
    return this.viewAfterCommit(name, { version: pkg.version, sha256, state: changed.state });
  }

  @Transactional()
  private async writeInstall(
    name: string,
    sha256: string,
    pkg: {
      package_name: string;
      version: string;
      source: "npm" | "file" | "catalog" | "bootstrap";
    },
    target: { migrationSql: { file: string; sql: string }[] },
    actor: string | null,
    actorTokenId: string | undefined,
    opts: { catalogItemId?: string },
  ): Promise<{ changed: boolean; state: "enabled" | "disabled" }> {
    const db = this.db;
    if (actor !== null) await this.adminLock.lockAndAuthorize(actor);
    const row = await this.lockRow(name);
    // 不经目录重装时保留原来的来源条目（不清空，C22）
    const catalogItemId = opts.catalogItemId ?? row?.catalog_item_id ?? null;
    if (opts.catalogItemId !== undefined) {
      await db
        .insertInto("extension_catalog_sources")
        .values({ plugin: name, item_id: opts.catalogItemId })
        .onConflict((oc) => oc.columns(["plugin", "item_id"]).doNothing())
        .execute();
    }
    if (row && row.package_name !== pkg.package_name) {
      throw new ApiError(
        "extension.name_conflict",
        `Extension ${name} is already installed from package ${row.package_name}; package ${pkg.package_name} uses the same extension name`,
      );
    }
    // Ruling P3：插件名归第一次安装它的 npm 包（卸载不删），别的包不能接手（数据、密钥与批准都还在）。
    // 还没有归属、却已有这个名字留下的快照 / 部署配置 / 组织配置（I4：如归属表之前就有的配置声明插件）：
    // 不知道它们属于哪个包，同样拒绝
    const owned = await db
      .selectFrom("extension_name_owners")
      .select("package_name")
      .where("name", "=", name)
      .executeTakeFirst();
    if (!owned && (await hasRetainedData(db, name))) {
      throw new ApiError(
        "extension.name_conflict",
        `Extension name ${name} already has retained data (permission approval, deployment config or organization settings) from an extension that is not installed here, and no package owns the name; package ${pkg.package_name} cannot take it over. Remove that data or use a different extension name`,
      );
    }
    await db
      .insertInto("extension_name_owners")
      .values({ name, package_name: pkg.package_name })
      .onConflict((oc) => oc.column("name").doNothing())
      .execute();
    const owner = await db
      .selectFrom("extension_name_owners")
      .select("package_name")
      .where("name", "=", name)
      .executeTakeFirstOrThrow();
    if (owner.package_name !== pkg.package_name) {
      throw new ApiError(
        "extension.name_conflict",
        `Extension name ${name} was previously used by package ${owner.package_name}; its data, secrets and permission approval are retained for that package, so package ${pkg.package_name} cannot take over the name`,
      );
    }
    // 已指向同一个包：什么都不改，降级视图仍给出真实的期望状态
    if (row?.sha256 === sha256) {
      if (row.catalog_item_id !== catalogItemId) {
        // 包没变、只有来源条目变了：照样留审计（来源变化影响 T26 的目录策略约束）
        await db
          .updateTable("extension_installs")
          .set({ catalog_item_id: catalogItemId })
          .where("name", "=", name)
          .execute();
        await this.audit(
          actor,
          actorTokenId,
          "extension.install_source_changed",
          name,
          pkg.version,
          sha256,
          { catalogItemId, previousCatalogItemId: row.catalog_item_id },
        );
      }
      return { changed: false, state: row.desired_state };
    }
    if (row && isDowngrade(pkg.version, row.version)) {
      const unrun = await unrunMigrations(db, name, target.migrationSql);
      if (unrun.length > 0) {
        throw new ApiError(
          "extension.downgrade_unsupported",
          `Extension ${name} ${pkg.version} has migrations that were never run here (${unrun.join(", ")}); extension migrations only expand, so downgrade only to a version whose migrations have all been applied`,
          unrun.map((file) => ({ file })),
        );
      }
    }
    await db
      .insertInto("extension_installs")
      .values({
        name,
        sha256,
        version: pkg.version,
        source: pkg.source,
        desired_state: "disabled",
        installed_by: actor,
        updated_by: actor,
        catalog_item_id: catalogItemId,
      })
      .onConflict((oc) =>
        oc.column("name").doUpdateSet({
          sha256,
          version: pkg.version,
          source: pkg.source,
          updated_by: actor,
          catalog_item_id: catalogItemId,
          updated_at: sql<Date>`now()` as unknown as Date,
        }),
      )
      .execute();
    await this.audit(actor, actorTokenId, "extension.installed", name, pkg.version, sha256, {
      catalogItemId,
    });
    afterCommit(() => this.notify(name));
    return { changed: true, state: row?.desired_state ?? "disabled" };
  }

  /** Enable on the deployment (audit `extension.enabled`); no change when already enabled. Org enablement is unchanged. */
  enable(name: string, actor: string | null, actorTokenId?: string): Promise<AdminExtensionView> {
    return this.setState(name, "enabled", actor, actorTokenId);
  }

  /**
   * Disables on the deployment (audit `extension.disabled`); no change when already disabled. Every
   * replica unloads it (draining in-flight calls), and the extensions that `requires` it unload with
   * it; the org enablement switch is unchanged and the org page shows it as unavailable. A required
   * bootstrap plugin -> `extension.required`.
   */
  disable(name: string, actor: string | null, actorTokenId?: string): Promise<AdminExtensionView> {
    return this.setState(name, "disabled", actor, actorTokenId);
  }

  /**
   * Uninstall: a required bootstrap plugin -> `extension.required`; must be disabled first
   * (otherwise `extension.not_disabled`); deletes the install record
   * and its catalog source items (`extension_catalog_sources`, same transaction; audit
   * `extension.uninstalled`), and keeps the data: the extension schema, secrets, org configs,
   * permission snapshot and the package in the package store are untouched (a reinstall picks them
   * up).
   */
  async uninstall(name: string, actor: string | null, actorTokenId?: string): Promise<void> {
    this.assertInstallable(name);
    await this.writeUninstall(name, actor, actorTokenId);
  }

  @Transactional()
  private async writeUninstall(
    name: string,
    actor: string | null,
    actorTokenId: string | undefined,
  ): Promise<void> {
    const db = this.db;
    if (actor !== null) await this.adminLock.lockAndAuthorize(actor);
    const row = await this.lockRow(name);
    if (!row) throw notFound(name);
    if (row.required) throw required(name);
    if (row.desired_state !== "disabled") {
      throw new ApiError(
        "extension.not_disabled",
        `Extension ${name} is enabled; disable it before uninstalling`,
      );
    }
    await db.deleteFrom("extension_installs").where("name", "=", name).execute();
    // 来源条目随安装记录一起删：之后不经目录重新安装时不再受旧条目的策略约束（T26 裁决）
    await db.deleteFrom("extension_catalog_sources").where("plugin", "=", name).execute();
    await this.audit(actor, actorTokenId, "extension.uninstalled", name, row.version, row.sha256);
    afterCommit(() => this.notify(name));
  }

  private async setState(
    name: string,
    state: "enabled" | "disabled",
    actor: string | null,
    actorTokenId: string | undefined,
  ): Promise<AdminExtensionView> {
    this.assertInstallable(name);
    const result = await this.writeState(name, state, actor, actorTokenId);
    return this.viewAfterCommit(name, {
      version: result.row.version,
      sha256: result.row.sha256,
      state,
    });
  }

  @Transactional()
  private async writeState(
    name: string,
    state: "enabled" | "disabled",
    actor: string | null,
    actorTokenId: string | undefined,
  ) {
    const db = this.db;
    if (actor !== null) await this.adminLock.lockAndAuthorize(actor);
    const row = await this.lockRow(name);
    if (!row) throw notFound(name);
    if (state === "disabled" && row.required) throw required(name);
    if (row.desired_state === state) return { row, changed: false };
    await db
      .updateTable("extension_installs")
      .set({
        desired_state: state,
        updated_by: actor,
        updated_at: sql<Date>`now()` as unknown as Date,
      })
      .where("name", "=", name)
      .execute();
    await this.audit(
      actor,
      actorTokenId,
      state === "enabled" ? "extension.enabled" : "extension.disabled",
      name,
      row.version,
      row.sha256,
    );
    afterCommit(() => this.notify(name));
    return { row, changed: true };
  }

  /**
   * 提交后的视图：拼视图失败（读包、查状态行出错）时操作已经生效，不能再报失败——记 error，返回降级视图。
   */
  private async viewAfterCommit(
    name: string,
    known: { version: string; sha256: string; state: "enabled" | "disabled" | undefined },
  ): Promise<AdminExtensionView> {
    try {
      return await this.admin.get(name, { allowUnreadable: true });
    } catch (err) {
      this.log.error("plugin change committed, but its admin view cannot be built", {
        plugin: name,
        err,
      });
      return fallbackView(name, known, err);
    }
  }

  /** 配置声明的插件不经安装记录管理。 */
  private assertInstallable(name: string): void {
    const declared = this.registry.declared().get(name);
    if (declared === "config") {
      throw new ApiError(
        "extension.config_declared",
        `Extension ${name} is declared in the startup config (extensions); change that list and restart instead`,
      );
    }
  }

  /** 按插件名串行（`PluginInstallLock`，覆盖「还没有行」的新装），再锁住已有的安装记录行。 */
  @Transactional({ propagation: "mandatory" })
  private async lockRow(name: string) {
    await this.installLock.lock(name);
    return this.db
      .selectFrom("extension_installs")
      .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
      .select([
        "extension_installs.sha256",
        "extension_installs.version",
        "extension_installs.desired_state",
        "extension_installs.catalog_item_id",
        "extension_installs.required",
        "extension_packages.package_name",
      ])
      .where("extension_installs.name", "=", name)
      .forUpdate("extension_installs")
      .executeTakeFirst();
  }

  private async audit(
    actor: string | null,
    actorTokenId: string | undefined,
    action: string,
    name: string,
    version: string,
    sha256: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await audit(this.db, {
      ...(actor !== null && { actorAccountId: actor }),
      ...(actorTokenId !== undefined && { actorTokenId }),
      action,
      target: name,
      detail: { name, version, sha256, ...extra },
    });
  }

  /** 提交后通知各副本；发布失败只告警（周期 reconcile 兜底），本副本自己先 reconcile。 */
  private async notify(name: string): Promise<void> {
    try {
      await this.bus.publish(PLUGINS_CHANGED_TOPIC, { plugin: name });
    } catch (err) {
      this.log.warn(
        "cannot publish plugins.changed; replicas converge on the next periodic reconcile",
        { plugin: name, err },
      );
      this.lifecycle
        .reconcile(`changed:${name}`)
        .catch((e: unknown) => this.log.error("plugin reconcile failed", { plugin: name, err: e }));
    }
  }
}

/**
 * 拼不出视图时的降级项（与后台列表里包读不到的项同形：status failed、权限为空、带 `error`）。
 */
function fallbackView(
  name: string,
  known: { version: string; sha256: string; state: "enabled" | "disabled" | undefined },
  err: unknown,
): AdminExtensionView {
  return {
    name,
    version: known.version,
    source: "install",
    sha256: known.sha256,
    status: "failed",
    desired:
      known.state === undefined
        ? null
        : { version: known.version, sha256: known.sha256, state: known.state },
    replicas: [],
    permissions: [],
    added: [],
    addedItems: [],
    removed: [],
    reviewHash: "",
    sensitive: false,
    warnings: [],
    snapshot: null,
    configurable: false,
    configValid: true,
    removable: true,
    required: false,
    installSource: null,
    error: `the change was saved, but its current status cannot be read: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** 插件名已留下的数据：权限快照、部署配置、任一组织的配置，或插件 schema（`plugin_<name>`）。 */
async function hasRetainedData(db: KernelSchemaDb, name: string): Promise<boolean> {
  const schema = await sql<{
    x: number;
  }>`SELECT 1 AS x FROM pg_namespace WHERE nspname = ${pluginSchemaName(name)}`.execute(db);
  if (schema.rows.length > 0) return true;
  const hit = await db
    .selectFrom("extension_permission_snapshots")
    .select(sql<number>`1`.as("x"))
    .where("plugin", "=", name)
    .union(
      db
        .selectFrom("extension_deployment_configs")
        .select(sql<number>`1`.as("x"))
        .where("plugin", "=", name),
    )
    .union(
      db
        .selectFrom("extension_org_configs")
        .select(sql<number>`1`.as("x"))
        .where("plugin", "=", name),
    )
    .limit(1)
    .executeTakeFirst();
  return hit !== undefined;
}

const required = (name: string) =>
  new ApiError(
    "extension.required",
    `Extension ${name} is required by this deployment (a bootstrap plugin): it is enabled in every organization and cannot be disabled or uninstalled; an enterprise admin can upgrade it`,
  );

const notFound = (name: string) =>
  new ApiError("extension.not_found", `Extension ${name} is not installed in this deployment`);

/** `to` 比 `from` 旧（任一方不是合法 semver 时不算降级）。 */
const isDowngrade = (to: string, from: string): boolean =>
  semver.valid(to) !== null && semver.valid(from) !== null && semver.lt(to, from);
