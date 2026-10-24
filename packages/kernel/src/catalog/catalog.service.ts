import { randomUUID } from "node:crypto";
import {
  type CatalogEntry,
  CONNECTOR_TEMPLATE_LIMITS,
  type Connector,
  type ConnectorTemplateSpec,
  compatibleVersions,
  type LocalizedName,
  type PackageKind,
  type PackageSection,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import semver from "semver";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionAdminOps } from "../extensions/admin-ops.js";
import type { ExtensionInstalls } from "../extensions/installs.js";
import {
  ExtensionPackageError,
  permissionSetOfPackage,
  readExtensionPackage,
} from "../extensions/package.js";
import { permissionKeys, WARNINGS_KEY_PREFIX } from "../extensions/permission-set.js";
import type { AdminExtensionView } from "../extensions/permission-view.js";
import type { ExtensionSource } from "../extensions/sources.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import type { StorageService } from "../storage/storage.service.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import { checkCatalogArchive, invalidPackage, unpackCatalogArchive } from "./archive.js";
import { HOST_VERSIONS, loadMarketplaceEntry, sourceEffective } from "./marketplaces.service.js";
import type { PluginImport, PluginReview } from "./plugin-import.js";
import { cancelPendingRequests } from "./requests.service.js";
import { schemaHasPath } from "./schema-path.js";

/** 条目策略（C22）：allow（新导入默认）/ needs_approval / disabled（不能新装，已装不受影响）。 */
export type CatalogPolicy = "allow" | "needs_approval" | "disabled";

/** 目录条目（列表项）。 */
export interface CatalogItemView {
  id: string;
  kind: PackageKind;
  name: string;
  publisher: string;
  displayName: LocalizedName | null;
  description: string;
  policy: CatalogPolicy;
  latestVersion: string;
  /** 全部版本，按 semver 从新到旧。 */
  versions: string[];
  /**
   * 安装了它的组织数：技能 / 连接器模板 = 有未删除的、来自该条目的技能 / 连接器的组织；插件 = 启用了该插件的组织；
   * 应用 = 已安装（installed）的组织。
   */
  installs: number;
  /** The latest version's source (file / npm / marketplace). */
  source: string;
  /** 从清单引入的条目记下的来源清单 id（`official` 或企业清单 id）；手动导入或来源清单已删除为 null。 */
  catalogSourceId: string | null;
  /** 来源清单（生效时）里该条目最高的兼容版本；不是从清单引入、来源停用或条目已不在清单里为 null。 */
  latestCatalogVersion: string | null;
  /** `latestCatalogVersion` 比已引入的最新版本新（界面显示「有新版本」；不自动引入）。 */
  newerInCatalog: boolean;
  updatedAt: string;
}

/** 条目的一个版本。 */
export interface CatalogItemVersionView {
  version: string;
  source: "file" | "npm" | "marketplace";
  sourceRef: string;
  integrity: string | null;
  section: PackageSection;
  files: { path: string; size: number; sha256: string }[];
  size: number;
  pluginSha256: string | null;
  /** 应用包：解析出的插件（`{ plugins: [{ name, sha256 }] }`）；其他种类为 null。 */
  resolved: unknown;
  importedBy: string | null;
  importedAt: string;
}

/** 条目详情（含已删除的条目：`deletedAt` 非空）。 */
export interface CatalogItemDetail {
  item: CatalogItemView & { packageName: string; deletedAt: string | null };
  versions: CatalogItemVersionView[];
}

export interface CatalogServiceDeps {
  db: KernelDb;
  config: () => KernelConfig;
  storage: StorageService;
  installs: Pick<ExtensionInstalls, "ingest" | "fetchNpm" | "fetchMarketplacePackage">;
  ops: Pick<ExtensionAdminOps, "install">;
  /** Builtin and config-declared extension names -> source (an extension package import with the same name fails first with `extension.builtin` / `extension.config_declared`). */
  declared: () => ReadonlyMap<string, ExtensionSource>;
  /** 本副本已加载的连接器：插件 `plugin` 提供的 `Connector.kind === kind`（导入模板时校验端点）。 */
  findConnector: (plugin: string, kind: string) => Connector | undefined;
  /** 本副本已加载的插件版本（导入模板时按 `pluginVersion` 复核；不传则不复核）。 */
  pluginVersion?: (plugin: string) => string | undefined;
  /** Plugin (app bundle) import (a marketplace entry of kind app goes through its prepare). */
  pluginImport?: Pick<PluginImport, "prepare">;
}

/** 审计里带上 PAT（个人令牌发起时）。 */
export interface ActorOpts {
  actorTokenId?: string;
}

type Trx = Transaction<KernelDatabase>;

/** Where a package comes from (catalog_item_versions.source / source_ref / integrity). */
interface ImportSource {
  source: "file" | "npm" | "marketplace";
  ref: string;
  integrity?: string;
  /** npm：包里的 package.json name 必须是请求的包。 */
  expectPackageName?: string;
  /**
   * Marketplace import: the package must match the entry (else `marketplace.package_mismatch`);
   * the item records its marketplace.
   */
  marketplace?: {
    sourceId: string;
    kind: PackageKind;
    name: string;
    npm: string;
    version: string;
  };
}

/**
 * 清单的权限摘要与包算出的权限键不一致（只警告，不拒绝；C26）：`missing` = 包要的、清单没列的，
 * `extra` = 清单列了、包没要的（应用为其全部插件的并集）。一致、清单没给摘要或不是插件 / 应用时为 null。
 */
export type PermissionsMismatch = { missing: string[]; extra: string[] } | null;

/**
 * The result of {@link CatalogService.importFromMarketplace} (F-AB): plugins / connector templates
 * / skills create the item directly (HTTP 201); apps return a staging id and a review (HTTP 200),
 * confirmed with `POST /admin/directory/apps/:stagingId/confirm`.
 */
export type MarketplaceImportResult =
  | { item: CatalogItemView; permissionsMismatch: PermissionsMismatch }
  | { stagingId: string; review: PluginReview; permissionsMismatch: PermissionsMismatch };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");

/**
 * 对象存储里一次导入的前缀（相对 `deployment/`）：`directory/<itemId>/<version>/<importId>/`。每次导入一个新的
 * `importId`，并发导入同一版本时被拒的那次不会覆盖已提交版本的文件；读取一律按版本行里存的 `object_prefix`。
 */
export const catalogObjectPrefix = (itemId: string, version: string, importId: string) =>
  `directory/${itemId}/${version}/${importId}/`;

/** 列表默认 / 最大每页条数。 */
export const CATALOG_LIST_DEFAULT_LIMIT = 200;
export const CATALOG_LIST_MAX_LIMIT = 1000;

const PUT_CONCURRENCY = 8;

const bySemverDesc = (a: string, b: string) => semver.rcompare(a, b);

/**
 * Enterprise directory items and imports (D9 / C21 / C22, `/api/v1/admin/directory/*`, enterprise
 * admins only). Four kinds: plugin, connector template, skill, app (T25; before it, importing an app
 * bundle returned `catalog.wrong_kind`). Stateless, shared by every replica.
 *
 * Import (file / npm): the package is always treated as hostile input, and **nothing is written until
 * everything passes** (F-AD): unpacking and kind check (archive.ts), full extension package validation
 * (`readExtensionPackage`), connector templates' endpoint and `editableEndpoint` against the loaded
 * connector's `endpointSchema`, conflicts of the same version / same name from another package, the
 * actor still an enterprise admin (re-checked under the lock) all happen before writing; only then is
 * storage written (extensions go to `ExtensionInstalls.ingest`, source `catalog`, ref
 * `<itemId>@<version>`, F-L; skill and template files go to `deployment/directory/<itemId>/<version>/`),
 * and a final transaction re-checks under the lock, writes the item and version and audits
 * `catalog.imported`. A failure after writing storage, before or inside the transaction (e.g. a
 * concurrent import of the same version: the later one gets 409 in the transaction), leaves harmless
 * leftovers: skill / template objects under a prefix unique to this import (referenced by no version,
 * overwriting no other version); extension packages already in the content-addressed
 * `extension_packages` (exactly what importing the same tgz again would give; without an install
 * record referencing them they are never loaded).
 */
export class CatalogService {
  constructor(private readonly d: CatalogServiceDeps) {}

  /** 上传的包（tgz；连接器模板与技能也可以是 zip）。 */
  async importFile(
    actor: string,
    bytes: Uint8Array,
    opts: ActorOpts = {},
  ): Promise<CatalogItemView> {
    return (await this.import(actor, bytes, { source: "file", ref: "upload" }, opts)).item;
  }

  /** 从配置的 npm registry 拉取（按 `dist.integrity` 校验，记下 integrity）。 */
  async importNpm(
    actor: string,
    input: { package: string; version?: string },
    opts: ActorOpts = {},
  ): Promise<CatalogItemView> {
    const got = await this.d.installs.fetchNpm(input);
    const r = await this.import(
      actor,
      got.bytes,
      {
        source: "npm",
        ref: `${input.package}@${got.version}`,
        integrity: got.integrity,
        expectPackageName: input.package,
      },
      opts,
    );
    return r.item;
  }

  /**
   * Imports one version of a marketplace entry (C25 / C26): the version must be compatible with the
   * host (`marketplace.incompatible`); downloads as the marketplace says (from `tarball` when given,
   * else from the npm registry), always verified against the marketplace's sha512
   * (`marketplace.integrity_mismatch`, nothing written); the package's npm name, version, kind and
   * item name must match the entry (`marketplace.package_mismatch`); then the same flow as a file /
   * npm import, with version source `marketplace` (source_ref `<sourceId>:<npm>@<version>`,
   * integrity the marketplace's sha512); a plugin package enters the package store with source
   * `catalog` and ref `catalog:<sourceId>:<npm>@<version>` (F-L). Policy lives only on the catalog
   * item (new items default to allow). Marketplace missing -> `marketplace.not_found`; marketplace
   * disabled, entry or version missing -> `marketplace.entry_not_found`.
   */
  async importFromMarketplace(
    actor: string,
    input: { sourceId: string; kind: PackageKind; name: string; version: string },
    opts: ActorOpts & { signal?: AbortSignal } = {},
  ): Promise<MarketplaceImportResult> {
    const { entry } = await loadMarketplaceEntry(
      this.d.db,
      this.d.config(),
      input.sourceId,
      input.kind,
      input.name,
    );
    const v = entry.versions.find((x) => x.version === input.version);
    if (!v) {
      throw new ApiError(
        "marketplace.entry_not_found",
        `Version ${input.version} of marketplace entry ${input.kind} ${input.name} not found`,
      );
    }
    if (!compatibleVersions(entry, HOST_VERSIONS).some((x) => x.version === v.version)) {
      throw new ApiError(
        "marketplace.incompatible",
        `${entry.npm}@${v.version} needs kernel >= ${v.minKernel}${v.minSdk !== undefined ? ` and SDK >= ${v.minSdk}` : ""}; this deployment runs kernel ${HOST_VERSIONS.kernel} with SDK ${HOST_VERSIONS.sdk}`,
      );
    }
    const got = await this.d.installs.fetchMarketplacePackage(
      {
        package: entry.npm,
        version: v.version,
        integrity: v.integrity,
        ...(v.tarball !== undefined && { tarball: v.tarball }),
      },
      opts.signal,
    );
    const marketplaceRef = `${input.sourceId}:${entry.npm}@${v.version}`;
    if (entry.kind === "app") {
      // The entry decides the kind; a package that is not an app -> marketplace.package_mismatch
      // (the reverse is caught by import()'s consistency check)
      const u = await unpackCatalogArchive(got.bytes, this.d.config().packages.maxBytes);
      assertMarketplacePackage(u, {
        kind: entry.kind,
        npm: entry.npm,
        version: v.version,
      });
      if (!this.d.pluginImport) {
        throw new ApiError("catalog.wrong_kind", "App packages cannot be imported here");
      }
      const staged = await this.d.pluginImport.prepare(
        actor,
        got.bytes,
        {
          kind: "marketplace",
          ref: marketplaceRef,
          integrity: v.integrity,
          marketplace: { sourceId: input.sourceId, name: entry.name },
        },
        opts.actorTokenId !== undefined ? { actorTokenId: opts.actorTokenId } : {},
      );
      return {
        stagingId: staged.stagingId,
        review: staged.review,
        permissionsMismatch: permissionsMismatch(entry.permissions?.keys, staged.permissionKeys),
      };
    }
    const r = await this.import(
      actor,
      got.bytes,
      {
        source: "marketplace",
        ref: marketplaceRef,
        integrity: v.integrity,
        marketplace: {
          sourceId: input.sourceId,
          kind: entry.kind,
          name: entry.name,
          npm: entry.npm,
          version: v.version,
        },
      },
      opts.actorTokenId !== undefined ? { actorTokenId: opts.actorTokenId } : {},
    );
    return {
      item: r.item,
      permissionsMismatch: permissionsMismatch(entry.permissions?.keys, r.permissionKeys),
    };
  }

  /** 导入一个包；`permissionKeys` 为插件包算出的权限键（不含迁移警告键；非插件为 undefined）。 */
  private async import(
    actor: string,
    bytes: Uint8Array,
    src: ImportSource,
    opts: ActorOpts,
  ): Promise<{ item: CatalogItemView; permissionKeys?: string[] }> {
    const maxBytes = this.d.config().packages.maxBytes;
    const u = await unpackCatalogArchive(bytes, maxBytes);
    const packageName = String(u.packageJson.name);
    const cat = src.marketplace;
    if (cat) assertMarketplacePackage(u, cat);
    if (src.expectPackageName !== undefined && packageName !== src.expectPackageName) {
      throw invalidPackage([
        `package.json name "${packageName}" does not match the requested npm package ${src.expectPackageName}`,
      ]);
    }
    const section = u.section;
    if (section.kind === "app") {
      throw new ApiError(
        "catalog.wrong_kind",
        "App packages are imported with one review of all their plugins: POST /api/v1/admin/directory/apps/prepare/file (or /apps/prepare/npm), then /apps/:stagingId/confirm",
      );
    }

    // 1. 全部校验（不写任何东西）
    let name: string;
    let files: Awaited<ReturnType<typeof checkCatalogArchive>>["files"] = [];
    let pkgPermissionKeys: string[] | undefined;
    if (section.kind === "plugin") {
      try {
        const pkg = await readExtensionPackage(bytes, { maxBytes, hostSdkVersion: SDK_VERSION });
        name = pkg.section.manifest.name;
        pkgPermissionKeys = permissionKeys(permissionSetOfPackage(pkg)).filter(
          (k) => !k.startsWith(WARNINGS_KEY_PREFIX),
        );
      } catch (e) {
        if (e instanceof ExtensionPackageError) throw invalidPackage(e.issues);
        throw e;
      }
      // 与内置 / 配置声明的插件重名：给出与插件包上传相同的明确错误（它们的名字归属也已登记，否则会先报归属冲突）
      const declared = this.d.declared().get(name);
      if (declared === "builtin") {
        throw new ApiError(
          "extension.builtin",
          `Plugin ${name} is built into this deployment and cannot be imported from a package`,
        );
      }
      if (declared === "config") {
        throw new ApiError(
          "extension.config_declared",
          `Plugin ${name} is declared in the startup config (plugins); remove it there before importing it as a package`,
        );
      }
      await assertPluginNameOwner(this.d.db, name, packageName);
    } else {
      const a = checkCatalogArchive(u);
      name = a.name;
      files = a.files;
      if (a.section.kind === "connector-template") this.checkTemplate(a.section.template);
      // 只有要存文件时才需要对象存储（没有图标的模板只有 PG 行）
      if (files.length > 0) this.d.storage.assertAvailable();
    }
    if (cat && name !== cat.name) {
      throw marketplaceMismatch(
        `the ${section.kind} is named "${name}", the entry says ${cat.name}`,
      );
    }
    const version = String(u.packageJson.version);
    const kind = section.kind;
    const existing = await precheckCatalogImport(this.d.db, kind, name, packageName, version);
    // 写之前在锁内复核发起人仍是企业管理员（守卫读到的身份可能已过期）
    await this.d.db.transaction().execute((trx) => lockEnterpriseAdminsAndAuthorize(trx, actor));

    // 2. 写存储
    const storeId = existing?.id ?? randomUUID();
    let pluginSha256: string | null = null;
    let objectPrefix: string | null = null;
    if (kind === "plugin") {
      const review = await this.d.installs.ingest(
        actor,
        bytes,
        {
          source: "catalog",
          ref: cat ? `catalog:${cat.sourceId}:${cat.npm}@${version}` : `${storeId}@${version}`,
        },
        opts.actorTokenId !== undefined ? { actorTokenId: opts.actorTokenId } : {},
      );
      pluginSha256 = review.sha256;
    } else if (files.length > 0) {
      objectPrefix = catalogObjectPrefix(storeId, version, randomUUID());
      await putCatalogFiles(this.d.storage, objectPrefix, files);
    }

    // 3. 一个事务里复核、写条目与版本、审计
    const itemId = await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      if (kind === "plugin") {
        await lockCatalogName(trx, kind, name);
        await assertPluginNameOwner(trx, name, packageName);
      }
      return writeCatalogVersion(trx, {
        actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        kind,
        name,
        packageName,
        version,
        section,
        listing: listingOf(section, u.packageJson),
        newItemId: storeId,
        source: src,
        ...(cat && { marketplaceId: cat.sourceId }),
        objectPrefix,
        pluginSha256,
        files,
        size: bytes.byteLength,
      });
    });
    const item = await this.view(itemId);
    return { item, ...(pkgPermissionKeys !== undefined && { permissionKeys: pkgPermissionKeys }) };
  }

  /**
   * 连接器模板按本副本已加载的连接器校验：插件 `template.plugin` 提供 `Connector.kind === template.connector`；
   * 端点符合其 `endpointSchema`、不含凭据样式的头 / query / URL 用户信息（与连接器安装同一规则）；
   * `editableEndpoint` 的每个路径都存在于端点 schema 中。
   */
  private checkTemplate(t: ConnectorTemplateSpec): void {
    const c = this.d.findConnector(t.plugin, t.connector);
    if (!c) {
      throw invalidPackage([
        `template.connector: plugin ${t.plugin} providing connector "${t.connector}" is not loaded in this deployment; install and enable the connector plugin before importing templates for it`,
      ]);
    }
    const problems = templateProblems(c, t, "template");
    const loaded = this.d.pluginVersion?.(t.plugin);
    if (
      t.pluginVersion !== undefined &&
      loaded !== undefined &&
      !semver.satisfies(loaded, t.pluginVersion, { includePrerelease: true })
    ) {
      problems.push(
        `template.pluginVersion: plugin ${t.plugin} is loaded at version ${loaded}, which does not satisfy ${t.pluginVersion}`,
      );
    }
    if (problems.length > 0) throw invalidPackage(problems);
  }

  /**
   * Item list (deleted items excluded by default), ordered by kind, name, id. Paging: `limit`
   * defaults to {@link CATALOG_LIST_DEFAULT_LIMIT}, at most {@link CATALOG_LIST_MAX_LIMIT}, `offset`
   * defaults to 0; use the returned array directly when only the first page is needed.
   */
  async list(
    q: { kind?: PackageKind; includeDeleted?: boolean; limit?: number; offset?: number } = {},
  ): Promise<CatalogItemView[]> {
    return (await this.page(q)).items;
  }

  /** 同 {@link list}，另给出下一页的 offset（没有下一页为 null）。 */
  async page(
    q: { kind?: PackageKind; includeDeleted?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ items: CatalogItemView[]; nextOffset: number | null }> {
    const limit = Math.min(
      Math.max(1, q.limit ?? CATALOG_LIST_DEFAULT_LIMIT),
      CATALOG_LIST_MAX_LIMIT,
    );
    const offset = Math.max(0, q.offset ?? 0);
    let query = this.d.db
      .selectFrom("catalog_items")
      .selectAll()
      .orderBy("kind")
      .orderBy("name")
      .orderBy("id")
      .limit(limit + 1)
      .offset(offset);
    if (q.kind !== undefined) query = query.where("kind", "=", q.kind);
    if (!q.includeDeleted) query = query.where("deleted_at", "is", null);
    const rows = await query.execute();
    const nextOffset = rows.length > limit ? offset + limit : null;
    const items = rows.slice(0, limit);
    if (items.length === 0) return { items: [], nextOffset: null };
    const versions = await this.d.db
      .selectFrom("catalog_item_versions")
      .select(["item_id", "version", "source"])
      .where(
        "item_id",
        "in",
        items.map((i) => i.id),
      )
      .execute();
    const byItem = new Map<string, { version: string; source: string }[]>();
    for (const v of versions) {
      const list = byItem.get(v.item_id) ?? [];
      list.push(v);
      byItem.set(v.item_id, list);
    }
    const installs = await countInstalls(this.d.db, items);
    const latest = await marketplaceLatest(this.d.db, this.d.config(), items);
    return {
      items: items.map((i) =>
        itemView(i, byItem.get(i.id) ?? [], installs.get(i.id) ?? 0, latest.get(i.id) ?? null),
      ),
      nextOffset,
    };
  }

  /** Item detail (with every version; deleted items too). Missing -> `catalog.item_not_found`. */
  async get(itemId: string): Promise<CatalogItemDetail> {
    if (!UUID_RE.test(itemId)) throw notFound();
    const item = await this.d.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!item) throw notFound();
    const rows = await this.d.db
      .selectFrom("catalog_item_versions")
      .selectAll()
      .where("item_id", "=", itemId)
      .execute();
    rows.sort((a, b) => bySemverDesc(a.version, b.version));
    const installs = await countInstalls(this.d.db, [item]);
    const latest = await marketplaceLatest(this.d.db, this.d.config(), [item]);
    return {
      item: {
        ...itemView(item, rows, installs.get(item.id) ?? 0, latest.get(item.id) ?? null),
        packageName: item.package_name,
        deletedAt: item.deleted_at?.toISOString() ?? null,
      },
      versions: rows.map((v) => ({
        version: v.version,
        source: v.source,
        sourceRef: v.source_ref,
        integrity: v.integrity,
        section: v.section as PackageSection,
        files: v.files,
        size: Number(v.size),
        pluginSha256: v.plugin_sha256,
        resolved: v.resolved ?? null,
        importedBy: v.imported_by,
        importedAt: v.imported_at.toISOString(),
      })),
    };
  }

  /**
   * Changes the policy (audit `catalog.policy_changed`, not written when unchanged). Deleted /
   * missing -> `catalog.item_not_found`.
   */
  async setPolicy(
    actor: string,
    itemId: string,
    policy: CatalogPolicy,
    opts: ActorOpts = {},
  ): Promise<CatalogItemView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await trx
        .selectFrom("catalog_items")
        .select(["kind", "name", "policy"])
        .where("id", "=", itemId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notFound();
      if (row.policy === policy) return;
      await trx
        .updateTable("catalog_items")
        .set({ policy, updated_at: sql<Date>`now()` as unknown as Date })
        .where("id", "=", itemId)
        .execute();
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "catalog.policy_changed",
        target: itemId,
        detail: { kind: row.kind, name: row.name, from: row.policy, to: policy },
      });
    });
    return this.view(itemId);
  }

  /**
   * Deletes the item (soft delete, audit `catalog.removed`; requests still pending are cancelled in
   * the same transaction): versions and stored files are kept (installed components still refer to
   * them), organizations no longer see it; the same (kind, name) can later be imported again as a
   * new item. Deleted / missing -> `catalog.item_not_found`.
   */
  async remove(actor: string, itemId: string, opts: ActorOpts = {}): Promise<void> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await trx
        .updateTable("catalog_items")
        .set({
          deleted_at: sql<Date>`now()` as unknown as Date,
          updated_at: sql<Date>`now()` as unknown as Date,
        })
        .where("id", "=", itemId)
        .where("deleted_at", "is", null)
        .returning(["kind", "name"])
        .executeTakeFirst();
      if (!row) throw notFound();
      // 条目没了，挂着的申请也没有意义：同一事务里取消（不再出现在收件箱 / 企业管理员列表）
      await cancelPendingRequests(trx, { itemId }, actor, "item_removed", opts);
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "catalog.removed",
        target: itemId,
        detail: { kind: row.kind, name: row.name },
      });
    });
  }

  /**
   * Installs one version of a plugin item to the deployment (`ExtensionAdminOps.install`: a new
   * install is disabled, a version change keeps the desired state; audit `extension.installed`), with
   * the install record linked to the item (F-AA). Permissions still need approval (the returned status
   * may be `pending_approval`). Not a plugin item -> `catalog.wrong_kind`; item or version missing ->
   * `catalog.item_not_found`.
   */
  async installToDeployment(
    actor: string,
    itemId: string,
    version: string,
    opts: ActorOpts = {},
  ): Promise<AdminExtensionView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    const item = await this.d.db
      .selectFrom("catalog_items")
      .select(["id", "kind", "name"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw notFound();
    if (item.kind !== "plugin") {
      throw new ApiError(
        "catalog.wrong_kind",
        `Only plugin items can be installed to the deployment; this item is a ${item.kind}`,
      );
    }
    const v = await this.d.db
      .selectFrom("catalog_item_versions")
      .select("plugin_sha256")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!v?.plugin_sha256) {
      throw new ApiError("catalog.item_not_found", `Version ${version} of this item not found`);
    }
    return this.d.ops.install(item.name, v.plugin_sha256, actor, opts.actorTokenId, {
      catalogItemId: itemId,
    });
  }

  private async view(itemId: string): Promise<CatalogItemView> {
    return (await this.get(itemId)).item;
  }
}

/**
 * 连接器模板按已加载的连接器 `c` 校验（问题路径以 `at` 开头）：端点符合其 `endpointSchema`、不含凭据样式的头 /
 * query / URL 用户信息（与连接器安装同一规则）；`editableEndpoint` 的每个路径都存在于端点 schema 中。
 */
export function templateProblems(c: Connector, t: ConnectorTemplateSpec, at: string): string[] {
  const problems: string[] = [];
  const r = c.endpointSchema.safeParse(t.endpoint);
  if (!r.success) {
    for (const i of r.error.issues as { path: PropertyKey[]; message: string }[]) {
      problems.push(`${[`${at}.endpoint`, ...i.path.map(String)].join(".")}: ${i.message}`);
    }
  } else {
    for (const leak of endpointCredentialIssues(r.data)) {
      problems.push(`${at}.${leak.path}: ${leak.message}`);
    }
  }
  for (const p of t.editableEndpoint ?? []) {
    if (!schemaHasPath(c.endpointSchema, p.split("."))) {
      problems.push(
        `${at}.editableEndpoint "${p}" is not a field of the ${t.connector} connector's endpoint`,
      );
    }
  }
  return problems;
}

/** 把文件写到 `deployment/<prefix><path>`（并发 {@link PUT_CONCURRENCY}）。 */
export async function putCatalogFiles(
  storage: StorageService,
  prefix: string,
  files: { path: string; size: number; data: Uint8Array }[],
): Promise<void> {
  const store = storage.deployment();
  const queue = [...files];
  await Promise.all(
    Array.from({ length: Math.min(PUT_CONCURRENCY, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        await store.put(`${prefix}${f.path}`, f.data, {
          contentType: "application/octet-stream",
          size: f.size,
        });
      }
    }),
  );
}

const marketplaceMismatch = (what: string) =>
  new ApiError(
    "marketplace.package_mismatch",
    `The downloaded package does not match the marketplace entry: ${what}`,
  );

/**
 * Marketplace import: the package's npm name, version and kind must match the entry (else
 * `marketplace.package_mismatch`).
 */
function assertMarketplacePackage(
  u: { packageJson: Record<string, unknown>; section: PackageSection },
  cat: { kind: PackageKind; npm: string; version: string },
): void {
  const packageName = String(u.packageJson.name);
  if (packageName !== cat.npm) {
    throw marketplaceMismatch(`package.json name is "${packageName}", the entry says ${cat.npm}`);
  }
  if (String(u.packageJson.version) !== cat.version) {
    throw marketplaceMismatch(
      `package.json version is "${String(u.packageJson.version)}", the entry says ${cat.version}`,
    );
  }
  if (u.section.kind !== cat.kind) {
    throw marketplaceMismatch(`the package is a ${u.section.kind}, the entry says ${cat.kind}`);
  }
}

/** 清单的权限摘要与包算出的权限键比对（见 {@link PermissionsMismatch}）。 */
function permissionsMismatch(
  declared: string[] | undefined,
  actual: string[] | undefined,
): PermissionsMismatch {
  if (declared === undefined || actual === undefined) return null;
  const want = new Set(declared);
  const have = new Set(actual);
  const missing = [...have].filter((k) => !want.has(k)).sort();
  const extra = [...want].filter((k) => !have.has(k)).sort();
  return missing.length > 0 || extra.length > 0 ? { missing, extra } : null;
}

/** 列表显示的字段（条目的 publisher / description / displayName）。 */
export interface CatalogListing {
  publisher: string;
  description: string;
  displayName: LocalizedName | null;
}

/** Input of {@link writeCatalogVersion}. */
export interface CatalogVersionWrite {
  actor: string;
  actorTokenId?: string;
  kind: PackageKind;
  name: string;
  packageName: string;
  version: string;
  section: PackageSection;
  listing: CatalogListing;
  /** 条目还不存在时用这个 id 新建（与写存储时用的前缀一致）。 */
  newItemId: string;
  source: { source: "file" | "npm" | "marketplace"; ref: string; integrity?: string };
  /** 从清单引入：条目记下来源清单。 */
  marketplaceId?: string;
  objectPrefix: string | null;
  pluginSha256: string | null;
  files: { path: string; size: number; sha256: string }[];
  size: number;
  /** 应用包：解析出的组件（`{ plugins: [{ name, sha256 }] }`）。 */
  resolved?: unknown;
  /** Merged into the detail of the `catalog.imported` audit. */
  auditDetail?: Record<string, unknown>;
}

/** 按 (kind, name) 取事务级咨询锁（同一条目的并发导入串行）。 */
export async function lockCatalogName(trx: Trx, kind: PackageKind, name: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.directory-item:${kind}:${name}`}))`.execute(
    trx,
  );
}

function liveItem(db: KernelDb | Trx, kind: PackageKind, name: string) {
  return db
    .selectFrom("catalog_items")
    .select(["id", "package_name", "latest_version"])
    .where("kind", "=", kind)
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

async function hasVersion(db: KernelDb | Trx, itemId: string, version: string): Promise<boolean> {
  const row = await db
    .selectFrom("catalog_item_versions")
    .select("version")
    .where("item_id", "=", itemId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Conflict precheck before writing (no lock; {@link writeCatalogVersion}'s re-check inside the
 * transaction is final): an item with the same name from another npm package ->
 * `catalog.name_conflict`; version already imported -> `catalog.version_exists`. Returns the
 * existing item (undefined when there is none).
 */
export async function precheckCatalogImport(
  db: KernelDb,
  kind: PackageKind,
  name: string,
  packageName: string,
  version: string,
): Promise<{ id: string } | undefined> {
  const existing = await liveItem(db, kind, name);
  if (existing) {
    assertImportable(existing, packageName, version, await hasVersion(db, existing.id, version));
  }
  return existing;
}

/**
 * Writes a catalog version in the caller's transaction (the caller has re-checked the enterprise
 * admin): takes the (kind, name) advisory lock, checks conflicts again, creates the item when there
 * is none or adds the version (latest and display fields change only for a higher version), and
 * writes the version row and the `catalog.imported` audit. Returns the item id.
 */
export async function writeCatalogVersion(trx: Trx, w: CatalogVersionWrite): Promise<string> {
  const { kind, name, version, listing } = w;
  await lockCatalogName(trx, kind, name);
  const live = await liveItem(trx, kind, name);
  let id: string;
  if (live) {
    id = live.id;
    assertImportable(live, w.packageName, version, await hasVersion(trx, id, version));
    const newer = semver.gt(version, live.latest_version);
    await trx
      .updateTable("catalog_items")
      .set({
        updated_at: sql<Date>`now()` as unknown as Date,
        ...(w.marketplaceId !== undefined && { marketplace_id: w.marketplaceId }),
        ...(newer && {
          latest_version: version,
          publisher: listing.publisher,
          description: listing.description,
          display_name: listing.displayName ? JSON.stringify(listing.displayName) : null,
        }),
      })
      .where("id", "=", id)
      .execute();
  } else {
    id = w.newItemId;
    await trx
      .insertInto("catalog_items")
      .values({
        id,
        kind,
        name,
        package_name: w.packageName,
        publisher: listing.publisher,
        description: listing.description,
        display_name: listing.displayName ? JSON.stringify(listing.displayName) : null,
        latest_version: version,
        created_by: w.actor,
        marketplace_id: w.marketplaceId ?? null,
      })
      .execute();
  }
  await trx
    .insertInto("catalog_item_versions")
    .values({
      item_id: id,
      version,
      section: JSON.stringify(w.section),
      source: w.source.source,
      source_ref: w.source.ref,
      integrity: w.source.integrity ?? null,
      object_prefix: w.objectPrefix,
      plugin_sha256: w.pluginSha256,
      resolved: w.resolved === undefined ? null : JSON.stringify(w.resolved),
      files: JSON.stringify(w.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))),
      size: w.size,
      imported_by: w.actor,
    })
    .execute();
  await audit(trx, {
    actorAccountId: w.actor,
    ...(w.actorTokenId !== undefined && { actorTokenId: w.actorTokenId }),
    action: "catalog.imported",
    target: id,
    detail: {
      kind,
      name,
      version,
      source: w.source.source,
      sourceRef: w.source.ref,
      ...(w.pluginSha256 !== null && { sha256: w.pluginSha256 }),
      ...(w.source.integrity !== undefined && { integrity: w.source.integrity }),
      ...(w.marketplaceId !== undefined && { marketplaceId: w.marketplaceId }),
      ...w.auditDetail,
    },
  });
  return id;
}

/**
 * An extension name belongs to the npm package that first installed it (`extension_name_owners`,
 * Ruling P3): when another package owns it, the import is refused right away with
 * `extension.name_conflict` (the same code as at install), instead of failing only at deploy time.
 */
export async function assertPluginNameOwner(
  db: KernelDb | Trx,
  name: string,
  packageName: string,
): Promise<void> {
  const owner = await db
    .selectFrom("extension_name_owners")
    .select("package_name")
    .where("name", "=", name)
    .executeTakeFirst();
  if (owner && owner.package_name !== packageName) {
    throw new ApiError(
      "extension.name_conflict",
      `Plugin name ${name} belongs to package ${owner.package_name}; package ${packageName} cannot use it`,
    );
  }
}

/** 已有条目时能否导入这个包：同一 npm 包、版本不重复。 */
function assertImportable(
  item: { package_name: string },
  packageName: string,
  version: string,
  versionExists: boolean,
): void {
  if (item.package_name !== packageName) {
    throw new ApiError(
      "catalog.name_conflict",
      `A catalog item with this name comes from package ${item.package_name}; package ${packageName} cannot add versions to it`,
    );
  }
  if (versionExists) {
    throw new ApiError(
      "catalog.version_exists",
      `Version ${version} of this catalog item has already been imported`,
    );
  }
}

/**
 * 列表显示的字段：连接器模板与技能取 `capybara` 段；插件的静态清单没有这些，取 package.json 的 `author`
 * （字符串或 `{ name }`，缺省用 npm scope）与 `description`（截到上限）。
 */
function listingOf(
  section: PackageSection,
  pkg: Record<string, unknown>,
): { publisher: string; description: string; displayName: LocalizedName | null } {
  if (section.kind === "connector-template" || section.kind === "skill") {
    return {
      publisher: section.publisher,
      description: section.description,
      displayName: section.displayName ?? null,
    };
  }
  const name = String(pkg.name);
  const author =
    typeof pkg.author === "string"
      ? pkg.author
      : typeof (pkg.author as { name?: unknown } | undefined)?.name === "string"
        ? String((pkg.author as { name: string }).name)
        : name.startsWith("@")
          ? name.slice(1, name.indexOf("/"))
          : "";
  const description = typeof pkg.description === "string" ? pkg.description : "";
  return {
    publisher: [...author].slice(0, CONNECTOR_TEMPLATE_LIMITS.publisherChars).join(""),
    description: [...description].slice(0, CONNECTOR_TEMPLATE_LIMITS.descriptionChars).join(""),
    displayName: null,
  };
}

/**
 * The highest compatible version of a marketplace-imported item in its marketplace (when enabled)
 * (see {@link CatalogItemView.latestCatalogVersion}).
 */
async function marketplaceLatest(
  db: KernelDb,
  config: KernelConfig,
  items: { id: string; kind: PackageKind; name: string; marketplace_id?: string | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const sourced = items.filter((i) => typeof i.marketplace_id === "string");
  if (sourced.length === 0) return out;
  const rows = await db
    .selectFrom("marketplace_entries as e")
    .innerJoin("marketplaces as s", "s.id", "e.source_id")
    .select(["e.source_id", "e.kind", "e.name", "e.entry", "s.builtin", "s.enabled"])
    .where("e.source_id", "in", [...new Set(sourced.map((i) => i.marketplace_id as string))])
    .where("e.name", "in", [...new Set(sourced.map((i) => i.name))])
    .execute();
  for (const i of sourced) {
    const r = rows.find(
      (x) => x.source_id === i.marketplace_id && x.kind === i.kind && x.name === i.name,
    );
    if (!r || !sourceEffective(r, config)) continue;
    const [best] = compatibleVersions(r.entry as CatalogEntry, HOST_VERSIONS)
      .map((v) => v.version)
      .sort(bySemverDesc);
    if (best !== undefined) out.set(i.id, best);
  }
  return out;
}

/** Org install counts per item (see {@link CatalogItemView.installs}). */
async function countInstalls(
  db: KernelDb,
  items: { id: string; kind: PackageKind; name: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = (k: PackageKind) => items.filter((i) => i.kind === k).map((i) => i.id);
  const add = (rows: { id: string | null; n: string | number }[]) => {
    for (const r of rows) if (r.id) out.set(r.id, Number(r.n));
  };
  const skillIds = ids("skill");
  if (skillIds.length > 0) {
    add(
      await db
        .selectFrom("skills")
        .select(["catalog_item_id as id", sql<string>`count(DISTINCT org_id)`.as("n")])
        .where("catalog_item_id", "in", skillIds)
        .where("deleted_at", "is", null)
        .groupBy("catalog_item_id")
        .execute(),
    );
  }
  const templateIds = ids("connector-template");
  if (templateIds.length > 0) {
    add(
      await db
        .selectFrom("connectors")
        .select(["catalog_item_id as id", sql<string>`count(DISTINCT org_id)`.as("n")])
        .where("catalog_item_id", "in", templateIds)
        .where("deleted_at", "is", null)
        .groupBy("catalog_item_id")
        .execute(),
    );
  }
  const appIds = ids("app");
  if (appIds.length > 0) {
    add(
      await db
        .selectFrom("plugin_installs")
        .select(["item_id as id", sql<string>`count(DISTINCT org_id)`.as("n")])
        .where("item_id", "in", appIds)
        .where("status", "=", "installed")
        .groupBy("item_id")
        .execute(),
    );
  }
  const plugins = items.filter((i) => i.kind === "plugin");
  if (plugins.length > 0) {
    const rows = await db
      .selectFrom("extension_org_configs")
      .select(["plugin", sql<string>`count(*)`.as("n")])
      .where(
        "plugin",
        "in",
        plugins.map((p) => p.name),
      )
      .where("enabled", "=", true)
      .groupBy("plugin")
      .execute();
    for (const p of plugins) {
      const r = rows.find((x) => x.plugin === p.name);
      if (r) out.set(p.id, Number(r.n));
    }
  }
  return out;
}

export function itemView(
  i: {
    id: string;
    kind: PackageKind;
    name: string;
    publisher: string;
    display_name: LocalizedName | null;
    description: string;
    policy: CatalogPolicy;
    latest_version: string;
    marketplace_id?: string | null;
    updated_at: Date;
  },
  versions: { version: string; source: string }[],
  installs = 0,
  latestCatalogVersion: string | null = null,
): CatalogItemView {
  const sorted = [...versions].sort((a, b) => bySemverDesc(a.version, b.version));
  const top = sorted[0]?.version ?? i.latest_version;
  return {
    id: i.id,
    kind: i.kind,
    name: i.name,
    publisher: i.publisher,
    displayName: i.display_name,
    description: i.description,
    policy: i.policy,
    latestVersion: i.latest_version,
    versions: sorted.map((v) => v.version),
    installs,
    source: versions.find((v) => v.version === i.latest_version)?.source ?? "file",
    catalogSourceId: i.marketplace_id ?? null,
    latestCatalogVersion,
    newerInCatalog: latestCatalogVersion !== null && semver.gt(latestCatalogVersion, top),
    updatedAt: i.updated_at.toISOString(),
  };
}
