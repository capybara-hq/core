import { type PluginExtensionSection, SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { core } from "zod";
import { marketplaceNetPolicy } from "../catalog/marketplace-fetch.js";
import { configFields } from "../config/fields.js";
import type { Keyring } from "../ctx/secrets.js";
import { ApiError, type ErrorCode } from "../errors.js";
import { audit } from "../identity/audit.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KEYRING } from "../infra/tokens.js";
import { OrgLock } from "../orgs/org-lock.js";
import {
  fetchNpmPackage,
  IntegrityMismatchError,
  type NpmFetchConfig,
  NpmFetchError,
  PackageTooLargeError,
} from "../packages/npm.js";
import {
  fetchProvenance,
  PROVENANCE_TIMEOUT_MS,
  type ProvenanceResult,
} from "../packages/provenance.js";
import { ExtensionApprovals } from "./approvals.js";
import { ExtensionBlobs } from "./blobs.js";
import {
  mergeDeploymentConfig,
  readStoredDeploymentConfig,
  schemaFields,
  secretPathsOf,
} from "./deployment-config-store.js";
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

import { ExtensionRegistry } from "./registry.js";

export { migrationWarnings, type PackageWarning };

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
  source: "npm" | "file" | "catalog" | "bootstrap";
  packageName: string;
  desiredState: "enabled" | "disabled";
  /** A required bootstrap plugin (enabled in every org; cannot be disabled or uninstalled). */
  required: boolean;
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
  source: "npm" | "file" | "catalog" | "bootstrap";
  migratedSha: string | null;
  /**
   * Where the package bytes are kept. At startup the host loads the packages kept in PG first: the
   * object store serving the others may itself be one of them (a bootstrap plugin).
   */
  blobStore?: "object" | "pg";
  /**
   * The reviewed extension section of the plugin (the migrations path is taken only from here). A
   * row stored before 0.1.0 holds the old `capybara` section instead; its package is in the old
   * format and fails to sync with `extension.legacy_format`.
   */
  section: PluginExtensionSection;
}

/**
 * Where a package comes from (F-L): catalog / marketplace / app imports all record `catalog`, with
 * `ref` locating the item or the marketplace entry; the bootstrap step records `bootstrap`
 * (`ref` `bootstrap:<name>@<version>`).
 */
export interface IngestSource {
  source: "npm" | "file" | "catalog" | "bootstrap";
  ref: string;
}

/** The npm download time limit (ms). */
const NPM_TIMEOUT_MS = 120_000;

/**
 * Extension install records and package imports (uploaded file, npm), and the deployment's desired
 * state the replicas converge to: the install records desired enabled and each extension's
 * effective deployment config (the startup config completed by the fields stored in PG). Stateless,
 * shared by every replica; the extension host reads the desired state from here (one way).
 */
@Injectable()
export class ExtensionInstalls {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** The super admin lock (identity/super-admin.ts): joins the transaction. */
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    @Inject(ExtensionBlobs) private readonly blobs: ExtensionBlobs,
    @Inject(ExtensionApprovals) private readonly approvals: ExtensionApprovals,
    /** The config-declared extension names (an install cannot take them, C15). */
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    /** The owner org's lock: an org upload re-checks its org admin instead (ruling P3-10). */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
  ) {}

  /**
   * An extension's effective deployment config, not validated yet (C10): the startup config
   * (`fileValue`, file / Nacos merged with env) completed by the fields stored in PG; merged by
   * the fields of `schema` when it is given.
   */
  async effectiveDeploymentConfig(
    plugin: string,
    fileValue: unknown,
    schema?: core.$ZodType,
  ): Promise<unknown> {
    const stored = await readStoredDeploymentConfig(this.db.db, this.keyring, plugin, {
      secretPaths: secretPathsOf(schemaFields(schema)),
    });
    const fields = schema ? configFields(schema).map((f) => f.path) : undefined;
    return mergeDeploymentConfig(stored, fileValue, fields);
  }

  /**
   * Whether PG holds a deployment config row for the extension (a super admin saved one and has
   * not cleared it since; `DELETE /api/v1/admin/extensions/:name/config` removes it).
   */
  async hasStoredDeploymentConfig(plugin: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("extension_deployment_configs")
      .select("plugin")
      .where("plugin", "=", plugin)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Every install record's extension name (any desired state). */
  async installedNames(): Promise<string[]> {
    const rows = await this.db.selectFrom("extension_installs").select("name").execute();
    return rows.map((r) => r.name);
  }

  /**
   * Validates and stores one package and returns the review; audits `extension.package_uploaded`.
   * Only stores: no install, no desired state change (T14).
   * - Over `packages.maxBytes` -> `extension.package_too_large`; invalid package ->
   *   `extension.package_invalid` (details list each problem);
   * - extension name equal to a config-declared one -> `extension.config_declared`;
   * - an install record of the same name comes from another npm package -> `extension.name_conflict`
   *   (a new version of the same package is an upgrade, handled elsewhere).
   * `actor` null means the CLI (no super admin re-check, audit without an actor). `owner`: an org
   * upload (spec §14, P3-10): the actor is re-checked as an org admin of that org (`catalog.upload`)
   * instead of a super admin; the package is only stored, as always (nothing runs, no install).
   */
  async ingest(
    actor: string | null,
    bytes: Uint8Array,
    src: IngestSource,
    opts: {
      actorTokenId?: string;
      store?: "object" | "pg";
      expectPackageName?: string;
      owner?: { orgId: string };
    } = {},
  ): Promise<PackageReview> {
    if (opts.owner !== undefined && actor === null) {
      throw new Error("an org upload has an actor");
    }
    const maxBytes = this.config.get().packages.maxBytes;
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
    const declared = this.registry.declared().get(m.name);
    if (declared === "config") {
      throw new ApiError(
        "extension.config_declared",
        `Extension ${m.name} is declared in the startup config (extensions); remove it there before installing it as a package`,
      );
    }
    const installed = await this.db
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

    // 写包之前在锁内复核发起人仍是超级管理员（守卫读到的身份可能已过期）；审计在写完后同样复核
    if (actor !== null) await this.authorize(actor, opts.owner);
    await this.blobs.put(pkg, bytes, {
      source: src.source,
      ref: src.ref,
      actor,
      ...(opts.store !== undefined && { store: opts.store }),
    });
    await this.auditUpload(
      actor,
      opts.actorTokenId,
      {
        name: m.name,
        version: m.version,
        sha256: pkg.sha256,
        source: src.source,
        ...(opts.owner !== undefined && { orgId: opts.owner.orgId }),
      },
      opts.owner,
    );

    const set = permissionSetOfPackage(pkg);
    const snapshot = (await this.approvals.all()).get(m.name);
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

  /**
   * The super admin re-check under its lock, in a transaction of its own (`requires_new`, as
   * before the conversion): the package write that follows never runs inside a caller's
   * transaction holding the lock.
   */
  @Transactional({ propagation: "requires_new" })
  private async authorize(actor: string, owner?: { orgId: string }): Promise<void> {
    await this.authorizeIn(actor, owner);
  }

  /** The super admin, or for an org upload the owner org's admin, re-checked under its lock. */
  @Transactional({ propagation: "mandatory" })
  private async authorizeIn(actor: string, owner: { orgId: string } | undefined): Promise<void> {
    if (owner !== undefined)
      await this.orgLock.lockAndAuthorize(owner.orgId, actor, "catalog.upload");
    else await this.adminLock.lockAndAuthorize(actor);
  }

  /**
   * The `extension.package_uploaded` audit, re-checking the actor under the lock, committed on its
   * own (`requires_new`): the stored package it records is not rolled back by a caller either.
   */
  @Transactional({ propagation: "requires_new" })
  private async auditUpload(
    actor: string | null,
    actorTokenId: string | undefined,
    detail: {
      name: string;
      version: string;
      sha256: string;
      source: IngestSource["source"];
      orgId?: string;
    },
    owner?: { orgId: string },
  ): Promise<void> {
    if (actor !== null) await this.authorizeIn(actor, owner);
    await audit(this.db.db, {
      ...(actor !== null && { actorAccountId: actor }),
      ...(actorTokenId !== undefined && { actorTokenId }),
      action: "extension.package_uploaded",
      target: detail.name,
      detail,
    });
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
   * over `packages.maxBytes` -> `extension.package_too_large`. Platform catalog npm imports use it
   * too.
   */
  async fetchNpm(
    input: { package: string; version?: string },
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; version: string; integrity: string }> {
    const c = this.config.get();
    const cfg: NpmFetchConfig = {
      registry: c.packages.npmRegistry,
      maxBytes: c.packages.maxBytes,
      net: marketplaceNetPolicy(c),
      ...(c.packages.npmToken !== undefined && { token: c.packages.npmToken }),
    };
    const timeout = AbortSignal.timeout(NPM_TIMEOUT_MS);
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

  /**
   * The npm provenance of `name@version` from the configured registry (spec §5.5; display only,
   * see packages/provenance.ts): bounded to {@link PROVENANCE_TIMEOUT_MS} and never throws, a
   * failure is `{ checked: false, reason }`. `integrity` ties the statement to the tarball.
   */
  fetchProvenance(
    input: { package: string; version: string; integrity?: string },
    signal?: AbortSignal,
  ): Promise<ProvenanceResult> {
    const c = this.config.get();
    const cfg: NpmFetchConfig = {
      registry: c.packages.npmRegistry,
      maxBytes: c.packages.maxBytes,
      net: marketplaceNetPolicy(c),
      ...(c.packages.npmToken !== undefined && { token: c.packages.npmToken }),
    };
    const timeout = AbortSignal.timeout(PROVENANCE_TIMEOUT_MS);
    return fetchProvenance(
      cfg,
      input.package,
      input.version,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
      input.integrity !== undefined ? { integrity: input.integrity } : {},
    );
  }

  private async fetchVerified(
    input: { package: string; version: string; integrity: string; tarball?: string },
    signal: AbortSignal | undefined,
    codes: { mismatch: ErrorCode; failed: ErrorCode; against: string },
  ): Promise<{ bytes: Uint8Array; version: string; integrity: string }> {
    const c = this.config.get();
    const cfg: NpmFetchConfig = {
      registry: c.packages.npmRegistry,
      maxBytes: c.packages.maxBytes,
      net: marketplaceNetPolicy(c),
      ...(c.packages.npmToken !== undefined && { token: c.packages.npmToken }),
    };
    const timeout = AbortSignal.timeout(NPM_TIMEOUT_MS);
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
    const rows = await this.db
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
      required: r.required,
      migratedSha: r.migrated_sha,
      installedBy: r.installed_by,
      installedAt: r.installed_at.toISOString(),
      updatedBy: r.updated_by,
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  /**
   * Install records desired enabled, with their reviewed extension sections, the earliest enabled
   * first (`enabled_at`, then the install time, then the name): of two enabled providers of a
   * single-provider extension point the first one in this order is the one every replica loads.
   */
  async desired(): Promise<DesiredExtension[]> {
    const rows = await this.db
      .selectFrom("extension_installs")
      .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
      .select([
        "extension_installs.name",
        "extension_installs.sha256",
        "extension_installs.version",
        "extension_installs.source",
        "extension_installs.migrated_sha",
        "extension_packages.section",
        "extension_packages.blob_store",
      ])
      .where("extension_installs.desired_state", "=", "enabled")
      .orderBy(sql`extension_installs.enabled_at ASC NULLS LAST`)
      .orderBy("extension_installs.installed_at")
      .orderBy("extension_installs.name")
      .execute();
    return rows.map((r) => ({
      name: r.name,
      sha256: r.sha256,
      version: r.version,
      source: r.source,
      migratedSha: r.migrated_sha,
      blobStore: r.blob_store,
      section: r.section as PluginExtensionSection,
    }));
  }
}
