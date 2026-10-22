import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import semver from "semver";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { PLUGINS_CHANGED_TOPIC } from "./lifecycle.js";
import { unrunMigrations } from "./migrate-lock.js";
import { readPluginPackage } from "./package.js";
import type { AdminPluginView } from "./permission-view.js";
import type { PluginSource } from "./sources.js";

export interface PluginAdminOpsDeps {
  db: KernelDb;
  /**
   * 返回操作后的后台视图；包读不到时应返回降级项（`PluginAdmin.get(name, { allowUnreadable: true })`）。
   * 它抛错时操作已提交：ops 记 error 并返回 {@link fallbackView}，不让已生效的操作报失败。
   */
  view(name: string): Promise<AdminPluginView>;
  /** 内置与配置声明的插件名 → 来源（这些插件不能安装 / 停用 / 卸载，C14 / C15）。 */
  declared(): ReadonlyMap<string, PluginSource>;
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
 * 部署级插件的安装 / 启用 / 停用 / 卸载（C16 / D15）：只写 PG 期望状态（`plugin_installs`）与审计，提交后发布
 * `kernel.plugins.changed`（失败只告警，周期 reconcile 兜底），各副本经 reconcile 收敛，不重启。
 * 不等副本收敛：返回的视图里状态可能是 `converging`。无状态，多副本共用；CLI 同样使用（`actor` 为 null）。
 * 写操作都在事务里：先 `lockEnterpriseAdminsAndAuthorize`（CLI 跳过），再按插件名取咨询锁、锁安装记录行。
 */
export class PluginAdminOps {
  constructor(private readonly d: PluginAdminOpsDeps) {}

  /**
   * 新装或换版本（升级 / 降级）：安装记录指向包 `sha256`；期望状态不变（新装为 disabled）。审计 `plugin.installed`。
   * - 内置 → `plugin.builtin`；配置声明 → `plugin.config_declared`；
   * - 包不在包存储 → `plugin.package_not_found`；包里的插件名不是 `name` → `plugin.name_mismatch`；
   * - 已有同名安装记录、但来自另一个 npm 包 → `plugin.name_conflict`（在事务里锁行判断，无竞态）；
   *   插件名归第一次安装它的 npm 包（`plugin_name_owners`，卸载不删）：卸载后别的包用同名插件安装同样
   *   `plugin.name_conflict`（Ruling P3：卸载保留数据、密钥、快照与组织启用）；同一个 npm 包重新安装照常；
   *   内置 / 配置声明的插件启动时也登记归属（I4）；名字没有归属却已有快照 / 部署配置 / 组织配置 → 同样
   *   `plugin.name_conflict`；
   * - 降级（目标版本低于当前）且目标版本有尚未执行的迁移文件 → `plugin.downgrade_unsupported`（迁移只做扩展，
   *   降级只能回到迁移是已执行迁移子集的版本）。
   * 已指向同一个包时什么都不改（不写审计）。
   */
  async install(
    name: string,
    sha256: string,
    actor: string | null,
    actorTokenId?: string,
  ): Promise<AdminPluginView> {
    this.assertInstallable(name);
    const pkg = await this.d.db
      .selectFrom("plugin_packages")
      .select(["sha256", "name", "package_name", "version", "source"])
      .where("sha256", "=", sha256)
      .executeTakeFirst();
    if (!pkg) {
      throw new ApiError(
        "plugin.package_not_found",
        `Plugin package ${sha256} is not in the package store; upload it first`,
      );
    }
    if (pkg.name !== name) {
      throw new ApiError(
        "plugin.name_mismatch",
        `Package ${sha256} contains plugin ${pkg.name}, not ${name}`,
      );
    }
    // 降级判断要用目标包的迁移文件：事务外先读包、解析（事务里只比对 _migrations）
    const target = await readPluginPackage(await this.d.blobs.get(sha256), {
      maxBytes: this.d.config().packages.maxBytes,
      hostSdkVersion: SDK_VERSION,
    });
    const changed = await this.d.db.transaction().execute(async (trx) => {
      if (actor !== null) await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await this.lockRow(trx, name);
      if (row && row.package_name !== pkg.package_name) {
        throw new ApiError(
          "plugin.name_conflict",
          `Plugin ${name} is already installed from package ${row.package_name}; package ${pkg.package_name} uses the same plugin name`,
        );
      }
      // Ruling P3：插件名归第一次安装它的 npm 包（卸载不删），别的包不能接手（数据、密钥与批准都还在）。
      // 还没有归属、却已有这个名字留下的快照 / 部署配置 / 组织配置（I4：如归属表之前就有的配置声明插件）：
      // 不知道它们属于哪个包，同样拒绝
      const owned = await trx
        .selectFrom("plugin_name_owners")
        .select("package_name")
        .where("name", "=", name)
        .executeTakeFirst();
      if (!owned && (await hasRetainedData(trx, name))) {
        throw new ApiError(
          "plugin.name_conflict",
          `Plugin name ${name} already has retained data (permission approval, deployment config or organization settings) from a plugin that is not installed here, and no package owns the name; package ${pkg.package_name} cannot take it over. Remove that data or use a different plugin name`,
        );
      }
      await trx
        .insertInto("plugin_name_owners")
        .values({ name, package_name: pkg.package_name })
        .onConflict((oc) => oc.column("name").doNothing())
        .execute();
      const owner = await trx
        .selectFrom("plugin_name_owners")
        .select("package_name")
        .where("name", "=", name)
        .executeTakeFirstOrThrow();
      if (owner.package_name !== pkg.package_name) {
        throw new ApiError(
          "plugin.name_conflict",
          `Plugin name ${name} was previously used by package ${owner.package_name}; its data, secrets and permission approval are retained for that package, so package ${pkg.package_name} cannot take over the name`,
        );
      }
      if (row?.sha256 === sha256) return null;
      if (row && isDowngrade(pkg.version, row.version)) {
        const unrun = await unrunMigrations(trx, name, target.migrationSql);
        if (unrun.length > 0) {
          throw new ApiError(
            "plugin.downgrade_unsupported",
            `Plugin ${name} ${pkg.version} has migrations that were never run here (${unrun.join(", ")}); plugin migrations only expand, so downgrade only to a version whose migrations have all been applied`,
            unrun.map((file) => ({ file })),
          );
        }
      }
      await trx
        .insertInto("plugin_installs")
        .values({
          name,
          sha256,
          version: pkg.version,
          source: pkg.source,
          desired_state: "disabled",
          installed_by: actor,
          updated_by: actor,
        })
        .onConflict((oc) =>
          oc.column("name").doUpdateSet({
            sha256,
            version: pkg.version,
            source: pkg.source,
            updated_by: actor,
            updated_at: sql<Date>`now()` as unknown as Date,
          }),
        )
        .execute();
      await this.audit(trx, actor, actorTokenId, "plugin.installed", name, pkg.version, sha256);
      return { version: pkg.version, state: row?.desired_state ?? "disabled" };
    });
    if (changed) await this.notify(name);
    return this.viewAfterCommit(name, {
      version: pkg.version,
      sha256,
      state: changed ? changed.state : undefined,
    });
  }

  /** 部署上启用（审计 `plugin.enabled`）；已启用时不改。组织里的启用开关不变。 */
  enable(name: string, actor: string | null, actorTokenId?: string): Promise<AdminPluginView> {
    return this.setState(name, "enabled", actor, actorTokenId);
  }

  /**
   * 部署上停用（审计 `plugin.disabled`）；已停用时不改。各副本卸下它（在途调用排空），`requires` 它的插件随之卸下；
   * 组织里的启用开关不变，组织页显示为不可用。
   */
  disable(name: string, actor: string | null, actorTokenId?: string): Promise<AdminPluginView> {
    return this.setState(name, "disabled", actor, actorTokenId);
  }

  /**
   * 卸载：须先停用（否则 `plugin.not_disabled`）；删除安装记录（审计 `plugin.uninstalled`），数据保留：
   * 插件 schema、密钥、组织配置、权限快照与包存储里的包都不动（重新安装后接着用）。
   */
  async uninstall(name: string, actor: string | null, actorTokenId?: string): Promise<void> {
    this.assertInstallable(name);
    await this.d.db.transaction().execute(async (trx) => {
      if (actor !== null) await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await this.lockRow(trx, name);
      if (!row) throw notFound(name);
      if (row.desired_state !== "disabled") {
        throw new ApiError(
          "plugin.not_disabled",
          `Plugin ${name} is enabled; disable it before uninstalling`,
        );
      }
      await trx.deleteFrom("plugin_installs").where("name", "=", name).execute();
      await this.audit(
        trx,
        actor,
        actorTokenId,
        "plugin.uninstalled",
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
  ): Promise<AdminPluginView> {
    this.assertInstallable(name);
    const result = await this.d.db.transaction().execute(async (trx) => {
      if (actor !== null) await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await this.lockRow(trx, name);
      if (!row) throw notFound(name);
      if (row.desired_state === state) return { row, changed: false };
      await trx
        .updateTable("plugin_installs")
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
        state === "enabled" ? "plugin.enabled" : "plugin.disabled",
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
  ): Promise<AdminPluginView> {
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

  /** 内置 / 配置声明的插件不经安装记录管理。 */
  private assertInstallable(name: string): void {
    const declared = this.d.declared().get(name);
    if (declared === "builtin") {
      throw new ApiError(
        "plugin.builtin",
        `Plugin ${name} is built into this deployment; it is always enabled and cannot be installed, disabled or uninstalled`,
      );
    }
    if (declared === "config") {
      throw new ApiError(
        "plugin.config_declared",
        `Plugin ${name} is declared in the startup config (plugins); change that list and restart instead`,
      );
    }
  }

  /** 按插件名串行（咨询锁，覆盖「还没有行」的新装），再锁住已有的安装记录行。 */
  private async lockRow(trx: Trx, name: string) {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-install:${name}`}))`.execute(
      trx,
    );
    return trx
      .selectFrom("plugin_installs")
      .innerJoin("plugin_packages", "plugin_packages.sha256", "plugin_installs.sha256")
      .select([
        "plugin_installs.sha256",
        "plugin_installs.version",
        "plugin_installs.desired_state",
        "plugin_packages.package_name",
      ])
      .where("plugin_installs.name", "=", name)
      .forUpdate("plugin_installs")
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
  ): Promise<void> {
    await audit(trx, {
      ...(actor !== null && { actorAccountId: actor }),
      ...(actorTokenId !== undefined && { actorTokenId }),
      action,
      target: name,
      detail: { name, version, sha256 },
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
): AdminPluginView {
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
    error: `the change was saved, but its current status cannot be read: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** 插件名已留下的数据：权限快照、部署配置或任一组织的配置。 */
async function hasRetainedData(trx: Trx, name: string): Promise<boolean> {
  const hit = await trx
    .selectFrom("plugin_permission_snapshots")
    .select(sql<number>`1`.as("x"))
    .where("plugin", "=", name)
    .union(
      trx
        .selectFrom("plugin_deployment_configs")
        .select(sql<number>`1`.as("x"))
        .where("plugin", "=", name),
    )
    .union(
      trx.selectFrom("plugin_org_configs").select(sql<number>`1`.as("x")).where("plugin", "=", name),
    )
    .limit(1)
    .executeTakeFirst();
  return hit !== undefined;
}

const notFound = (name: string) =>
  new ApiError("plugin.not_found", `Plugin ${name} is not installed in this deployment`);

/** `to` 比 `from` 旧（任一方不是合法 semver 时不算降级）。 */
const isDowngrade = (to: string, from: string): boolean =>
  semver.valid(to) !== null && semver.valid(from) !== null && semver.lt(to, from);
