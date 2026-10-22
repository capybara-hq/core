import { type CapybaraPackageSection, SDK_VERSION } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import {
  fetchNpmPackage,
  IntegrityMismatchError,
  type NpmFetchConfig,
  NpmFetchError,
  PackageTooLargeError,
} from "../packages/npm.js";
import { PluginApprovals } from "./approvals.js";
import type { PluginBlobs } from "./blobs.js";
import { PluginPackageError, permissionSetOfPackage, readPluginPackage } from "./package.js";
import { diffPermissions } from "./permission-set.js";
import {
  migrationWarnings,
  type PackageWarning,
  type PermissionGroup,
  type PermissionItem,
  permissionGroups,
  permissionKeyItems,
  reviewHash,
} from "./permission-view.js";

export { migrationWarnings, type PackageWarning };

import type { PluginSource } from "./sources.js";

/** 上传 / 拉取一个包后的审阅结果（权限按静态清单与迁移 SQL 计算，不执行插件代码）。 */
export interface PackageReview {
  sha256: string;
  name: string;
  version: string;
  permissions: PermissionGroup[];
  /** 相对该插件当前权限快照多出 / 少了的权限键（没有快照时全部算新增）。 */
  added: string[];
  /** `added` 逐项的敏感标记与原因（界面据此高亮，不自己判定）。 */
  addedItems: PermissionItem[];
  removed: string[];
  /** 见 {@link reviewHash}：批准时回传，审阅后权限变了就拒绝。 */
  reviewHash: string;
  /**
   * 审阅警告（敏感，界面高亮；不拒绝）：插件迁移只该做扩展，包里的破坏性语句（删表 / 删列、TRUNCATE、DELETE、
   * RENAME、改列类型）逐条列出——新旧版本会在不同副本上同时运行，破坏性迁移可能让旧版本出错或丢数据。
   */
  warnings: PackageWarning[];
}

/** 安装记录一行（`plugin_installs` 加包的 npm 包名）。 */
export interface PluginInstallRow {
  name: string;
  sha256: string;
  version: string;
  source: "npm" | "file" | "directory";
  packageName: string;
  desiredState: "enabled" | "disabled";
  migratedSha: string | null;
  installedBy: string | null;
  installedAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

/** 期望启用的安装记录（各副本据此同步并加载）。 */
export interface DesiredPlugin {
  name: string;
  sha256: string;
  version: string;
  source: "npm" | "file" | "directory";
  migratedSha: string | null;
  /** 审阅过的静态 `capybara` 段（migrations 路径只从这里取）。 */
  section: CapybaraPackageSection;
}

/** 包的来源（F-L）：目录 / 清单 / 应用导入一律记 `directory`，`ref` 写条目或清单的定位。 */
export interface IngestSource {
  source: "npm" | "file" | "directory";
  ref: string;
}

export interface PluginInstallsDeps {
  db: KernelDb;
  blobs: PluginBlobs;
  config: () => KernelConfig;
  /** 内置与配置声明的插件名 → 来源（安装包不能与它们重名，C14 / C15）。 */
  declared: () => ReadonlyMap<string, PluginSource>;
  /** npm 下载的总时限（毫秒），默认 120s。 */
  npmTimeoutMs?: number;
}

/** 插件安装记录与包的导入（上传文件、npm）。本身无状态，多副本共用。 */
export class PluginInstalls {
  constructor(private readonly d: PluginInstallsDeps) {}

  /**
   * 校验并存入一个包，返回审阅结果；写审计 `plugin.package_uploaded`。只入库，不安装、不改期望状态（T14）。
   * - 超过 `packages.maxBytes` → `plugin.package_too_large`；包不合法 → `plugin.package_invalid`（details 逐条列出）；
   * - 插件名与内置插件重名 → `plugin.builtin`，与配置声明的插件重名 → `plugin.config_declared`；
   * - 已有同名安装记录但来自另一个 npm 包 → `plugin.name_conflict`（同一个包的新版本是升级，另行处理）。
   * `actor` 为 null 表示 CLI（不做企业管理员复核，审计无发起人）。
   */
  async ingest(
    actor: string | null,
    bytes: Uint8Array,
    src: IngestSource,
    opts: { actorTokenId?: string; store?: "object" | "pg"; expectPackageName?: string } = {},
  ): Promise<PackageReview> {
    const maxBytes = this.d.config().packages.maxBytes;
    if (bytes.byteLength > maxBytes) {
      throw new ApiError(
        "plugin.package_too_large",
        `The plugin package is larger than ${maxBytes} bytes`,
      );
    }
    let pkg: Awaited<ReturnType<typeof readPluginPackage>>;
    try {
      pkg = await readPluginPackage(bytes, { maxBytes, hostSdkVersion: SDK_VERSION });
    } catch (e) {
      if (e instanceof PluginPackageError) {
        throw new ApiError("plugin.package_invalid", e.message, e.issues);
      }
      throw e;
    }
    const m = pkg.section.manifest;
    const packageName = String(pkg.packageJson.name);
    if (opts.expectPackageName !== undefined && packageName !== opts.expectPackageName) {
      const issue = `package.json name "${packageName}" does not match the requested npm package ${opts.expectPackageName}`;
      throw new ApiError("plugin.package_invalid", `Invalid plugin package: ${issue}`, [issue]);
    }
    const declared = this.d.declared().get(m.name);
    if (declared === "builtin") {
      throw new ApiError(
        "plugin.builtin",
        `Plugin ${m.name} is built into this deployment and cannot be installed from a package`,
      );
    }
    if (declared === "config") {
      throw new ApiError(
        "plugin.config_declared",
        `Plugin ${m.name} is declared in the startup config (plugins); remove it there before installing it as a package`,
      );
    }
    const installed = await this.d.db
      .selectFrom("plugin_installs")
      .innerJoin("plugin_packages", "plugin_packages.sha256", "plugin_installs.sha256")
      .select("plugin_packages.package_name")
      .where("plugin_installs.name", "=", m.name)
      .executeTakeFirst();
    if (installed && installed.package_name !== packageName) {
      throw new ApiError(
        "plugin.name_conflict",
        `Plugin ${m.name} is already installed from package ${installed.package_name}; package ${packageName} uses the same plugin name`,
      );
    }

    // 写包之前在锁内复核发起人仍是企业管理员（守卫读到的身份可能已过期）；审计在写完后同样复核
    if (actor !== null) {
      await this.d.db.transaction().execute((trx) => lockEnterpriseAdminsAndAuthorize(trx, actor));
    }
    await this.d.blobs.put(pkg, bytes, {
      source: src.source,
      ref: src.ref,
      actor,
      ...(opts.store !== undefined && { store: opts.store }),
    });
    await this.d.db.transaction().execute(async (trx) => {
      if (actor !== null) await lockEnterpriseAdminsAndAuthorize(trx, actor);
      await audit(trx, {
        ...(actor !== null && { actorAccountId: actor }),
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "plugin.package_uploaded",
        target: m.name,
        detail: { name: m.name, version: m.version, sha256: pkg.sha256, source: src.source },
      });
    });

    const set = permissionSetOfPackage(pkg);
    const snapshot = (await new PluginApprovals(this.d.db).all()).get(m.name);
    const { added, removed } = diffPermissions(snapshot?.permissions, set);
    const warnings = migrationWarnings(pkg.migrationSql, m.name);
    return {
      sha256: pkg.sha256,
      name: m.name,
      version: m.version,
      permissions: permissionGroups(set),
      added,
      addedItems: permissionKeyItems(added),
      removed,
      reviewHash: reviewHash(set, warnings),
      warnings,
    };
  }

  /** 上传的 tgz（来源 `file`）。 */
  ingestFile(
    actor: string | null,
    bytes: Uint8Array,
    opts: { actorTokenId?: string; store?: "object" | "pg" } = {},
  ): Promise<PackageReview> {
    return this.ingest(actor, bytes, { source: "file", ref: "upload" }, opts);
  }

  /**
   * 从配置的 npm registry 拉取一个包（按 `dist.integrity` 校验，见 packages/npm.ts），只下载不入库：
   * 下载失败 → `packages.npm_failed`（502）；超过 `packages.maxBytes` → `plugin.package_too_large`。
   * 企业目录的 npm 导入也用它。
   */
  async fetchNpm(
    input: { package: string; version?: string },
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; version: string; integrity: string }> {
    const c = this.d.config();
    const cfg: NpmFetchConfig = {
      registry: c.packages.npmRegistry,
      maxBytes: c.packages.maxBytes,
      ...(c.packages.npmToken !== undefined && { token: c.packages.npmToken }),
    };
    const timeout = AbortSignal.timeout(this.d.npmTimeoutMs ?? 120_000);
    try {
      return await fetchNpmPackage(
        cfg,
        input.package,
        input.version,
        signal ? AbortSignal.any([signal, timeout]) : timeout,
      );
    } catch (e) {
      if (e instanceof PackageTooLargeError) {
        throw new ApiError("plugin.package_too_large", e.message);
      }
      if (e instanceof NpmFetchError) throw new ApiError("packages.npm_failed", e.message);
      throw e;
    }
  }

  /**
   * 按清单下载一个包（T24，C26）：清单给了 `tarball` 就从它下载（必须 https，`catalogs.allowInsecureLoopback`
   * 只供测试；不请求 registry 元数据、不带 registry 令牌），否则走配置的 npm registry；校验一律以清单的 sha512
   * 为准，不认 npm 元数据。不符 → 502 `catalog.integrity_mismatch`（写明期望与实际 sha512 的前缀）；
   * 下载失败 → 502 `catalog.fetch_failed`；超过 `packages.maxBytes` → `plugin.package_too_large`。
   */
  async fetchCatalogPackage(
    input: { package: string; version: string; integrity: string; tarball?: string },
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; version: string; integrity: string }> {
    const c = this.d.config();
    const cfg: NpmFetchConfig = {
      registry: c.packages.npmRegistry,
      maxBytes: c.packages.maxBytes,
      allowInsecureLoopback: c.catalogs.allowInsecureLoopback,
      ...(c.packages.npmToken !== undefined && { token: c.packages.npmToken }),
    };
    const timeout = AbortSignal.timeout(this.d.npmTimeoutMs ?? 120_000);
    try {
      return await fetchNpmPackage(
        cfg,
        input.package,
        input.version,
        signal ? AbortSignal.any([signal, timeout]) : timeout,
        {
          expectedIntegrity: input.integrity,
          ...(input.tarball !== undefined && { tarballUrl: input.tarball }),
        },
      );
    } catch (e) {
      if (e instanceof PackageTooLargeError) {
        throw new ApiError("plugin.package_too_large", e.message);
      }
      if (e instanceof IntegrityMismatchError) {
        const prefix = (sri: string) => `${sri.slice(0, 19)}…`;
        throw new ApiError(
          "catalog.integrity_mismatch",
          `The package does not match the catalog (expected ${prefix(e.expected)}, got ${prefix(e.actual)}); installation refused`,
          [{ expected: prefix(e.expected), actual: prefix(e.actual) }],
        );
      }
      if (e instanceof NpmFetchError) throw new ApiError("catalog.fetch_failed", e.message);
      throw e;
    }
  }

  /**
   * 从配置的 npm registry 拉取（来源 `npm`，`ref` 为 `<包名>@<版本>`）。下载失败 → `packages.npm_failed`（502）；
   * 超过大小上限 → `plugin.package_too_large`；包里的 npm 包名与请求的不一致 → `plugin.package_invalid`。
   */
  async ingestNpm(
    actor: string | null,
    input: { package: string; version?: string },
    opts: { actorTokenId?: string; store?: "object" | "pg"; signal?: AbortSignal } = {},
  ): Promise<PackageReview> {
    const got = await this.fetchNpm(input, opts.signal);
    return this.ingest(
      actor,
      got.bytes,
      { source: "npm", ref: `${input.package}@${got.version}` },
      {
        expectPackageName: input.package,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        ...(opts.store !== undefined && { store: opts.store }),
      },
    );
  }

  /** 全部安装记录（按名字）。 */
  async list(): Promise<PluginInstallRow[]> {
    const rows = await this.d.db
      .selectFrom("plugin_installs")
      .innerJoin("plugin_packages", "plugin_packages.sha256", "plugin_installs.sha256")
      .selectAll("plugin_installs")
      .select("plugin_packages.package_name")
      .orderBy("plugin_installs.name")
      .execute();
    return rows.map((r) => ({
      name: r.name,
      sha256: r.sha256,
      version: r.version,
      source: r.source,
      packageName: r.package_name,
      desiredState: r.desired_state,
      migratedSha: r.migrated_sha,
      installedBy: r.installed_by,
      installedAt: r.installed_at.toISOString(),
      updatedBy: r.updated_by,
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  /** 期望启用的安装记录及其审阅过的 `capybara` 段（按名字）。 */
  async desired(): Promise<DesiredPlugin[]> {
    const rows = await this.d.db
      .selectFrom("plugin_installs")
      .innerJoin("plugin_packages", "plugin_packages.sha256", "plugin_installs.sha256")
      .select([
        "plugin_installs.name",
        "plugin_installs.sha256",
        "plugin_installs.version",
        "plugin_installs.source",
        "plugin_installs.migrated_sha",
        "plugin_packages.section",
      ])
      .where("plugin_installs.desired_state", "=", "enabled")
      .orderBy("plugin_installs.name")
      .execute();
    return rows.map((r) => ({
      name: r.name,
      sha256: r.sha256,
      version: r.version,
      source: r.source,
      migratedSha: r.migrated_sha,
      section: r.section as CapybaraPackageSection,
    }));
  }
}
