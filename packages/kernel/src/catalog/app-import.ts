import { createHash, randomUUID } from "node:crypto";
import {
  APP_MANIFEST_FILE,
  type AppManifest,
  type AppPackageSection,
  type Connector,
  type ConnectorTemplateSpec,
  type Logger,
  parseAppManifest,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import semver from "semver";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionAdminOps } from "../extensions/admin-ops.js";
import { writeSnapshot } from "../extensions/approvals.js";
import type { ExtensionInstalls } from "../extensions/installs.js";
import { unrunMigrations } from "../extensions/migrate-lock.js";
import {
  type ExtensionPackage,
  ExtensionPackageError,
  permissionSetOfPackage,
  readExtensionPackage,
} from "../extensions/package.js";
import {
  diffPermissions,
  type PermissionSet,
  permissionKeys,
  WARNINGS_KEY_PREFIX,
} from "../extensions/permission-set.js";
import {
  migrationWarnings,
  type PackageWarning,
  type PermissionGroup,
  type PermissionItem,
  permissionGroups,
  permissionKeyItems,
  reviewHash as pluginReviewHash,
} from "../extensions/permission-view.js";
import type { ExtensionSource } from "../extensions/sources.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { checkSkillFiles, SkillArchiveError, type SkillPackageFile } from "../skills/package.js";
import type { StorageService } from "../storage/storage.service.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import {
  iconProblem,
  toFile,
  type UnpackedCatalogArchive,
  unpackCatalogArchive,
} from "./archive.js";
import {
  type ActorOpts,
  assertPluginNameOwner,
  type CatalogItemView,
  catalogObjectPrefix,
  itemView,
  precheckCatalogImport,
  putCatalogFiles,
  templateProblems,
  writeCatalogVersion,
} from "./catalog.service.js";
import { disabledPluginItems, pluginItemDisabled } from "./requests.service.js";

/**
 * Enterprise import of an app bundle (`app.yaml`, D17 / C31): one review, one approval.
 *
 * **Where the plugin packages come from**: an app bundle carries no plugin tgz; `app.yaml` references
 * plugins by npm name + lock (exact version + sha512). prepare fetches each `lock.version` from the
 * configured npm registry and verifies it against `lock.integrity` (`app.lock_mismatch`), never npm
 * metadata. So the bundle stays small, the plugin packages are exactly the same as when installed on
 * their own (content-addressed, same sha256), and the supply chain rests on the sha512 the app author
 * locked; the cost is that importing needs access to an npm registry (**offline deployments must
 * configure an npm mirror / private registry** `packages.npmRegistry`, otherwise app imports are not
 * available). The total bytes of one import (the bundle + every plugin package, all in memory during
 * validation) are limited by `directory.maxBundleBytes` (default 4 × `packages.maxBytes`); over it ->
 * 413 `app.bundle_too_large`.
 *
 * prepare: the bundle is always treated as hostile input, and **nothing is written until every
 * component passes** (F-AD): unpacking (the same limits as catalog packages), `app.yaml` (SDK
 * `parseAppManifest`), version consistent with package.json, the icon, each skill directory by the
 * skill package rules, connector templates (checked against the connector plugin's `endpointSchema`
 * when it is loaded on this replica, otherwise static rules only; org install in T26 checks again
 * against the connector of the moment), each plugin's deployment state (builtin / config-declared
 * outside the range -> `app.plugin_conflict`; name ownership) and the download check (all downloads
 * kept in memory, each package read to check name, version and npm name), downgrade to a version with
 * unrun migrations (`extension.downgrade_unsupported`) all happen before writing; only then are the
 * plugins handed to `ExtensionInstalls.ingest` (source `catalog`), app.yaml, the icon and skill files
 * written to object storage, a staging row written (24 hours) and `catalog.app_staged` audited.
 * Builtin / config-declared plugins are only validated, not stored (their sha256 in `resolved` is the
 * locked npm package, not in the package store).
 *
 * confirm: `reviewHash` must match the staging; in one transaction it deletes the staging row (confirm
 * works once), locks by plugin name and recomputes against the deployment state of the moment
 * (a plugin installed / upgraded / swapped after the review -> `app.review_stale`), re-checks
 * downgrades, writes snapshots for plugins whose action is install (source web, audit
 * `extension.permissions_approved` carrying `app`), with `deployPlugins` also for upgrade plugins
 * (not without deploying: a snapshot must match the version actually running, F-O), and creates /
 * adds the kind app catalog version (`resolved = { plugins: [{ name, sha256, range, optional }] }`;
 * the files stay under the staging prefix and the version row takes them over). After the commit,
 * with `deployPlugins`, it first runs `ExtensionAdminOps.install` for all, then `enable` for all
 * (each replica reconciles, no restart); failures are not thrown but returned one by one, and an
 * upgrade that was not installed gets its old snapshot back (see `deploy`).
 *
 * Expired staging is cleaned by the maintenance job `app-staging-cleanup`
 * ({@link AppImport.cleanupExpired}): it deletes the staging row and its object prefix; stored
 * extension packages stay in the content-addressed `extension_packages` (the same as importing the
 * same tgz again; without an install record referencing them they are never loaded).
 */

/** 暂存保留时长。 */
export const APP_STAGING_TTL_MS = 24 * 3600_000;
/** 同时下载的插件包数。 */
const FETCH_CONCURRENCY = 4;
/** 一次清理的暂存行数上限。 */
const CLEANUP_BATCH = 100;

/** 审阅里的一个插件。 */
export interface AppReviewPlugin {
  name: string;
  npm: string;
  /** app.yaml 里的版本范围。 */
  range: string;
  lockVersion: string;
  /** 锁定的 tgz 的 sha256（包存储的键）。 */
  sha256: string;
  /** install：部署上没有；upgrade：已装但不满足范围，按 lock 版本换；keep：已装且满足范围（或内置 / 配置声明），不动。 */
  action: "install" | "upgrade" | "keep";
  /** 部署上当前的版本（没有为 null）。 */
  currentVersion: string | null;
  /** 部署上当前安装的包（经安装记录装的才有；内置 / 配置声明与未装为 null）。 */
  currentSha256: string | null;
  optional: boolean;
  /** 锁定版本的权限（按静态清单与迁移 SQL，不执行插件代码）。 */
  permissions: PermissionGroup[];
  /** 相对当前快照多出 / 少了的权限键（没有快照时全部算新增）。 */
  added: string[];
  addedItems: PermissionItem[];
  removed: string[];
  /** 迁移 SQL 的审阅警告（敏感）。 */
  warnings: PackageWarning[];
  /** 该插件的审阅摘要（与单独上传该包时相同）。 */
  reviewHash: string;
  /** 有敏感权限或迁移警告。 */
  sensitive: boolean;
}

/** 应用包的审阅（企业管理员一次看完全部插件权限、敏感项与迁移警告）。 */
export interface AppReview {
  name: string;
  version: string;
  publisher: string;
  description: string;
  plugins: AppReviewPlugin[];
  connectorTemplates: {
    id: string;
    plugin: string;
    connector: string;
    endpoint: Record<string, unknown>;
    auth: Record<string, unknown>;
    editableEndpoint: string[];
    /** 连接器插件在本副本已加载、端点已按其 schema 校验过。 */
    endpointChecked: boolean;
  }[];
  skills: { name: string; description: string; path: string; files: number }[];
  /** 任一插件敏感。 */
  sensitive: boolean;
  /** 各插件（名字、sha256、action、当前版本、reviewHash）与模板、技能清单的总摘要；确认时回传。 */
  reviewHash: string;
}

/** `deployPlugins` 时每个插件的部署结果。 */
export interface AppDeployResult {
  name: string;
  action: "install" | "upgrade";
  version: string;
  /** 要装的包（失败时按它经插件后台手动重试）。 */
  sha256: string;
  /** enabled：装上并启用；installed：只在过程中出现（启用前）；failed：见 code / message。 */
  result: "installed" | "enabled" | "failed";
  code?: string;
  message?: string;
  /** 补充说明（如 upgrade 失败后快照已被别人改过、没有恢复：`snapshot_not_restored: …`）。 */
  note?: string;
}

/** {@link AppImport.confirm} 的结果：已提交的条目，以及（`deployPlugins` 时）每个插件的部署结果。 */
export interface AppConfirmResult {
  item: CatalogItemView;
  deploy: AppDeployResult[] | null;
}

/** 确认时被覆盖的快照（部署失败时恢复）。 */
interface PreviousSnapshot {
  version: string;
  permissions: PermissionSet;
  approvedBy: string | null;
  approvedAt: Date;
  source: "auto" | "web" | "cli";
}

/** 暂存来源。 */
interface StagingSource {
  kind: "file" | "npm" | "marketplace";
  ref: string;
  integrity?: string;
  marketplaceId?: string;
}

/** 暂存时记下、确认时要用的解析结果。 */
interface StagedBundle {
  itemId: string;
  packageName: string;
  version: string;
  size: number;
  section: AppPackageSection;
  manifest: AppManifest;
  files: { path: string; size: number; sha256: string }[];
}

/**
 * The source of a prepare (HTTP only passes file / npm; CatalogService adds the marketplace for a
 * marketplace import).
 */
export interface AppPrepareSource {
  kind: "file" | "npm" | "marketplace";
  ref: string;
  integrity?: string;
  /** npm：包里的 package.json name 必须是请求的包。 */
  expectPackageName?: string;
  /**
   * Marketplace import: the app's name must be the entry's name (else
   * `marketplace.package_mismatch`); the item records its marketplace.
   */
  marketplace?: { sourceId: string; name: string };
}

export interface AppImportDeps {
  db: KernelDb;
  config: () => KernelConfig;
  storage: StorageService;
  installs: Pick<ExtensionInstalls, "ingest" | "fetchNpm" | "fetchLocked">;
  ops: Pick<ExtensionAdminOps, "install" | "enable">;
  /** 读包存储里的包（确认时重算权限集合）。 */
  blobs: { get(sha256: string): Promise<Uint8Array> };
  /** 内置与配置声明的插件（名字、来源、版本）。 */
  declaredPlugins: () => readonly { name: string; source: ExtensionSource; version: string }[];
  /** 本副本已加载的连接器：插件 `plugin` 提供的 `Connector.kind === kind`。 */
  findConnector: (plugin: string, kind: string) => Connector | undefined;
  /** 本副本已加载、提供 `connector@1` 的插件名（模板可以引用不在应用里的它们）。 */
  isConnectorPlugin: (name: string) => boolean;
  log: Pick<Logger, "info" | "warn" | "error">;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () =>
  new ApiError(
    "app.staging_not_found",
    "This app import was not found or has expired (staged imports are kept for 24 hours); prepare it again",
  );
const invalid = (problems: string[]) =>
  new ApiError(
    "app.invalid_manifest",
    `Invalid app package: ${problems[0] ?? "unknown problem"}`,
    problems.slice(0, 50),
  );

/** 一次应用包导入的总字节上限：`directory.maxBundleBytes`，缺省 4 × `packages.maxBytes`。 */
export const maxBundleBytes = (c: KernelConfig): number =>
  c.directory.maxBundleBytes ?? 4 * c.packages.maxBytes;
const bundleTooLarge = (cap: number) =>
  new ApiError(
    "app.bundle_too_large",
    `The app package and the plugin packages it locks are larger than ${cap} bytes in total (directory.maxBundleBytes)`,
  );

const satisfies = (version: string, range: string) =>
  semver.satisfies(version, range, { includePrerelease: true });

type Trx = Transaction<KernelDatabase>;

/** 部署上一个插件的现状。 */
type PluginState =
  | { kind: "declared"; source: ExtensionSource; version: string }
  | { kind: "installed"; version: string; sha256: string; packageName: string }
  | { kind: "absent" };

export class AppImport {
  constructor(private readonly d: AppImportDeps) {}

  /** 解析、校验整个应用包并暂存（见文件头）。返回暂存 id 与审阅。 */
  async prepare(
    actor: string,
    bytes: Uint8Array,
    source: AppPrepareSource,
    opts: ActorOpts = {},
  ): Promise<{ stagingId: string; review: AppReview; permissionKeys: string[] }> {
    const maxBytes = this.d.config().packages.maxBytes;
    if (bytes.byteLength > maxBundleBytes(this.d.config())) {
      throw bundleTooLarge(maxBundleBytes(this.d.config()));
    }
    const u = await unpackCatalogArchive(bytes, maxBytes);
    if (u.section.kind !== "app") {
      throw new ApiError(
        "catalog.wrong_kind",
        `This is a ${u.section.kind} package, not an app; import it with POST /api/v1/admin/directory/import/file`,
      );
    }
    const section = u.section;
    const packageName = String(u.packageJson.name);
    const version = String(u.packageJson.version);
    if (source.expectPackageName !== undefined && packageName !== source.expectPackageName) {
      throw invalid([
        `package.json name "${packageName}" does not match the requested npm package ${source.expectPackageName}`,
      ]);
    }

    // 1. 全部校验（不写任何东西）
    const manifest = this.readManifest(u, version);
    if (source.marketplace && manifest.name !== source.marketplace.name) {
      throw new ApiError(
        "marketplace.package_mismatch",
        `The downloaded package does not match the marketplace entry: the app is named "${manifest.name}", the entry says ${source.marketplace.name}`,
      );
    }
    const content = this.checkContent(u, manifest);
    const existing = await precheckCatalogImport(
      this.d.db,
      "app",
      manifest.name,
      packageName,
      version,
    );
    const states = await this.pluginStates(manifest);
    // 插件自己的目录条目被禁用：导入含它的应用也没有意义（组织装不上，裁决 M-5），审阅时就拒绝
    const killed = await disabledPluginItems(
      this.d.db,
      manifest.plugins.map((p) => p.name),
    );
    if (killed.length > 0) throw pluginItemDisabled(killed);
    const fetched = await this.fetchPlugins(manifest, bytes.byteLength);
    this.d.storage.assertAvailable();
    const reviewPlugins = await this.reviewPlugins(manifest, states, fetched);
    // 降级（lock 版本低于已装版本）且目标版本有没执行过的迁移：装到部署必然失败，导入时就拒绝
    for (const [i, p] of reviewPlugins.entries()) {
      const pkg = (fetched[i] as { pkg: ExtensionPackage }).pkg;
      await assertDowngradable(this.d.db, p, pkg.migrationSql);
    }
    const review: AppReview = {
      name: manifest.name,
      version,
      publisher: manifest.publisher,
      description: manifest.description,
      plugins: reviewPlugins,
      connectorTemplates: content.templates,
      skills: content.skills,
      sensitive: reviewPlugins.some((p) => p.sensitive),
      reviewHash: "",
    };
    review.reviewHash = appReviewHash(review, content.files);
    // 写之前在锁内复核发起人仍是企业管理员
    await this.d.db.transaction().execute((trx) => lockEnterpriseAdminsAndAuthorize(trx, actor));

    // 2. 写：插件入库（内置 / 配置声明的只校验）、文件进对象存储、暂存行
    const stagingId = randomUUID();
    const itemId = existing?.id ?? randomUUID();
    const pluginRef =
      source.kind === "marketplace" && source.marketplace
        ? `catalog:${source.marketplace.sourceId}:${packageName}@${version}`
        : `${itemId}@${version}`;
    for (const [i, p] of manifest.plugins.entries()) {
      if (states[i]?.kind === "declared") continue;
      const got = fetched[i] as { bytes: Uint8Array };
      await this.d.installs.ingest(
        actor,
        got.bytes,
        { source: "catalog", ref: pluginRef },
        {
          expectPackageName: p.npm,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        },
      );
    }
    const objectPrefix = catalogObjectPrefix(itemId, version, stagingId);
    await putCatalogFiles(this.d.storage, objectPrefix, content.files);
    const staged: StagedBundle = {
      itemId,
      packageName,
      version,
      size: bytes.byteLength,
      section,
      manifest,
      files: content.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    };
    const src: StagingSource = {
      kind: source.kind,
      ref: source.ref,
      ...(source.integrity !== undefined && { integrity: source.integrity }),
      ...(source.marketplace && { marketplaceId: source.marketplace.sourceId }),
    };
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      await trx
        .insertInto("app_import_staging")
        .values({
          id: stagingId,
          review: JSON.stringify(review),
          bundle: JSON.stringify(staged),
          object_prefix: objectPrefix,
          source: JSON.stringify(src),
          created_by: actor,
          expires_at: new Date(Date.now() + APP_STAGING_TTL_MS),
        })
        .execute();
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "catalog.app_staged",
        target: stagingId,
        detail: {
          stagingId,
          name: manifest.name,
          version,
          source: src.kind,
          sourceRef: src.ref,
          ...(src.integrity !== undefined && { integrity: src.integrity }),
          ...(src.marketplaceId !== undefined && { marketplaceId: src.marketplaceId }),
          reviewHash: review.reviewHash,
          plugins: reviewPlugins.map((p) => ({
            name: p.name,
            version: p.lockVersion,
            sha256: p.sha256,
            action: p.action,
          })),
        },
      });
    });
    const keys = new Set<string>();
    for (const f of fetched) {
      for (const k of permissionKeys(permissionSetOfPackage(f.pkg))) {
        if (!k.startsWith(WARNINGS_KEY_PREFIX)) keys.add(k);
      }
    }
    return { stagingId, review, permissionKeys: [...keys].sort() };
  }

  /** 从配置的 npm registry 拉取应用包（按 `dist.integrity` 校验）再 prepare。 */
  async prepareNpm(
    actor: string,
    input: { package: string; version?: string },
    opts: ActorOpts = {},
  ): Promise<{ stagingId: string; review: AppReview }> {
    const got = await this.d.installs.fetchNpm(input);
    const r = await this.prepare(
      actor,
      got.bytes,
      {
        kind: "npm",
        ref: `${input.package}@${got.version}`,
        integrity: got.integrity,
        expectPackageName: input.package,
      },
      opts,
    );
    return { stagingId: r.stagingId, review: r.review };
  }

  /**
   * 确认导入（见文件头）。返回已提交的目录条目，`deployPlugins` 时另有每个插件的部署结果（部署失败不抛错，见
   * {@link AppDeployResult}）。
   */
  async confirm(
    actor: string,
    stagingId: string,
    input: { reviewHash: string; deployPlugins: boolean },
    opts: ActorOpts = {},
  ): Promise<AppConfirmResult> {
    if (!UUID_RE.test(stagingId)) throw notFound();
    const row = await this.d.db
      .selectFrom("app_import_staging")
      .selectAll()
      .where("id", "=", stagingId)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) throw notFound();
    const review = row.review as AppReview;
    const staged = row.bundle as StagedBundle;
    const src = row.source as StagingSource;
    const stale = () =>
      new ApiError(
        "app.review_stale",
        `The review of app ${review.name} ${review.version} is out of date (it changed, or plugins on this deployment changed since it was prepared); review it again`,
      );
    if (input.reviewHash !== review.reviewHash) throw stale();
    // 事务外先读包：审阅时不是 keep 的插件都读（事务里按此刻重算的 action 取用；action 变了就是 stale）
    const stored = new Map<string, ExtensionPackage>();
    for (const p of review.plugins) {
      if (p.action !== "keep") stored.set(p.name, await this.readStored(p.sha256));
    }

    const committed = await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const used = await trx
        .deleteFrom("app_import_staging")
        .where("id", "=", stagingId)
        .where("expires_at", ">", sql<Date>`now()`)
        .returning("id")
        .executeTakeFirst();
      if (!used) throw notFound();
      // The same per-name advisory lock as ExtensionAdminOps.install (names sorted against deadlocks); under it the action is recomputed from the current deployment state:
      // 审阅之后插件被装 / 升级 / 换包 / 改了配置声明，都要重新审阅
      for (const name of review.plugins.map((p) => p.name).sort()) {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-install:${name}`}))`.execute(
          trx,
        );
      }
      const states = await this.pluginStates(staged.manifest, trx);
      const now: AppReviewPlugin[] = review.plugins.map((p, i) => ({
        ...p,
        ...actionOf(states[i] as PluginState, p.range, p.name),
      }));
      if (appReviewHash({ ...review, plugins: now }, staged.files) !== review.reviewHash) {
        throw stale();
      }
      // 可预见的部署失败（降级到有未执行迁移的版本）在写任何东西之前拒绝
      if (input.deployPlugins) {
        for (const p of now) {
          if (p.action !== "upgrade") continue;
          await assertDowngradable(trx, p, (stored.get(p.name) as ExtensionPackage).migrationSql);
        }
      }
      const approve = now.filter(
        (p) => p.action === "install" || (p.action === "upgrade" && input.deployPlugins),
      );
      const previous = new Map<string, PreviousSnapshot | null>();
      for (const p of approve) {
        const set = permissionSetOfPackage(stored.get(p.name) as ExtensionPackage);
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-approve:${p.name}`}))`.execute(
          trx,
        );
        const snapRow = await trx
          .selectFrom("extension_permission_snapshots")
          .selectAll()
          .where("plugin", "=", p.name)
          .forUpdate()
          .executeTakeFirst();
        previous.set(
          p.name,
          snapRow
            ? {
                version: snapRow.version,
                permissions: snapRow.permissions as PermissionSet,
                approvedBy: snapRow.approved_by,
                approvedAt: snapRow.approved_at,
                source: snapRow.source,
              }
            : null,
        );
        // The snapshot belongs to the extension name: register the name owner first, like ExtensionAdminOps.install (Ruling P3); otherwise a later install would hit "the name has leftover data
        // 却没有归属」会被拒绝
        await trx
          .insertInto("extension_name_owners")
          .values({ name: p.name, package_name: p.npm })
          .onConflict((oc) => oc.column("name").doNothing())
          .execute();
        await assertPluginNameOwner(trx, p.name, p.npm);
        const { added, removed } = diffPermissions(
          snapRow?.permissions as PermissionSet | undefined,
          set,
        );
        await writeSnapshot(trx, p.name, p.lockVersion, set, {
          source: "web",
          approvedBy: actor,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          audit: {
            added,
            removed,
            sha256: p.sha256,
            app: { name: review.name, version: review.version },
          },
        });
      }
      const m = staged.manifest;
      const itemId = await writeCatalogVersion(trx, {
        actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        kind: "app",
        name: m.name,
        packageName: staged.packageName,
        version: staged.version,
        section: staged.section,
        listing: {
          publisher: m.publisher,
          description: m.description,
          displayName: m.displayName ?? null,
        },
        newItemId: staged.itemId,
        source: {
          source: src.kind,
          ref: src.ref,
          ...(src.integrity !== undefined && { integrity: src.integrity }),
        },
        ...(src.marketplaceId !== undefined && { marketplaceId: src.marketplaceId }),
        objectPrefix: row.object_prefix,
        pluginSha256: null,
        files: staged.files,
        size: staged.size,
        // 列表与安装按同一份数据判定（M-13）：带上范围与是否可选
        resolved: {
          plugins: now.map((p) => ({
            name: p.name,
            sha256: p.sha256,
            range: p.range,
            optional: p.optional,
          })),
        },
        auditDetail: {
          stagingId,
          deployPlugins: input.deployPlugins,
          plugins: now.map((p) => ({ name: p.name, version: p.lockVersion, action: p.action })),
        },
      });
      // 应用带进部署（install / upgrade）的插件登记来源条目：组织直接启用时也按应用条目策略判定（C22）
      for (const p of now) {
        if (p.action !== "install" && p.action !== "upgrade") continue;
        await trx
          .insertInto("extension_catalog_sources")
          .values({ plugin: p.name, item_id: itemId })
          .onConflict((oc) => oc.columns(["plugin", "item_id"]).doNothing())
          .execute();
      }
      return { itemId, now, previous };
    });

    const deploy = input.deployPlugins
      ? await this.deploy(actor, review, committed.itemId, committed.now, committed.previous, opts)
      : null;
    return { item: await this.itemView(committed.itemId), deploy };
  }

  /**
   * Deploys after the commit: first `install` for all (a new install is disabled, a version change
   * keeps the desired state), then `enable` for every installed one (`requires` order does not
   * matter). One plugin failing does not affect the others and nothing is thrown; each result is
   * recorded, and what got installed stays installed. When an upgrade plugin was not installed, the
   * snapshot overwritten at confirm is restored (the old version keeps running, F-O; audit
   * `extension.permissions_restored`).
   * Retry through the extension admin (the package is already in the package store): an install
   * keeps the snapshot written at confirm, so `POST /api/v1/admin/plugins/:name/install {sha256}` with
   * the sha256 from the result, then `…/enable`; an upgrade whose snapshot was restored to the old
   * version needs `…/approve` after install, then `…/enable`.
   */
  private async deploy(
    actor: string,
    review: AppReview,
    itemId: string,
    plugins: AppReviewPlugin[],
    previous: Map<string, PreviousSnapshot | null>,
    opts: ActorOpts,
  ): Promise<AppDeployResult[]> {
    const results: AppDeployResult[] = [];
    const failure = (e: unknown) =>
      e instanceof ApiError
        ? { code: e.code as string, message: e.message }
        : { code: "internal", message: "Internal error" };
    for (const p of plugins) {
      if (p.action === "keep") continue;
      const base = {
        name: p.name,
        action: p.action,
        version: p.lockVersion,
        sha256: p.sha256,
      };
      try {
        await this.d.ops.install(p.name, p.sha256, actor, opts.actorTokenId, {
          catalogItemId: itemId,
        });
        results.push({ ...base, result: "installed" });
      } catch (e) {
        this.d.log.warn("installing an app plugin to the deployment failed", {
          app: review.name,
          plugin: p.name,
          err: e,
        });
        results.push({ ...base, result: "failed", ...failure(e) });
        if (p.action === "upgrade" && previous.has(p.name)) {
          try {
            const restored = await this.restoreSnapshot(
              actor,
              review,
              p,
              previous.get(p.name) ?? null,
              opts,
            );
            if (!restored) {
              (results.at(-1) as AppDeployResult).note =
                "snapshot_not_restored: the permission approval changed after the import was confirmed, so it was left as it is";
            }
          } catch (err) {
            this.d.log.error("cannot restore the permission snapshot of an app plugin", {
              plugin: p.name,
              err,
            });
          }
        }
      }
    }
    for (const r of results) {
      if (r.result !== "installed") continue;
      try {
        await this.d.ops.enable(r.name, actor, opts.actorTokenId);
        r.result = "enabled";
      } catch (e) {
        this.d.log.warn("enabling an app plugin failed", { plugin: r.name, err: e });
        Object.assign(r, { result: "failed" }, failure(e));
      }
    }
    return results;
  }

  /**
   * Restores the snapshot overwritten at confirm (deletes it when there was none before), audits
   * `extension.permissions_restored`. Compare-and-write (row locked): restores only while the snapshot
   * is still the one written at confirm (lock version, approved by this actor); if someone approved
   * or changed it meanwhile it is left alone and false is returned.
   */
  private async restoreSnapshot(
    actor: string,
    review: AppReview,
    p: AppReviewPlugin,
    prev: PreviousSnapshot | null,
    opts: ActorOpts,
  ): Promise<boolean> {
    return this.d.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-approve:${p.name}`}))`.execute(
        trx,
      );
      const current = await trx
        .selectFrom("extension_permission_snapshots")
        .select(["version", "approved_by"])
        .where("plugin", "=", p.name)
        .forUpdate()
        .executeTakeFirst();
      if (current?.version !== p.lockVersion || current.approved_by !== actor) return false;
      if (prev) {
        await trx
          .updateTable("extension_permission_snapshots")
          .set({
            version: prev.version,
            permissions: JSON.stringify(prev.permissions),
            approved_by: prev.approvedBy,
            approved_at: prev.approvedAt,
            source: prev.source,
          })
          .where("plugin", "=", p.name)
          .execute();
      } else {
        await trx
          .deleteFrom("extension_permission_snapshots")
          .where("plugin", "=", p.name)
          .execute();
      }
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "extension.permissions_restored",
        target: p.name,
        detail: {
          plugin: p.name,
          restoredVersion: prev?.version ?? null,
          reason: "app_deploy_failed",
          app: { name: review.name, version: review.version },
        },
      });
      return true;
    });
  }

  /**
   * 删除过期的暂存行与其对象前缀（维护任务 `app-staging-cleanup`）。逐行处理：先删对象再删行（删对象失败时行留着，
   * 下一轮重试）；多副本并发时 `SKIP LOCKED` 互不等待。返回删除的行数。
   */
  async cleanupExpired(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.d.db
        .selectFrom("app_import_staging")
        .select(["id", "object_prefix"])
        .where("expires_at", "<=", sql<Date>`now()`)
        .orderBy("expires_at")
        .limit(CLEANUP_BATCH)
        .execute();
      if (batch.length === 0) return total;
      let progressed = 0;
      for (const r of batch) {
        try {
          const done = await this.d.db.transaction().execute(async (trx) => {
            const locked = await trx
              .selectFrom("app_import_staging")
              .select("id")
              .where("id", "=", r.id)
              .where("expires_at", "<=", sql<Date>`now()`)
              .forUpdate()
              .skipLocked()
              .executeTakeFirst();
            if (!locked) return false;
            if (r.object_prefix) await this.d.storage.deployment().deletePrefix(r.object_prefix);
            await trx.deleteFrom("app_import_staging").where("id", "=", r.id).execute();
            return true;
          });
          if (done) {
            total++;
            progressed++;
          }
        } catch (err) {
          this.d.log.warn("cannot clean up an expired app import", { stagingId: r.id, err });
        }
      }
      if (progressed === 0 || batch.length < CLEANUP_BATCH) return total;
    }
  }

  // ---------------------------------------------------------------------------------------------

  /** 读出并校验 app.yaml（版本须与 package.json 一致）。 */
  private readManifest(u: UnpackedCatalogArchive, version: string): AppManifest {
    const f = u.files.find((x) => x.path === APP_MANIFEST_FILE);
    if (!f) throw invalid([`${APP_MANIFEST_FILE} not found in the package`]);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(f.data);
    } catch {
      throw invalid([`${APP_MANIFEST_FILE} is not valid UTF-8 text`]);
    }
    const m = parseAppManifest(text, {
      isKnownConnectorPlugin: (name) => this.d.isConnectorPlugin(name),
    });
    if ("errors" in m) throw invalid(m.errors.map((e) => `${APP_MANIFEST_FILE}: ${e}`));
    if (m.version !== version) {
      throw invalid([
        `${APP_MANIFEST_FILE}: version ${m.version} does not match package.json version ${version}`,
      ]);
    }
    return m;
  }

  /** 图标、技能目录、连接器模板；返回要存的文件与审阅里的模板 / 技能。 */
  private checkContent(
    u: UnpackedCatalogArchive,
    m: AppManifest,
  ): {
    files: SkillPackageFile[];
    templates: AppReview["connectorTemplates"];
    skills: AppReview["skills"];
  } {
    const problems: string[] = [];
    const byPath = new Map(u.files.map((f) => [f.path, f]));
    const stored = new Map<string, SkillPackageFile>();
    const keep = (f: { path: string; data: Uint8Array }) => {
      if (!stored.has(f.path)) stored.set(f.path, toFile(f));
    };
    keep(byPath.get(APP_MANIFEST_FILE) as { path: string; data: Uint8Array });
    const icon = (path: string, at: string) => {
      const f = byPath.get(path);
      if (!f) {
        problems.push(`${at} ${path} not found in the package`);
        return;
      }
      const p = iconProblem(path, f.data);
      if (p) problems.push(`${at}: ${p}`);
      else keep(f);
    };
    if (m.icon !== undefined) icon(m.icon, "icon");

    const listed = new Set(m.plugins.map((p) => p.name));
    const templates: AppReview["connectorTemplates"] = m.connectorTemplates.map((c, i) => {
      const at = `connectorTemplates.${i}.template`;
      const t: ConnectorTemplateSpec = c.template;
      if (t.icon !== undefined) icon(t.icon, `${at}.icon`);
      // 校验结果取决于处理本次请求的副本此刻加载了哪些连接器（多副本收敛期间可能不同）：这里只是导入时的把关，
      // 不是最终结论——组织安装时（T26）按当时加载的连接器对合并后的端点重新校验；`endpointChecked` 记下这次是否校验过
      const loaded = this.d.findConnector(t.plugin, t.connector);
      if (loaded) {
        problems.push(...templateProblems(loaded, t, at));
      } else if (!listed.has(t.plugin)) {
        // 不在应用里的连接器插件：必须已加载且提供这个 kind
        problems.push(
          `${at}.connector: plugin ${t.plugin} providing connector "${t.connector}" is not loaded in this deployment`,
        );
      } else {
        // 连接器插件随应用安装：端点只做静态检查，组织安装时按当时加载的连接器再校验（T26）
        for (const leak of endpointCredentialIssues(t.endpoint)) {
          problems.push(`${at}.${leak.path}: ${leak.message}`);
        }
      }
      return {
        id: c.id,
        plugin: t.plugin,
        connector: t.connector,
        endpoint: t.endpoint,
        auth: t.auth,
        editableEndpoint: t.editableEndpoint ?? [],
        endpointChecked: loaded !== undefined,
      };
    });

    const skills: AppReview["skills"] = [];
    const names = new Set<string>();
    m.skills.forEach((s, i) => {
      const dir = `${s.path}/`;
      const files = u.files
        .filter((f) => f.path.startsWith(dir))
        .map((f) => toFile({ path: f.path.slice(dir.length), data: f.data }));
      if (files.length === 0) {
        problems.push(`skills.${i}.path: directory ${s.path} not found in the package`);
        return;
      }
      try {
        const r = checkSkillFiles(files);
        if (names.has(r.name)) problems.push(`skills.${i}: duplicate skill name ${r.name}`);
        names.add(r.name);
        skills.push({
          name: r.name,
          description: r.description,
          path: s.path,
          files: files.length,
        });
        for (const f of u.files) if (f.path.startsWith(dir)) keep(f);
      } catch (e) {
        if (!(e instanceof SkillArchiveError)) throw e;
        for (const p of e.problems) problems.push(`skills.${i} (${s.path}): ${p}`);
      }
    });
    if (problems.length > 0) throw invalid(problems);
    return { files: [...stored.values()], templates, skills };
  }

  /** Each plugin's state on the deployment; builtin / config-declared but outside the range -> `app.plugin_conflict`; name owned by another package -> `extension.name_conflict`. */
  private async pluginStates(
    m: AppManifest,
    db: KernelDb | Trx = this.d.db,
  ): Promise<PluginState[]> {
    const declared = new Map(this.d.declaredPlugins().map((p) => [p.name, p]));
    const rows = m.plugins.length
      ? await db
          .selectFrom("extension_installs")
          .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
          .select([
            "extension_installs.name",
            "extension_installs.version",
            "extension_installs.sha256",
            "extension_packages.package_name",
          ])
          .where(
            "extension_installs.name",
            "in",
            m.plugins.map((p) => p.name),
          )
          .execute()
      : [];
    const installed = new Map(rows.map((r) => [r.name, r]));
    const out: PluginState[] = [];
    for (const p of m.plugins) {
      const d = declared.get(p.name);
      if (d) {
        if (!satisfies(d.version, p.version)) {
          throw new ApiError(
            "app.plugin_conflict",
            `Plugin ${p.name} is ${d.source === "builtin" ? "built into this deployment" : "declared in the startup config"} at version ${d.version}, which does not satisfy the app's range ${p.version}`,
          );
        }
        out.push({ kind: "declared", source: d.source, version: d.version });
        continue;
      }
      const r = installed.get(p.name);
      if (r && r.package_name !== p.npm) {
        throw new ApiError(
          "extension.name_conflict",
          `Plugin ${p.name} is already installed from package ${r.package_name}; the app references package ${p.npm}`,
        );
      }
      await assertPluginNameOwner(db, p.name, p.npm);
      out.push(
        r
          ? { kind: "installed", version: r.version, sha256: r.sha256, packageName: r.package_name }
          : { kind: "absent" },
      );
    }
    return out;
  }

  /** 按 lock 下载全部插件并读包校验（只在内存里，F-AD）。 */
  private async fetchPlugins(
    m: AppManifest,
    bundleBytes: number,
  ): Promise<{ bytes: Uint8Array; pkg: ExtensionPackage }[]> {
    const maxBytes = this.d.config().packages.maxBytes;
    const cap = maxBundleBytes(this.d.config());
    let total = bundleBytes;
    const abort = new AbortController();
    const out: { bytes: Uint8Array; pkg: ExtensionPackage }[] = new Array(m.plugins.length);
    const queue = [...m.plugins.entries()];
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          if (abort.signal.aborted) return;
          const [i, p] = next;
          let got: { bytes: Uint8Array };
          try {
            got = await this.d.installs.fetchLocked(
              { package: p.npm, version: p.lock.version, integrity: p.lock.integrity },
              abort.signal,
            );
          } catch (e) {
            abort.abort();
            throw e;
          }
          total += got.bytes.byteLength;
          if (total > cap) {
            // 其余下载随之中止：内存里最多多出正在下载的几个包
            abort.abort();
            throw bundleTooLarge(cap);
          }
          let pkg: ExtensionPackage;
          try {
            pkg = await readExtensionPackage(got.bytes, { maxBytes, hostSdkVersion: SDK_VERSION });
          } catch (e) {
            if (e instanceof ExtensionPackageError) {
              throw new ApiError(
                "extension.package_invalid",
                `Plugin package ${p.npm}@${p.lock.version} referenced by the app is invalid: ${e.message}`,
                e.issues,
              );
            }
            throw e;
          }
          const problems: string[] = [];
          if (pkg.section.manifest.name !== p.name) {
            problems.push(
              `plugins.${i}: package ${p.npm}@${p.lock.version} contains plugin ${pkg.section.manifest.name}, not ${p.name}`,
            );
          }
          if (String(pkg.packageJson.name) !== p.npm) {
            problems.push(
              `plugins.${i}: package.json name of ${p.npm} is "${String(pkg.packageJson.name)}"`,
            );
          }
          if (pkg.section.manifest.version !== p.lock.version) {
            problems.push(
              `plugins.${i}: package ${p.npm}@${p.lock.version} contains plugin version ${pkg.section.manifest.version}`,
            );
          }
          if (problems.length > 0) throw invalid(problems);
          out[i] = { bytes: got.bytes, pkg };
        }
      }),
    );
    return out;
  }

  /** 审阅里的插件：权限、相对当前快照的增减、迁移警告、action。 */
  private async reviewPlugins(
    m: AppManifest,
    states: PluginState[],
    fetched: { pkg: ExtensionPackage }[],
  ): Promise<AppReviewPlugin[]> {
    const snaps = await this.d.db
      .selectFrom("extension_permission_snapshots")
      .select(["plugin", "permissions"])
      .where("plugin", "in", m.plugins.length ? m.plugins.map((p) => p.name) : [""])
      .execute();
    const snapOf = new Map(snaps.map((s) => [s.plugin, s.permissions as PermissionSet]));
    return m.plugins.map((p, i) => {
      const pkg = (fetched[i] as { pkg: ExtensionPackage }).pkg;
      const set = permissionSetOfPackage(pkg);
      const warnings = migrationWarnings(pkg.migrationSql, p.name);
      const { added, removed } = diffPermissions(snapOf.get(p.name), set);
      const permissions = permissionGroups(set);
      return {
        name: p.name,
        npm: p.npm,
        range: p.version,
        lockVersion: p.lock.version,
        sha256: pkg.sha256,
        ...actionOf(states[i] as PluginState, p.version, p.name),
        optional: p.optional === true,
        permissions,
        added,
        addedItems: permissionKeyItems(added),
        removed,
        warnings,
        reviewHash: pluginReviewHash(set, warnings),
        sensitive: permissions.some((g) => g.sensitive) || warnings.length > 0,
      };
    });
  }

  private async readStored(sha256: string): Promise<ExtensionPackage> {
    return readExtensionPackage(await this.d.blobs.get(sha256), {
      maxBytes: this.d.config().packages.maxBytes,
      hostSdkVersion: SDK_VERSION,
    });
  }

  private async itemView(itemId: string): Promise<CatalogItemView> {
    const item = await this.d.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    const versions = await this.d.db
      .selectFrom("catalog_item_versions")
      .select(["version", "source"])
      .where("item_id", "=", itemId)
      .execute();
    return itemView(item, versions);
  }
}

/** 插件在部署上的现状 → action 与当前版本。 */
function actionOf(
  s: PluginState,
  range: string,
  name: string,
): Pick<AppReviewPlugin, "action" | "currentVersion" | "currentSha256"> {
  if (s.kind === "declared") {
    if (!satisfies(s.version, range)) {
      throw new ApiError(
        "app.plugin_conflict",
        `Plugin ${name} is declared by this deployment at version ${s.version}, which does not satisfy the app's range ${range}`,
      );
    }
    return { action: "keep", currentVersion: s.version, currentSha256: null };
  }
  if (s.kind === "installed") {
    return {
      action: satisfies(s.version, range) ? "keep" : "upgrade",
      currentVersion: s.version,
      currentSha256: s.sha256,
    };
  }
  return { action: "install", currentVersion: null, currentSha256: null };
}

/**
 * 应用审阅的总摘要（sha256 前 32 位十六进制）：应用名与版本、每个插件的名字 / sha256 / action / 当前版本 /
 * 当前安装的包（keep / upgrade 的已装插件换了包也算变化）/ 该插件的 reviewHash、每个模板的全部字段、每个技能的名字与路径，以及要存的每个文件的 sha256。
 */
function appReviewHash(
  r: Pick<AppReview, "name" | "version" | "plugins" | "connectorTemplates" | "skills">,
  files: { path: string; sha256: string }[],
): string {
  const canonical = JSON.stringify([
    r.name,
    r.version,
    r.plugins.map((p) => [
      p.name,
      p.sha256,
      p.action,
      p.currentVersion,
      p.currentSha256,
      p.reviewHash,
    ]),
    r.connectorTemplates.map((t) => [
      t.id,
      t.plugin,
      t.connector,
      t.endpoint,
      t.auth,
      t.editableEndpoint,
    ]),
    r.skills.map((s) => [s.name, s.path, s.files]),
    [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.sha256]),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * A version change that is a downgrade (lock version below the installed one) whose target version
 * has migrations not run on this deployment -> `extension.downgrade_unsupported` (the same rule as
 * `ExtensionAdminOps.install`: extension migrations are expand-only, a downgrade can only go back to a
 * version whose migrations have all run).
 */
async function assertDowngradable(
  db: KernelDb | Trx,
  p: Pick<AppReviewPlugin, "name" | "action" | "lockVersion" | "currentVersion">,
  migrationSql: { file: string; sql: string }[],
): Promise<void> {
  if (p.action !== "upgrade" || p.currentVersion === null) return;
  if (!semver.valid(p.currentVersion) || !semver.lt(p.lockVersion, p.currentVersion)) return;
  const unrun = await unrunMigrations(db, p.name, migrationSql);
  if (unrun.length > 0) {
    throw new ApiError(
      "extension.downgrade_unsupported",
      `The app locks plugin ${p.name} ${p.lockVersion}, older than the installed ${p.currentVersion}, and that version has migrations that were never run here (${unrun.join(", ")}); plugin migrations only expand, so this downgrade is not possible`,
      unrun.map((file) => ({ file })),
    );
  }
}
