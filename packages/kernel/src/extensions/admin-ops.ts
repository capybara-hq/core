import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import semver from "semver";
import type { KernelConfig } from "../config/schema.js";
import { pluginSchemaName } from "../ctx/create-ctx.js";
import type { KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { PLUGINS_CHANGED_TOPIC } from "./lifecycle.js";
import { unrunMigrations } from "./migrate-lock.js";
import {
  ExtensionPackageError,
  extensionPackageApiError,
  readExtensionPackage,
} from "./package.js";
import type { AdminExtensionView } from "./permission-view.js";
import type { ExtensionSource } from "./sources.js";

export interface ExtensionAdminOpsDeps {
  db: KernelSchemaDb;
  /**
   * Returns the admin view after the operation; when the package cannot be read it should return the
   * degraded item (`ExtensionAdmin.get(name, { allowUnreadable: true })`). If it throws, the operation
   * has already committed: ops logs an error and returns {@link fallbackView}, so an operation that
   * took effect is not reported as failed.
   */
  view(name: string): Promise<AdminExtensionView>;
  /** 配置声明的插件名 → 来源（这些插件不能安装 / 停用 / 卸载，C15）。 */
  declared(): ReadonlyMap<string, ExtensionSource>;
  /** 读包（降级时核对目标版本的迁移文件）。 */
  blobs: { get(sha256: string): Promise<Uint8Array> };
  config: () => KernelConfig;
  /** 发布 `kernel.plugins.changed`。 */
  bus: { publish(topic: string, payload: unknown): Promise<void> };
  /** 发布失败时本副本自己 reconcile（不等待；其他副本靠周期任务兜底）。CLI 没有。 */
  reconcile?: (reason: string) => Promise<void>;
  log: {
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
  };
}

type Trx = Transaction<KernelDatabase>;

/**
 * Deployment-level extension install / enable / disable / uninstall (C16 / D15): writes only the PG
 * desired state (`extension_installs`) and the audit, then publishes `kernel.plugins.changed` after
 * the commit (a failure only warns; the periodic reconcile catches up); replicas converge through
 * reconcile, no restart. It does not wait for replicas: the returned view may say `converging`.
 * Stateless, shared by every replica; the CLI uses it too (`actor` is null).
 * Every write runs in a transaction: first `lockEnterpriseAdminsAndAuthorize` (skipped by the CLI),
 * then an advisory lock by extension name and a lock on the install record row.
 */
export class ExtensionAdminOps {
  constructor(private readonly d: ExtensionAdminOpsDeps) {}

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
    const pkg = await this.d.db
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
    const target = await readExtensionPackage(await this.d.blobs.get(sha256), {
      maxBytes: this.d.config().packages.maxBytes,
      hostSdkVersion: SDK_VERSION,
    }).catch((e: unknown) => {
      throw e instanceof ExtensionPackageError ? extensionPackageApiError(e) : e;
    });
    const changed = await this.d.db.transaction().execute(async (trx) => {
      if (actor !== null) await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await this.lockRow(trx, name);
      // 不经目录重装时保留原来的来源条目（不清空，C22）
      const catalogItemId = opts.catalogItemId ?? row?.catalog_item_id ?? null;
      if (opts.catalogItemId !== undefined) {
        await trx
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
      const owned = await trx
        .selectFrom("extension_name_owners")
        .select("package_name")
        .where("name", "=", name)
        .executeTakeFirst();
      if (!owned && (await hasRetainedData(trx, name))) {
        throw new ApiError(
          "extension.name_conflict",
          `Extension name ${name} already has retained data (permission approval, deployment config or organization settings) from an extension that is not installed here, and no package owns the name; package ${pkg.package_name} cannot take it over. Remove that data or use a different extension name`,
        );
      }
      await trx
        .insertInto("extension_name_owners")
        .values({ name, package_name: pkg.package_name })
        .onConflict((oc) => oc.column("name").doNothing())
        .execute();
      const owner = await trx
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
          await trx
            .updateTable("extension_installs")
            .set({ catalog_item_id: catalogItemId })
            .where("name", "=", name)
            .execute();
          await this.audit(
            trx,
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
        const unrun = await unrunMigrations(trx, name, target.migrationSql);
        if (unrun.length > 0) {
          throw new ApiError(
            "extension.downgrade_unsupported",
            `Extension ${name} ${pkg.version} has migrations that were never run here (${unrun.join(", ")}); extension migrations only expand, so downgrade only to a version whose migrations have all been applied`,
            unrun.map((file) => ({ file })),
          );
        }
      }
      await trx
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
      await this.audit(trx, actor, actorTokenId, "extension.installed", name, pkg.version, sha256, {
        catalogItemId,
      });
      return { changed: true, state: row?.desired_state ?? "disabled" };
    });
    if (changed.changed) await this.notify(name);
    return this.viewAfterCommit(name, { version: pkg.version, sha256, state: changed.state });
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
    await this.d.db.transaction().execute(async (trx) => {
      if (actor !== null) await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await this.lockRow(trx, name);
      if (!row) throw notFound(name);
      if (row.required) throw required(name);
      if (row.desired_state !== "disabled") {
        throw new ApiError(
          "extension.not_disabled",
          `Extension ${name} is enabled; disable it before uninstalling`,
        );
      }
      await trx.deleteFrom("extension_installs").where("name", "=", name).execute();
      // 来源条目随安装记录一起删：之后不经目录重新安装时不再受旧条目的策略约束（T26 裁决）
      await trx.deleteFrom("extension_catalog_sources").where("plugin", "=", name).execute();
      await this.audit(
        trx,
        actor,
        actorTokenId,
        "extension.uninstalled",
        name,
        row.version,
        row.sha256,
      );
    });
    await this.notify(name);
  }

  private async setState(
    name: string,
    state: "enabled" | "disabled",
    actor: string | null,
    actorTokenId: string | undefined,
  ): Promise<AdminExtensionView> {
    this.assertInstallable(name);
    const result = await this.d.db.transaction().execute(async (trx) => {
      if (actor !== null) await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await this.lockRow(trx, name);
      if (!row) throw notFound(name);
      if (state === "disabled" && row.required) throw required(name);
      if (row.desired_state === state) return { row, changed: false };
      await trx
        .updateTable("extension_installs")
        .set({
          desired_state: state,
          updated_by: actor,
          updated_at: sql<Date>`now()` as unknown as Date,
        })
        .where("name", "=", name)
        .execute();
      await this.audit(
        trx,
        actor,
        actorTokenId,
        state === "enabled" ? "extension.enabled" : "extension.disabled",
        name,
        row.version,
        row.sha256,
      );
      return { row, changed: true };
    });
    if (result.changed) await this.notify(name);
    return this.viewAfterCommit(name, {
      version: result.row.version,
      sha256: result.row.sha256,
      state,
    });
  }

  /**
   * 提交后的视图：拼视图失败（读包、查状态行出错）时操作已经生效，不能再报失败——记 error，返回降级视图。
   */
  private async viewAfterCommit(
    name: string,
    known: { version: string; sha256: string; state: "enabled" | "disabled" | undefined },
  ): Promise<AdminExtensionView> {
    try {
      return await this.d.view(name);
    } catch (err) {
      this.d.log.error("plugin change committed, but its admin view cannot be built", {
        plugin: name,
        err,
      });
      return fallbackView(name, known, err);
    }
  }

  /** 配置声明的插件不经安装记录管理。 */
  private assertInstallable(name: string): void {
    const declared = this.d.declared().get(name);
    if (declared === "config") {
      throw new ApiError(
        "extension.config_declared",
        `Extension ${name} is declared in the startup config (extensions); change that list and restart instead`,
      );
    }
  }

  /** 按插件名串行（咨询锁，覆盖「还没有行」的新装），再锁住已有的安装记录行。 */
  private async lockRow(trx: Trx, name: string) {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-install:${name}`}))`.execute(
      trx,
    );
    return trx
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
    trx: Trx,
    actor: string | null,
    actorTokenId: string | undefined,
    action: string,
    name: string,
    version: string,
    sha256: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await audit(trx, {
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
      await this.d.bus.publish(PLUGINS_CHANGED_TOPIC, { plugin: name });
    } catch (err) {
      this.d.log.warn(
        "cannot publish plugins.changed; replicas converge on the next periodic reconcile",
        { plugin: name, err },
      );
      this.d
        .reconcile?.(`changed:${name}`)
        .catch((e: unknown) =>
          this.d.log.error("plugin reconcile failed", { plugin: name, err: e }),
        );
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
async function hasRetainedData(trx: Trx, name: string): Promise<boolean> {
  const schema = await sql<{
    x: number;
  }>`SELECT 1 AS x FROM pg_namespace WHERE nspname = ${pluginSchemaName(name)}`.execute(trx);
  if (schema.rows.length > 0) return true;
  const hit = await trx
    .selectFrom("extension_permission_snapshots")
    .select(sql<number>`1`.as("x"))
    .where("plugin", "=", name)
    .union(
      trx
        .selectFrom("extension_deployment_configs")
        .select(sql<number>`1`.as("x"))
        .where("plugin", "=", name),
    )
    .union(
      trx
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
