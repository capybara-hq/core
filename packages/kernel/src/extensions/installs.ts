import { type PluginExtensionSection, SDK_VERSION } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError, type ErrorCode } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import {
  fetchNpmPackage,
  IntegrityMismatchError,
  type NpmFetchConfig,
  NpmFetchError,
  PackageTooLargeError,
} from "../packages/npm.js";
import { ExtensionApprovals } from "./approvals.js";
import type { ExtensionBlobs } from "./blobs.js";
import {
  ExtensionPackageError,
  extensionPackageApiError,
  permissionSetOfPackage,
  readExtensionPackage,
} from "./package.js";
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

import type { ExtensionSource } from "./sources.js";

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

/** One install record (`extension_installs` plus the package's npm name). */
export interface ExtensionInstallRow {
  name: string;
  sha256: string;
  version: string;
  source: "npm" | "file" | "catalog";
  packageName: string;
  desiredState: "enabled" | "disabled";
  migratedSha: string | null;
  installedBy: string | null;
  installedAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

/** 期望启用的安装记录（各副本据此同步并加载）。 */
export interface DesiredExtension {
  name: string;
  sha256: string;
  version: string;
  source: "npm" | "file" | "catalog";
  migratedSha: string | null;
  /**
   * The reviewed extension section of the plugin (the migrations path is taken only from here). A
   * row stored before 0.1.0 holds the old `capybara` section instead; its package is in the old
   * format and fails to sync with `extension.legacy_format`.
   */
  section: PluginExtensionSection;
}

/**
 * Where a package comes from (F-L): catalog / marketplace / app imports all record `catalog`, with
 * `ref` locating the item or the marketplace entry.
 */
export interface IngestSource {
  source: "npm" | "file" | "catalog";
  ref: string;
}

export interface ExtensionInstallsDeps {
  db: KernelDb;
  blobs: ExtensionBlobs;
  config: () => KernelConfig;
  /** 内置与配置声明的插件名 → 来源（安装包不能与它们重名，C14 / C15）。 */
  declared: () => ReadonlyMap<string, ExtensionSource>;
  /** npm 下载的总时限（毫秒），默认 120s。 */
  npmTimeoutMs?: number;
}

/** 插件安装记录与包的导入（上传文件、npm）。本身无状态，多副本共用。 */
export class ExtensionInstalls {
  constructor(private readonly d: ExtensionInstallsDeps) {}

  /**
   * Validates and stores one package and returns the review; audits `extension.package_uploaded`.
   * Only stores: no install, no desired state change (T14).
   * - Over `packages.maxBytes` -> `extension.package_too_large`; invalid package ->
   *   `extension.package_invalid` (details list each problem);
   * - extension name equal to a builtin extension -> `extension.builtin`, to a config-declared one ->
   *   `extension.config_declared`;
   * - an install record of the same name comes from another npm package -> `extension.name_conflict`
   *   (a new version of the same package is an upgrade, handled elsewhere).
   * `actor` null means the CLI (no enterprise admin re-check, audit without an actor).
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
        "extension.package_too_large",
        `The extension package is larger than ${maxBytes} bytes`,
      );
    }
    let pkg: Awaited<ReturnType<typeof readExtensionPackage>>;
    try {
      pkg = await readExtensionPackage(bytes, { maxBytes, hostSdkVersion: SDK_VERSION });
    } catch (e) {
      if (e instanceof ExtensionPackageError) throw extensionPackageApiError(e);
      throw e;
    }
    const m = pkg.section.manifest;
    const packageName = String(pkg.packageJson.name);
    if (opts.expectPackageName !== undefined && packageName !== opts.expectPackageName) {
      const issue = `package.json name "${packageName}" does not match the requested npm package ${opts.expectPackageName}`;
      throw new ApiError("extension.package_invalid", `Invalid extension package: ${issue}`, [
        issue,
      ]);
    }
    const declared = this.d.declared().get(m.name);
    if (declared === "builtin") {
      throw new ApiError(
        "extension.builtin",
        `Extension ${m.name} is built into this deployment and cannot be installed from a package`,
      );
    }
    if (declared === "config") {
      throw new ApiError(
        "extension.config_declared",
        `Extension ${m.name} is declared in the startup config (extensions); remove it there before installing it as a package`,
      );
    }
    const installed = await this.d.db
      .selectFrom("extension_installs")
      .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
      .select("extension_packages.package_name")
      .where("extension_installs.name", "=", m.name)
      .executeTakeFirst();
    if (installed && installed.package_name !== packageName) {
      throw new ApiError(
        "extension.name_conflict",
        `Extension ${m.name} is already installed from package ${installed.package_name}; package ${packageName} uses the same extension name`,
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
        action: "extension.package_uploaded",
        target: m.name,
        detail: { name: m.name, version: m.version, sha256: pkg.sha256, source: src.source },
      });
    });

    const set = permissionSetOfPackage(pkg);
    const snapshot = (await new ExtensionApprovals(this.d.db).all()).get(m.name);
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
   * Fetches one package from the configured npm registry (verified by `dist.integrity`, see
   * packages/npm.ts), downloading only, not storing: download failure -> `packages.npm_failed` (502);
   * over `packages.maxBytes` -> `extension.package_too_large`. Enterprise catalog npm imports use it
   * too.
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
        throw new ApiError("extension.package_too_large", e.message);
      }
      if (e instanceof NpmFetchError) throw new ApiError("packages.npm_failed", e.message);
      throw e;
    }
  }

  /**
   * Downloads the package of a marketplace npm source (T24, C26): from `tarball` when given (https
   * required, `marketplaces.allowInsecureLoopback` for tests only; no registry metadata request;
   * `packages.npmToken` is sent only when the tarball has the registry's origin), otherwise from the
   * configured npm registry; always verified against the marketplace's sha512, never npm metadata.
   * Mismatch -> 502 `marketplace.integrity_mismatch` (with prefixes of the expected and actual sha512);
   * download failure -> 502 `marketplace.fetch_failed`; over `packages.maxBytes` ->
   * `extension.package_too_large`.
   */
  fetchMarketplacePackage(
    input: { package: string; version: string; integrity: string; tarball?: string },
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; version: string; integrity: string }> {
    return this.fetchVerified(input, signal, {
      mismatch: "marketplace.integrity_mismatch",
      failed: "marketplace.fetch_failed",
      against: "the marketplace",
    });
  }

  private async fetchVerified(
    input: { package: string; version: string; integrity: string; tarball?: string },
    signal: AbortSignal | undefined,
    codes: { mismatch: ErrorCode; failed: ErrorCode; against: string },
  ): Promise<{ bytes: Uint8Array; version: string; integrity: string }> {
    const c = this.d.config();
    const cfg: NpmFetchConfig = {
      registry: c.packages.npmRegistry,
      maxBytes: c.packages.maxBytes,
      allowInsecureLoopback: c.marketplaces.allowInsecureLoopback,
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
        throw new ApiError("extension.package_too_large", e.message);
      }
      if (e instanceof IntegrityMismatchError) {
        const prefix = (sri: string) => `${sri.slice(0, 19)}…`;
        throw new ApiError(
          codes.mismatch,
          `The package does not match ${codes.against} (expected ${prefix(e.expected)}, got ${prefix(e.actual)}); installation refused`,
          [{ expected: prefix(e.expected), actual: prefix(e.actual) }],
        );
      }
      if (e instanceof NpmFetchError) throw new ApiError(codes.failed, e.message);
      throw e;
    }
  }

  /**
   * Fetches from the configured npm registry (source `npm`, `ref` is `<package>@<version>`). Download
   * failure -> `packages.npm_failed` (502); over the size limit -> `extension.package_too_large`; the
   * npm name in the package differs from the requested one -> `extension.package_invalid`.
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
  async list(): Promise<ExtensionInstallRow[]> {
    const rows = await this.d.db
      .selectFrom("extension_installs")
      .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
      .selectAll("extension_installs")
      .select("extension_packages.package_name")
      .orderBy("extension_installs.name")
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

  /** Install records desired enabled, with their reviewed extension sections (by name). */
  async desired(): Promise<DesiredExtension[]> {
    const rows = await this.d.db
      .selectFrom("extension_installs")
      .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
      .select([
        "extension_installs.name",
        "extension_installs.sha256",
        "extension_installs.version",
        "extension_installs.source",
        "extension_installs.migrated_sha",
        "extension_packages.section",
      ])
      .where("extension_installs.desired_state", "=", "enabled")
      .orderBy("extension_installs.name")
      .execute();
    return rows.map((r) => ({
      name: r.name,
      sha256: r.sha256,
      version: r.version,
      source: r.source,
      migratedSha: r.migrated_sha,
      section: r.section as PluginExtensionSection,
    }));
  }
}
