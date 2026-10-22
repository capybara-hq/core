import { randomUUID } from "node:crypto";
import {
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
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import type { PluginAdminOps } from "../plugins/admin-ops.js";
import type { PluginInstalls } from "../plugins/installs.js";
import {
  PluginPackageError,
  permissionSetOfPackage,
  readPluginPackage,
} from "../plugins/package.js";
import { permissionKeys, WARNINGS_KEY_PREFIX } from "../plugins/permission-set.js";
import type { AdminPluginView } from "../plugins/permission-view.js";
import type { PluginSource } from "../plugins/sources.js";
import type { StorageService } from "../storage/storage.service.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import type { AppImport, AppReview } from "./app-import.js";
import { checkDirectoryArchive, invalidPackage, unpackDirectoryArchive } from "./archive.js";
import { HOST_VERSIONS, loadCatalogEntry } from "./catalogs.service.js";
import { schemaHasPath } from "./schema-path.js";

/** 条目策略（C22）：allow（新导入默认）/ needs_approval / disabled（不能新装，已装不受影响）。 */
export type DirectoryPolicy = "allow" | "needs_approval" | "disabled";

/** 目录条目（列表项）。 */
export interface DirectoryItemView {
  id: string;
  kind: PackageKind;
  name: string;
  publisher: string;
  displayName: LocalizedName | null;
  description: string;
  policy: DirectoryPolicy;
  latestVersion: string;
  /** 全部版本，按 semver 从新到旧。 */
  versions: string[];
  /**
   * 安装了它的组织数：技能 / 连接器模板 = 有未删除的、来自该条目的技能 / 连接器的组织；插件 = 启用了该插件的组织；
   * 应用 = 已安装（installed）的组织。
   */
  installs: number;
  /** 最新版本的来源（file / npm / catalog）。 */
  source: string;
  /** 从清单引入的条目记下的来源清单 id（`official` 或企业清单 id）；手动导入或来源清单已删除为 null。 */
  catalogSourceId: string | null;
  updatedAt: string;
}

/** 条目的一个版本。 */
export interface DirectoryItemVersionView {
  version: string;
  source: "file" | "npm" | "catalog";
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
export interface DirectoryItemDetail {
  item: DirectoryItemView & { packageName: string; deletedAt: string | null };
  versions: DirectoryItemVersionView[];
}

export interface DirectoryServiceDeps {
  db: KernelDb;
  config: () => KernelConfig;
  storage: StorageService;
  installs: Pick<PluginInstalls, "ingest" | "fetchNpm" | "fetchCatalogPackage">;
  ops: Pick<PluginAdminOps, "install">;
  /** 内置与配置声明的插件名 → 来源（与它们重名的插件包导入时先报 `plugin.builtin` / `plugin.config_declared`）。 */
  declared: () => ReadonlyMap<string, PluginSource>;
  /** 本副本已加载的连接器：插件 `plugin` 提供的 `Connector.kind === kind`（导入模板时校验端点）。 */
  findConnector: (plugin: string, kind: string) => Connector | undefined;
  /** 应用包导入（清单引入 kind app 时走它的 prepare）。 */
  apps?: Pick<AppImport, "prepare">;
}

/** 审计里带上 PAT（个人令牌发起时）。 */
export interface ActorOpts {
  actorTokenId?: string;
}

type Trx = Transaction<KernelDatabase>;

/** 包从哪里来（directory_item_versions.source / source_ref / integrity）。 */
interface ImportSource {
  source: "file" | "npm" | "catalog";
  ref: string;
  integrity?: string;
  /** npm：包里的 package.json name 必须是请求的包。 */
  expectPackageName?: string;
  /** 清单引入：包必须与条目一致（否则 `catalog.package_mismatch`），条目记下来源清单。 */
  catalog?: {
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
 * {@link DirectoryService.importFromCatalog} 的结果（F-AB）：插件 / 连接器模板 / 技能直接建条目（HTTP 201）；
 * 应用返回暂存 id 与审阅（HTTP 200），由 `POST /admin/directory/apps/:stagingId/confirm` 确认。
 */
export type CatalogImportResult =
  | { item: DirectoryItemView; permissionsMismatch: PermissionsMismatch }
  | { stagingId: string; review: AppReview; permissionsMismatch: PermissionsMismatch };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ApiError("directory.item_not_found", "Directory item not found");

/**
 * 对象存储里一次导入的前缀（相对 `deployment/`）：`directory/<itemId>/<version>/<importId>/`。每次导入一个新的
 * `importId`，并发导入同一版本时被拒的那次不会覆盖已提交版本的文件；读取一律按版本行里存的 `object_prefix`。
 */
export const directoryObjectPrefix = (itemId: string, version: string, importId: string) =>
  `directory/${itemId}/${version}/${importId}/`;

/** 列表默认 / 最大每页条数。 */
export const DIRECTORY_LIST_DEFAULT_LIMIT = 200;
export const DIRECTORY_LIST_MAX_LIMIT = 1000;

const PUT_CONCURRENCY = 8;

const bySemverDesc = (a: string, b: string) => semver.rcompare(a, b);

/**
 * 企业目录条目与导入（D9 / C21 / C22，`/api/v1/admin/directory/*`，仅企业管理员）。四种 kind：插件、连接器模板、技能、
 * 应用（T25；之前导入应用包返回 `directory.wrong_kind`）。本身无状态，多副本共用。
 *
 * 导入（文件 / npm）：包一律当作恶意输入，**全部校验通过之前什么都不写**（F-AD）——解包与种类校验
 * （archive.ts）、插件包的完整校验（`readPluginPackage`）、连接器模板按已加载连接器的 `endpointSchema` 校验端点与
 * `editableEndpoint`、同一版本 / 同名不同包的冲突、发起人仍是企业管理员（锁内复核）都在写之前；然后才写存储
 * （插件交给 `PluginInstalls.ingest`，来源 `directory`、ref `<itemId>@<version>`，F-L；技能与模板的文件放
 * `deployment/directory/<itemId>/<version>/`），最后一个事务里锁内复核、写条目与版本、审计 `directory.imported`。
 * 写存储之后、事务之前或事务里失败（如并发导入同一版本，后到的在事务里得到 409）会留下无害的残留：
 * 技能 / 模板的对象在本次导入独有的前缀下（不被任何版本引用、不会覆盖别的版本）；插件包已进内容寻址的
 * `plugin_packages`（与再次导入同一 tgz 得到的完全相同，没有安装记录引用它也不会被加载）。
 */
export class DirectoryService {
  constructor(private readonly d: DirectoryServiceDeps) {}

  /** 上传的包（tgz；连接器模板与技能也可以是 zip）。 */
  async importFile(
    actor: string,
    bytes: Uint8Array,
    opts: ActorOpts = {},
  ): Promise<DirectoryItemView> {
    return (await this.import(actor, bytes, { source: "file", ref: "upload" }, opts)).item;
  }

  /** 从配置的 npm registry 拉取（按 `dist.integrity` 校验，记下 integrity）。 */
  async importNpm(
    actor: string,
    input: { package: string; version?: string },
    opts: ActorOpts = {},
  ): Promise<DirectoryItemView> {
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
   * 从清单引入某个条目的某个版本（C25 / C26）：版本须与宿主兼容（`catalog.incompatible`）；按清单下载（给了
   * `tarball` 就从它下载，否则走 npm registry），校验一律以清单的 sha512 为准（`catalog.integrity_mismatch`，
   * 什么都不写）；包的 npm 名、版本、种类与条目名必须与条目一致（`catalog.package_mismatch`）；然后走与文件 / npm
   * 导入相同的流程，版本来源 `catalog`（source_ref `<sourceId>:<npm>@<version>`，integrity 为清单的 sha512），
   * 插件包进包存储时来源 `directory`、ref `catalog:<sourceId>:<npm>@<version>`（F-L）。策略只挂在目录条目上
   * （新条目默认 allow）。来源不存在 → `catalog.not_found`；来源停用、条目或版本不存在 → `catalog.entry_not_found`。
   */
  async importFromCatalog(
    actor: string,
    input: { sourceId: string; kind: PackageKind; name: string; version: string },
    opts: ActorOpts & { signal?: AbortSignal } = {},
  ): Promise<CatalogImportResult> {
    const { entry } = await loadCatalogEntry(
      this.d.db,
      this.d.config(),
      input.sourceId,
      input.kind,
      input.name,
    );
    const v = entry.versions.find((x) => x.version === input.version);
    if (!v) {
      throw new ApiError(
        "catalog.entry_not_found",
        `Version ${input.version} of catalog entry ${input.kind} ${input.name} not found`,
      );
    }
    if (!compatibleVersions(entry, HOST_VERSIONS).some((x) => x.version === v.version)) {
      throw new ApiError(
        "catalog.incompatible",
        `${entry.npm}@${v.version} needs kernel >= ${v.minKernel}${v.minSdk !== undefined ? ` and SDK >= ${v.minSdk}` : ""}; this deployment runs kernel ${HOST_VERSIONS.kernel} with SDK ${HOST_VERSIONS.sdk}`,
      );
    }
    const got = await this.d.installs.fetchCatalogPackage(
      {
        package: entry.npm,
        version: v.version,
        integrity: v.integrity,
        ...(v.tarball !== undefined && { tarball: v.tarball }),
      },
      opts.signal,
    );
    const catalogRef = `${input.sourceId}:${entry.npm}@${v.version}`;
    if (entry.kind === "app") {
      // 种类以条目为准；包不是应用 → catalog.package_mismatch（反过来由 import() 的一致性检查拦下）
      const u = await unpackDirectoryArchive(got.bytes, this.d.config().packages.maxBytes);
      assertCatalogPackage(u, {
        kind: entry.kind,
        npm: entry.npm,
        version: v.version,
      });
      if (!this.d.apps) {
        throw new ApiError("directory.wrong_kind", "App packages cannot be imported here");
      }
      const staged = await this.d.apps.prepare(
        actor,
        got.bytes,
        {
          kind: "catalog",
          ref: catalogRef,
          integrity: v.integrity,
          catalog: { sourceId: input.sourceId, name: entry.name },
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
        source: "catalog",
        ref: catalogRef,
        integrity: v.integrity,
        catalog: {
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
  ): Promise<{ item: DirectoryItemView; permissionKeys?: string[] }> {
    const maxBytes = this.d.config().packages.maxBytes;
    const u = await unpackDirectoryArchive(bytes, maxBytes);
    const packageName = String(u.packageJson.name);
    const cat = src.catalog;
    if (cat) assertCatalogPackage(u, cat);
    if (src.expectPackageName !== undefined && packageName !== src.expectPackageName) {
      throw invalidPackage([
        `package.json name "${packageName}" does not match the requested npm package ${src.expectPackageName}`,
      ]);
    }
    const section = u.section;
    if (section.kind === "app") {
      throw new ApiError(
        "directory.wrong_kind",
        "App packages are imported with one review of all their plugins: POST /api/v1/admin/directory/apps/prepare/file (or /apps/prepare/npm), then /apps/:stagingId/confirm",
      );
    }

    // 1. 全部校验（不写任何东西）
    let name: string;
    let files: Awaited<ReturnType<typeof checkDirectoryArchive>>["files"] = [];
    let pkgPermissionKeys: string[] | undefined;
    if (section.kind === "plugin") {
      try {
        const pkg = await readPluginPackage(bytes, { maxBytes, hostSdkVersion: SDK_VERSION });
        name = pkg.section.manifest.name;
        pkgPermissionKeys = permissionKeys(permissionSetOfPackage(pkg)).filter(
          (k) => !k.startsWith(WARNINGS_KEY_PREFIX),
        );
      } catch (e) {
        if (e instanceof PluginPackageError) throw invalidPackage(e.issues);
        throw e;
      }
      // 与内置 / 配置声明的插件重名：给出与插件包上传相同的明确错误（它们的名字归属也已登记，否则会先报归属冲突）
      const declared = this.d.declared().get(name);
      if (declared === "builtin") {
        throw new ApiError(
          "plugin.builtin",
          `Plugin ${name} is built into this deployment and cannot be imported from a package`,
        );
      }
      if (declared === "config") {
        throw new ApiError(
          "plugin.config_declared",
          `Plugin ${name} is declared in the startup config (plugins); remove it there before importing it as a package`,
        );
      }
      await assertPluginNameOwner(this.d.db, name, packageName);
    } else {
      const a = checkDirectoryArchive(u);
      name = a.name;
      files = a.files;
      if (a.section.kind === "connector-template") this.checkTemplate(a.section.template);
      // 只有要存文件时才需要对象存储（没有图标的模板只有 PG 行）
      if (files.length > 0) this.d.storage.assertAvailable();
    }
    if (cat && name !== cat.name) {
      throw catalogMismatch(`the ${section.kind} is named "${name}", the entry says ${cat.name}`);
    }
    const version = String(u.packageJson.version);
    const kind = section.kind;
    const existing = await precheckDirectoryImport(this.d.db, kind, name, packageName, version);
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
          source: "directory",
          ref: cat ? `catalog:${cat.sourceId}:${cat.npm}@${version}` : `${storeId}@${version}`,
        },
        opts.actorTokenId !== undefined ? { actorTokenId: opts.actorTokenId } : {},
      );
      pluginSha256 = review.sha256;
    } else if (files.length > 0) {
      objectPrefix = directoryObjectPrefix(storeId, version, randomUUID());
      await putDirectoryFiles(this.d.storage, objectPrefix, files);
    }

    // 3. 一个事务里复核、写条目与版本、审计
    const itemId = await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      if (kind === "plugin") {
        await lockDirectoryName(trx, kind, name);
        await assertPluginNameOwner(trx, name, packageName);
      }
      return writeDirectoryVersion(trx, {
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
        ...(cat && { catalogSourceId: cat.sourceId }),
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
    if (problems.length > 0) throw invalidPackage(problems);
  }

  /**
   * 条目列表（默认不含已删除），按种类、名字、id 排序。分页：`limit` 缺省 {@link DIRECTORY_LIST_DEFAULT_LIMIT}、
   * 最大 {@link DIRECTORY_LIST_MAX_LIMIT}，`offset` 缺省 0；只要第一页时直接用返回数组。
   */
  async list(
    q: { kind?: PackageKind; includeDeleted?: boolean; limit?: number; offset?: number } = {},
  ): Promise<DirectoryItemView[]> {
    return (await this.page(q)).items;
  }

  /** 同 {@link list}，另给出下一页的 offset（没有下一页为 null）。 */
  async page(
    q: { kind?: PackageKind; includeDeleted?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ items: DirectoryItemView[]; nextOffset: number | null }> {
    const limit = Math.min(
      Math.max(1, q.limit ?? DIRECTORY_LIST_DEFAULT_LIMIT),
      DIRECTORY_LIST_MAX_LIMIT,
    );
    const offset = Math.max(0, q.offset ?? 0);
    let query = this.d.db
      .selectFrom("directory_items")
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
      .selectFrom("directory_item_versions")
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
    return {
      items: items.map((i) => itemView(i, byItem.get(i.id) ?? [], installs.get(i.id) ?? 0)),
      nextOffset,
    };
  }

  /** 条目详情（含各版本；已删除的条目也能看）。不存在 → `directory.item_not_found`。 */
  async get(itemId: string): Promise<DirectoryItemDetail> {
    if (!UUID_RE.test(itemId)) throw notFound();
    const item = await this.d.db
      .selectFrom("directory_items")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!item) throw notFound();
    const rows = await this.d.db
      .selectFrom("directory_item_versions")
      .selectAll()
      .where("item_id", "=", itemId)
      .execute();
    rows.sort((a, b) => bySemverDesc(a.version, b.version));
    const installs = await countInstalls(this.d.db, [item]);
    return {
      item: {
        ...itemView(item, rows, installs.get(item.id) ?? 0),
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

  /** 改策略（审计 `directory.policy_changed`，没变时不写）。已删除 / 不存在 → `directory.item_not_found`。 */
  async setPolicy(
    actor: string,
    itemId: string,
    policy: DirectoryPolicy,
    opts: ActorOpts = {},
  ): Promise<DirectoryItemView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await trx
        .selectFrom("directory_items")
        .select(["kind", "name", "policy"])
        .where("id", "=", itemId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notFound();
      if (row.policy === policy) return;
      await trx
        .updateTable("directory_items")
        .set({ policy, updated_at: sql<Date>`now()` as unknown as Date })
        .where("id", "=", itemId)
        .execute();
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "directory.policy_changed",
        target: itemId,
        detail: { kind: row.kind, name: row.name, from: row.policy, to: policy },
      });
    });
    return this.view(itemId);
  }

  /**
   * 删除条目（软删除，审计 `directory.removed`）：版本与存储里的文件保留（已安装的组件仍引用它们），组织不再看到它；
   * 之后同一 (kind, name) 可以重新导入成新条目。已删除 / 不存在 → `directory.item_not_found`。
   */
  async remove(actor: string, itemId: string, opts: ActorOpts = {}): Promise<void> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await trx
        .updateTable("directory_items")
        .set({
          deleted_at: sql<Date>`now()` as unknown as Date,
          updated_at: sql<Date>`now()` as unknown as Date,
        })
        .where("id", "=", itemId)
        .where("deleted_at", "is", null)
        .returning(["kind", "name"])
        .executeTakeFirst();
      if (!row) throw notFound();
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "directory.removed",
        target: itemId,
        detail: { kind: row.kind, name: row.name },
      });
    });
  }

  /**
   * 把插件条目的某个版本装到部署（`PluginAdminOps.install`：新装为停用，换版本保持期望状态；审计 `plugin.installed`），
   * 安装记录关联条目（F-AA）。权限仍需批准（返回的状态可能是 `pending_approval`）。
   * 非插件条目 → `directory.wrong_kind`；条目或版本不存在 → `directory.item_not_found`。
   */
  async installToDeployment(
    actor: string,
    itemId: string,
    version: string,
    opts: ActorOpts = {},
  ): Promise<AdminPluginView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    const item = await this.d.db
      .selectFrom("directory_items")
      .select(["id", "kind", "name"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw notFound();
    if (item.kind !== "plugin") {
      throw new ApiError(
        "directory.wrong_kind",
        `Only plugin items can be installed to the deployment; this item is a ${item.kind}`,
      );
    }
    const v = await this.d.db
      .selectFrom("directory_item_versions")
      .select("plugin_sha256")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!v?.plugin_sha256) {
      throw new ApiError("directory.item_not_found", `Version ${version} of this item not found`);
    }
    return this.d.ops.install(item.name, v.plugin_sha256, actor, opts.actorTokenId, {
      directoryItemId: itemId,
    });
  }

  private async view(itemId: string): Promise<DirectoryItemView> {
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
export async function putDirectoryFiles(
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

const catalogMismatch = (what: string) =>
  new ApiError(
    "catalog.package_mismatch",
    `The downloaded package does not match the catalog entry: ${what}`,
  );

/** 清单引入：包的 npm 名、版本与种类必须与条目一致（否则 `catalog.package_mismatch`）。 */
function assertCatalogPackage(
  u: { packageJson: Record<string, unknown>; section: PackageSection },
  cat: { kind: PackageKind; npm: string; version: string },
): void {
  const packageName = String(u.packageJson.name);
  if (packageName !== cat.npm) {
    throw catalogMismatch(`package.json name is "${packageName}", the entry says ${cat.npm}`);
  }
  if (String(u.packageJson.version) !== cat.version) {
    throw catalogMismatch(
      `package.json version is "${String(u.packageJson.version)}", the entry says ${cat.version}`,
    );
  }
  if (u.section.kind !== cat.kind) {
    throw catalogMismatch(`the package is a ${u.section.kind}, the entry says ${cat.kind}`);
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
export interface DirectoryListing {
  publisher: string;
  description: string;
  displayName: LocalizedName | null;
}

/** {@link writeDirectoryVersion} 的输入。 */
export interface DirectoryVersionWrite {
  actor: string;
  actorTokenId?: string;
  kind: PackageKind;
  name: string;
  packageName: string;
  version: string;
  section: PackageSection;
  listing: DirectoryListing;
  /** 条目还不存在时用这个 id 新建（与写存储时用的前缀一致）。 */
  newItemId: string;
  source: { source: "file" | "npm" | "catalog"; ref: string; integrity?: string };
  /** 从清单引入：条目记下来源清单。 */
  catalogSourceId?: string;
  objectPrefix: string | null;
  pluginSha256: string | null;
  files: { path: string; size: number; sha256: string }[];
  size: number;
  /** 应用包：解析出的组件（`{ plugins: [{ name, sha256 }] }`）。 */
  resolved?: unknown;
  /** 并进审计 `directory.imported` 的 detail。 */
  auditDetail?: Record<string, unknown>;
}

/** 按 (kind, name) 取事务级咨询锁（同一条目的并发导入串行）。 */
export async function lockDirectoryName(trx: Trx, kind: PackageKind, name: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.directory-item:${kind}:${name}`}))`.execute(
    trx,
  );
}

function liveItem(db: KernelDb | Trx, kind: PackageKind, name: string) {
  return db
    .selectFrom("directory_items")
    .select(["id", "package_name", "latest_version"])
    .where("kind", "=", kind)
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

async function hasVersion(db: KernelDb | Trx, itemId: string, version: string): Promise<boolean> {
  const row = await db
    .selectFrom("directory_item_versions")
    .select("version")
    .where("item_id", "=", itemId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * 写之前的冲突预检（不加锁；最终以 {@link writeDirectoryVersion} 在事务里的复核为准）：同名条目来自别的 npm 包 →
 * `directory.name_conflict`；同一版本已导入 → `directory.version_exists`。返回现有条目（没有为 undefined）。
 */
export async function precheckDirectoryImport(
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
 * 在调用方事务里写一个目录版本（调用方已复核企业管理员）：按 (kind, name) 咨询锁、再查冲突，没有条目就新建，
 * 有就加版本（新版本更高才更新 latest 与展示字段），写版本行与审计 `directory.imported`。返回条目 id。
 */
export async function writeDirectoryVersion(trx: Trx, w: DirectoryVersionWrite): Promise<string> {
  const { kind, name, version, listing } = w;
  await lockDirectoryName(trx, kind, name);
  const live = await liveItem(trx, kind, name);
  let id: string;
  if (live) {
    id = live.id;
    assertImportable(live, w.packageName, version, await hasVersion(trx, id, version));
    const newer = semver.gt(version, live.latest_version);
    await trx
      .updateTable("directory_items")
      .set({
        updated_at: sql<Date>`now()` as unknown as Date,
        ...(w.catalogSourceId !== undefined && { catalog_source_id: w.catalogSourceId }),
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
      .insertInto("directory_items")
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
        catalog_source_id: w.catalogSourceId ?? null,
      })
      .execute();
  }
  await trx
    .insertInto("directory_item_versions")
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
    action: "directory.imported",
    target: id,
    detail: {
      kind,
      name,
      version,
      source: w.source.source,
      sourceRef: w.source.ref,
      ...(w.pluginSha256 !== null && { sha256: w.pluginSha256 }),
      ...(w.source.integrity !== undefined && { integrity: w.source.integrity }),
      ...(w.catalogSourceId !== undefined && { catalogSourceId: w.catalogSourceId }),
      ...w.auditDetail,
    },
  });
  return id;
}

/**
 * 插件名归第一次安装它的 npm 包（`plugin_name_owners`，Ruling P3）：归属是别的包时，导入时就拒绝
 * `plugin.name_conflict`（与安装时同一个错误码），不必等到装到部署才失败。
 */
export async function assertPluginNameOwner(
  db: KernelDb | Trx,
  name: string,
  packageName: string,
): Promise<void> {
  const owner = await db
    .selectFrom("plugin_name_owners")
    .select("package_name")
    .where("name", "=", name)
    .executeTakeFirst();
  if (owner && owner.package_name !== packageName) {
    throw new ApiError(
      "plugin.name_conflict",
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
      "directory.name_conflict",
      `A directory item with this name comes from package ${item.package_name}; package ${packageName} cannot add versions to it`,
    );
  }
  if (versionExists) {
    throw new ApiError(
      "directory.version_exists",
      `Version ${version} of this directory item has already been imported`,
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

/** 各条目的组织安装数（见 {@link DirectoryItemView.installs}）。 */
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
        .select(["directory_item_id as id", sql<string>`count(DISTINCT org_id)`.as("n")])
        .where("directory_item_id", "in", skillIds)
        .where("deleted_at", "is", null)
        .groupBy("directory_item_id")
        .execute(),
    );
  }
  const templateIds = ids("connector-template");
  if (templateIds.length > 0) {
    add(
      await db
        .selectFrom("connectors")
        .select(["directory_item_id as id", sql<string>`count(DISTINCT org_id)`.as("n")])
        .where("directory_item_id", "in", templateIds)
        .where("deleted_at", "is", null)
        .groupBy("directory_item_id")
        .execute(),
    );
  }
  const appIds = ids("app");
  if (appIds.length > 0) {
    add(
      await db
        .selectFrom("app_installs")
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
      .selectFrom("plugin_org_configs")
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
    policy: DirectoryPolicy;
    latest_version: string;
    catalog_source_id?: string | null;
    updated_at: Date;
  },
  versions: { version: string; source: string }[],
  installs = 0,
): DirectoryItemView {
  const sorted = [...versions].sort((a, b) => bySemverDesc(a.version, b.version));
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
    catalogSourceId: i.catalog_source_id ?? null,
    updatedAt: i.updated_at.toISOString(),
  };
}
