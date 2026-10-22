import { randomUUID } from "node:crypto";
import {
  CONNECTOR_TEMPLATE_LIMITS,
  type Connector,
  type ConnectorTemplateSpec,
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
import { PluginPackageError, readPluginPackage } from "../plugins/package.js";
import type { AdminPluginView } from "../plugins/permission-view.js";
import type { PluginSource } from "../plugins/sources.js";
import type { StorageService } from "../storage/storage.service.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import { checkDirectoryArchive, invalidPackage, unpackDirectoryArchive } from "./archive.js";
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
  /** 组织安装数（安装表在 T26，之前恒为 0）。 */
  installs: number;
  /** 最新版本的来源（file / npm）。 */
  source: string;
  updatedAt: string;
}

/** 条目的一个版本。 */
export interface DirectoryItemVersionView {
  version: string;
  source: "file" | "npm";
  sourceRef: string;
  integrity: string | null;
  section: PackageSection;
  files: { path: string; size: number; sha256: string }[];
  size: number;
  pluginSha256: string | null;
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
  installs: Pick<PluginInstalls, "ingest" | "fetchNpm">;
  ops: Pick<PluginAdminOps, "install">;
  /** 内置与配置声明的插件名 → 来源（与它们重名的插件包导入时先报 `plugin.builtin` / `plugin.config_declared`）。 */
  declared: () => ReadonlyMap<string, PluginSource>;
  /** 本副本已加载的连接器：插件 `plugin` 提供的 `Connector.kind === kind`（导入模板时校验端点）。 */
  findConnector: (plugin: string, kind: string) => Connector | undefined;
}

/** 审计里带上 PAT（个人令牌发起时）。 */
export interface ActorOpts {
  actorTokenId?: string;
}

type Trx = Transaction<KernelDatabase>;

/** 包从哪里来（directory_item_versions.source / source_ref / integrity）。 */
interface ImportSource {
  source: "file" | "npm";
  ref: string;
  integrity?: string;
  /** npm：包里的 package.json name 必须是请求的包。 */
  expectPackageName?: string;
}

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
  importFile(actor: string, bytes: Uint8Array, opts: ActorOpts = {}): Promise<DirectoryItemView> {
    return this.import(actor, bytes, { source: "file", ref: "upload" }, opts);
  }

  /** 从配置的 npm registry 拉取（按 `dist.integrity` 校验，记下 integrity）。 */
  async importNpm(
    actor: string,
    input: { package: string; version?: string },
    opts: ActorOpts = {},
  ): Promise<DirectoryItemView> {
    const got = await this.d.installs.fetchNpm(input);
    return this.import(
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
  }

  private async import(
    actor: string,
    bytes: Uint8Array,
    src: ImportSource,
    opts: ActorOpts,
  ): Promise<DirectoryItemView> {
    const maxBytes = this.d.config().packages.maxBytes;
    const u = await unpackDirectoryArchive(bytes, maxBytes);
    const packageName = String(u.packageJson.name);
    if (src.expectPackageName !== undefined && packageName !== src.expectPackageName) {
      throw invalidPackage([
        `package.json name "${packageName}" does not match the requested npm package ${src.expectPackageName}`,
      ]);
    }
    const section = u.section;
    if (section.kind === "app") {
      throw new ApiError(
        "directory.wrong_kind",
        "App packages are not supported by this import yet; use the app import",
      );
    }

    // 1. 全部校验（不写任何东西）
    let name: string;
    let files: Awaited<ReturnType<typeof checkDirectoryArchive>>["files"] = [];
    if (section.kind === "plugin") {
      try {
        const pkg = await readPluginPackage(bytes, { maxBytes, hostSdkVersion: SDK_VERSION });
        name = pkg.section.manifest.name;
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
    const version = String(u.packageJson.version);
    const kind = section.kind;
    const existing = await this.liveItem(this.d.db, kind, name);
    if (existing)
      assertImportable(existing, packageName, version, await this.hasVersion(existing.id, version));
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
        { source: "directory", ref: `${storeId}@${version}` },
        opts.actorTokenId !== undefined ? { actorTokenId: opts.actorTokenId } : {},
      );
      pluginSha256 = review.sha256;
    } else if (files.length > 0) {
      objectPrefix = directoryObjectPrefix(storeId, version, randomUUID());
      await this.putFiles(objectPrefix, files);
    }

    // 3. 一个事务里复核、写条目与版本、审计
    const itemId = await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.directory-item:${kind}:${name}`}))`.execute(
        trx,
      );
      if (kind === "plugin") await assertPluginNameOwner(trx, name, packageName);
      const live = await this.liveItem(trx, kind, name);
      const listing = listingOf(section, u.packageJson);
      let id: string;
      if (live) {
        id = live.id;
        const versions = await trx
          .selectFrom("directory_item_versions")
          .select("version")
          .where("item_id", "=", id)
          .execute();
        assertImportable(
          live,
          packageName,
          version,
          versions.some((v) => v.version === version),
        );
        const newer = semver.gt(version, live.latest_version);
        await trx
          .updateTable("directory_items")
          .set({
            updated_at: sql<Date>`now()` as unknown as Date,
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
        id = storeId;
        await trx
          .insertInto("directory_items")
          .values({
            id,
            kind,
            name,
            package_name: packageName,
            publisher: listing.publisher,
            description: listing.description,
            display_name: listing.displayName ? JSON.stringify(listing.displayName) : null,
            latest_version: version,
            created_by: actor,
          })
          .execute();
      }
      await trx
        .insertInto("directory_item_versions")
        .values({
          item_id: id,
          version,
          section: JSON.stringify(section),
          source: src.source,
          source_ref: src.ref,
          integrity: src.integrity ?? null,
          object_prefix: objectPrefix,
          plugin_sha256: pluginSha256,
          files: JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))),
          size: bytes.byteLength,
          imported_by: actor,
        })
        .execute();
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "directory.imported",
        target: id,
        detail: {
          kind,
          name,
          version,
          source: src.source,
          sourceRef: src.ref,
          ...(pluginSha256 !== null && { sha256: pluginSha256 }),
          ...(src.integrity !== undefined && { integrity: src.integrity }),
        },
      });
      return id;
    });
    return this.view(itemId);
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
    const problems: string[] = [];
    const r = c.endpointSchema.safeParse(t.endpoint);
    if (!r.success) {
      for (const i of r.error.issues as { path: PropertyKey[]; message: string }[]) {
        problems.push(`${["template.endpoint", ...i.path.map(String)].join(".")}: ${i.message}`);
      }
    } else {
      for (const leak of endpointCredentialIssues(r.data)) {
        problems.push(`template.${leak.path}: ${leak.message}`);
      }
    }
    for (const p of t.editableEndpoint ?? []) {
      if (!schemaHasPath(c.endpointSchema, p.split("."))) {
        problems.push(
          `template.editableEndpoint "${p}" is not a field of the ${t.connector} connector's endpoint`,
        );
      }
    }
    if (problems.length > 0) throw invalidPackage(problems);
  }

  private async putFiles(
    prefix: string,
    files: { path: string; size: number; data: Uint8Array }[],
  ): Promise<void> {
    const store = this.d.storage.deployment();
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

  private liveItem(db: KernelDb | Trx, kind: PackageKind, name: string) {
    return db
      .selectFrom("directory_items")
      .select(["id", "package_name", "latest_version"])
      .where("kind", "=", kind)
      .where("name", "=", name)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
  }

  private async hasVersion(itemId: string, version: string): Promise<boolean> {
    const row = await this.d.db
      .selectFrom("directory_item_versions")
      .select("version")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    return row !== undefined;
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
    return { items: items.map((i) => itemView(i, byItem.get(i.id) ?? [])), nextOffset };
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
    return {
      item: {
        ...itemView(item, rows),
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
 * 插件名归第一次安装它的 npm 包（`plugin_name_owners`，Ruling P3）：归属是别的包时，导入时就拒绝
 * `plugin.name_conflict`（与安装时同一个错误码），不必等到装到部署才失败。
 */
async function assertPluginNameOwner(
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

function itemView(
  i: {
    id: string;
    kind: PackageKind;
    name: string;
    publisher: string;
    display_name: LocalizedName | null;
    description: string;
    policy: DirectoryPolicy;
    latest_version: string;
    updated_at: Date;
  },
  versions: { version: string; source: string }[],
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
    installs: 0,
    source: versions.find((v) => v.version === i.latest_version)?.source ?? "file",
    updatedAt: i.updated_at.toISOString(),
  };
}
