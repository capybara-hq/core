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
import { sql } from "kysely";
import semver from "semver";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import type { PluginAdminOps } from "../plugins/admin-ops.js";
import { writeSnapshot } from "../plugins/approvals.js";
import type { PluginInstalls } from "../plugins/installs.js";
import {
  type PluginPackage,
  PluginPackageError,
  permissionSetOfPackage,
  readPluginPackage,
} from "../plugins/package.js";
import {
  diffPermissions,
  type PermissionSet,
  permissionKeys,
  WARNINGS_KEY_PREFIX,
} from "../plugins/permission-set.js";
import {
  migrationWarnings,
  type PackageWarning,
  type PermissionGroup,
  type PermissionItem,
  permissionGroups,
  permissionKeyItems,
  reviewHash as pluginReviewHash,
} from "../plugins/permission-view.js";
import type { PluginSource } from "../plugins/sources.js";
import { checkSkillFiles, SkillArchiveError, type SkillPackageFile } from "../skills/package.js";
import type { StorageService } from "../storage/storage.service.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import {
  iconProblem,
  toFile,
  type UnpackedDirectoryArchive,
  unpackDirectoryArchive,
} from "./archive.js";
import {
  type ActorOpts,
  assertPluginNameOwner,
  type DirectoryItemView,
  directoryObjectPrefix,
  itemView,
  precheckDirectoryImport,
  putDirectoryFiles,
  templateProblems,
  writeDirectoryVersion,
} from "./directory.service.js";

/**
 * 应用包（`app.yaml`，D17 / C31）的企业导入：一次审阅、一次批准。
 *
 * **插件包从哪里来**：应用包里不打插件 tgz，`app.yaml` 用 npm 包名 + lock（精确版本 + sha512）引用插件，
 * prepare 时逐个从配置的 npm registry 拉取 `lock.version`，校验以 `lock.integrity` 为准（`app.lock_mismatch`），
 * 不认 npm 元数据。这样应用包小、插件包与单独安装时完全相同（内容寻址，同一 sha256），供应链以应用作者锁定的
 * sha512 为准；代价是导入需要能访问 npm registry（离线部署用私有 registry / 镜像）。
 *
 * prepare：包一律当作恶意输入，**全部组件校验通过之前什么都不写**（F-AD）——解包（与目录包同一套上限）、
 * `app.yaml`（SDK `parseAppManifest`）、版本与 package.json 一致、图标、每个技能目录按技能包规则、连接器模板
 * （连接器插件在本副本已加载时按其 `endpointSchema` 校验，否则只做静态规则，组织安装时 T26 再按当时的连接器校验）、
 * 每个插件的部署状态（内置 / 配置声明不满足范围 → `app.plugin_conflict`；名字归属）与下载校验（下载全部放在内存里，
 * 读包校验名字、版本与 npm 包名）都在写之前；然后才把插件交给 `PluginInstalls.ingest` 入库（来源 `directory`）、
 * 把 app.yaml、图标与技能文件写进对象存储、写暂存行（24 小时）。内置 / 配置声明的插件只校验不入库。
 *
 * confirm：`reviewHash` 须与暂存时一致，且按此刻的部署状态重算的也一致（审阅后插件被装 / 升级 → `app.review_stale`）；
 * 一个事务里删暂存行（只能确认一次）、为 action 为 install 的插件写快照（source web，审计 `plugin.permissions_approved`
 * 带 `app`），`deployPlugins` 时 upgrade 的插件同样写快照（不装到部署时不写：快照必须对应实际运行的版本，F-O），
 * 建 / 加 kind app 的目录版本（`resolved = { plugins: [{ name, sha256 }] }`，文件留在暂存时的前缀下由版本行接管）。
 * 提交后 `deployPlugins` 时按清单顺序先全部 `PluginAdminOps.install`，再全部 `enable`（各副本 reconcile，不重启）。
 *
 * 暂存过期由维护任务 `app-staging-cleanup` 清理（{@link AppImport.cleanupExpired}）：删暂存行与其对象前缀；
 * 已入库的插件包留在内容寻址的 `plugin_packages`（与再次导入同一 tgz 相同，没有安装记录引用就不会被加载）。
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

/** 暂存来源。 */
interface StagingSource {
  kind: "file" | "npm" | "catalog";
  ref: string;
  integrity?: string;
  catalogSourceId?: string;
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

/** prepare 的来源（HTTP 层只给 file / npm；清单引入由 DirectoryService 带上清单信息）。 */
export interface AppPrepareSource {
  kind: "file" | "npm" | "catalog";
  ref: string;
  integrity?: string;
  /** npm：包里的 package.json name 必须是请求的包。 */
  expectPackageName?: string;
  /** 清单引入：应用名必须是条目名（否则 `catalog.package_mismatch`），条目记下来源清单。 */
  catalog?: { sourceId: string; name: string };
}

export interface AppImportDeps {
  db: KernelDb;
  config: () => KernelConfig;
  storage: StorageService;
  installs: Pick<PluginInstalls, "ingest" | "fetchNpm" | "fetchLocked">;
  ops: Pick<PluginAdminOps, "install" | "enable">;
  /** 读包存储里的包（确认时重算权限集合）。 */
  blobs: { get(sha256: string): Promise<Uint8Array> };
  /** 内置与配置声明的插件（名字、来源、版本）。 */
  declaredPlugins: () => readonly { name: string; source: PluginSource; version: string }[];
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

const satisfies = (version: string, range: string) =>
  semver.satisfies(version, range, { includePrerelease: true });

/** 部署上一个插件的现状。 */
type PluginState =
  | { kind: "declared"; source: PluginSource; version: string }
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
    const u = await unpackDirectoryArchive(bytes, maxBytes);
    if (u.section.kind !== "app") {
      throw new ApiError(
        "directory.wrong_kind",
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
    if (source.catalog && manifest.name !== source.catalog.name) {
      throw new ApiError(
        "catalog.package_mismatch",
        `The downloaded package does not match the catalog entry: the app is named "${manifest.name}", the entry says ${source.catalog.name}`,
      );
    }
    const content = this.checkContent(u, manifest);
    const existing = await precheckDirectoryImport(
      this.d.db,
      "app",
      manifest.name,
      packageName,
      version,
    );
    const states = await this.pluginStates(manifest);
    const fetched = await this.fetchPlugins(manifest);
    this.d.storage.assertAvailable();
    const reviewPlugins = await this.reviewPlugins(manifest, states, fetched);
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
      source.kind === "catalog" && source.catalog
        ? `catalog:${source.catalog.sourceId}:${packageName}@${version}`
        : `${itemId}@${version}`;
    for (const [i, p] of manifest.plugins.entries()) {
      if (states[i]?.kind === "declared") continue;
      const got = fetched[i] as { bytes: Uint8Array };
      await this.d.installs.ingest(
        actor,
        got.bytes,
        { source: "directory", ref: pluginRef },
        {
          expectPackageName: p.npm,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        },
      );
    }
    const objectPrefix = directoryObjectPrefix(itemId, version, stagingId);
    await putDirectoryFiles(this.d.storage, objectPrefix, content.files);
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
      ...(source.catalog && { catalogSourceId: source.catalog.sourceId }),
    };
    await this.d.db
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

  /** 确认导入（见文件头）。返回目录条目。 */
  async confirm(
    actor: string,
    stagingId: string,
    input: { reviewHash: string; deployPlugins: boolean },
    opts: ActorOpts = {},
  ): Promise<DirectoryItemView> {
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
    // 按此刻的部署状态重算 action：审阅之后插件被装 / 升级 / 改了配置声明，都要重新审阅
    const states = await this.pluginStates(staged.manifest);
    const now = review.plugins.map((p, i) => ({
      ...p,
      ...actionOf(states[i] as PluginState, p.range, p.name),
    }));
    if (appReviewHash({ ...review, plugins: now }, staged.files) !== review.reviewHash) {
      throw stale();
    }
    const approve = now.filter(
      (p) => p.action === "install" || (p.action === "upgrade" && input.deployPlugins),
    );
    const sets = new Map<string, PermissionSet>();
    for (const p of approve) {
      sets.set(p.name, permissionSetOfPackage(await this.readStored(p.sha256)));
    }

    const itemId = await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const used = await trx
        .deleteFrom("app_import_staging")
        .where("id", "=", stagingId)
        .where("expires_at", ">", sql<Date>`now()`)
        .returning("id")
        .executeTakeFirst();
      if (!used) throw notFound();
      for (const p of approve) {
        const set = sets.get(p.name) as PermissionSet;
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-approve:${p.name}`}))`.execute(
          trx,
        );
        const snapRow = await trx
          .selectFrom("plugin_permission_snapshots")
          .select(["version", "permissions"])
          .where("plugin", "=", p.name)
          .forUpdate()
          .executeTakeFirst();
        // 快照归属于插件名：与 PluginAdminOps.install 一样先登记名字归属（Ruling P3），否则之后安装时「名字有遗留数据
        // 却没有归属」会被拒绝
        await trx
          .insertInto("plugin_name_owners")
          .values({ name: p.name, package_name: p.npm })
          .onConflict((oc) => oc.column("name").doNothing())
          .execute();
        await assertPluginNameOwner(trx, p.name, p.npm);
        const snap = snapRow && { permissions: snapRow.permissions as PermissionSet };
        const { added, removed } = diffPermissions(snap?.permissions, set);
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
      return writeDirectoryVersion(trx, {
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
        ...(src.catalogSourceId !== undefined && { catalogSourceId: src.catalogSourceId }),
        objectPrefix: row.object_prefix,
        pluginSha256: null,
        files: staged.files,
        size: staged.size,
        resolved: { plugins: now.map((p) => ({ name: p.name, sha256: p.sha256 })) },
        auditDetail: {
          stagingId,
          deployPlugins: input.deployPlugins,
          plugins: now.map((p) => ({ name: p.name, version: p.lockVersion, action: p.action })),
        },
      });
    });

    if (input.deployPlugins) {
      const deploy = now.filter((p) => p.action !== "keep");
      // 先全部装上（新装为停用、换版本保持期望状态），再全部启用：requires 的顺序不影响
      for (const p of deploy) {
        await this.d.ops.install(p.name, p.sha256, actor, opts.actorTokenId);
      }
      for (const p of deploy) await this.d.ops.enable(p.name, actor, opts.actorTokenId);
    }
    return this.itemView(itemId);
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
  private readManifest(u: UnpackedDirectoryArchive, version: string): AppManifest {
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
    u: UnpackedDirectoryArchive,
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

  /** 每个插件在部署上的现状；内置 / 配置声明却不满足范围 → `app.plugin_conflict`；名字归属别的包 → `plugin.name_conflict`。 */
  private async pluginStates(m: AppManifest): Promise<PluginState[]> {
    const declared = new Map(this.d.declaredPlugins().map((p) => [p.name, p]));
    const rows = m.plugins.length
      ? await this.d.db
          .selectFrom("plugin_installs")
          .innerJoin("plugin_packages", "plugin_packages.sha256", "plugin_installs.sha256")
          .select([
            "plugin_installs.name",
            "plugin_installs.version",
            "plugin_installs.sha256",
            "plugin_packages.package_name",
          ])
          .where(
            "plugin_installs.name",
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
          "plugin.name_conflict",
          `Plugin ${p.name} is already installed from package ${r.package_name}; the app references package ${p.npm}`,
        );
      }
      await assertPluginNameOwner(this.d.db, p.name, p.npm);
      out.push(
        r
          ? { kind: "installed", version: r.version, sha256: r.sha256, packageName: r.package_name }
          : { kind: "absent" },
      );
    }
    return out;
  }

  /** 按 lock 下载全部插件并读包校验（只在内存里，F-AD）。 */
  private async fetchPlugins(m: AppManifest): Promise<{ bytes: Uint8Array; pkg: PluginPackage }[]> {
    const maxBytes = this.d.config().packages.maxBytes;
    const out: { bytes: Uint8Array; pkg: PluginPackage }[] = new Array(m.plugins.length);
    const queue = [...m.plugins.entries()];
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [i, p] = next;
          const got = await this.d.installs.fetchLocked({
            package: p.npm,
            version: p.lock.version,
            integrity: p.lock.integrity,
          });
          let pkg: PluginPackage;
          try {
            pkg = await readPluginPackage(got.bytes, { maxBytes, hostSdkVersion: SDK_VERSION });
          } catch (e) {
            if (e instanceof PluginPackageError) {
              throw new ApiError(
                "plugin.package_invalid",
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
    fetched: { pkg: PluginPackage }[],
  ): Promise<AppReviewPlugin[]> {
    const snaps = await this.d.db
      .selectFrom("plugin_permission_snapshots")
      .select(["plugin", "permissions"])
      .where("plugin", "in", m.plugins.length ? m.plugins.map((p) => p.name) : [""])
      .execute();
    const snapOf = new Map(snaps.map((s) => [s.plugin, s.permissions as PermissionSet]));
    return m.plugins.map((p, i) => {
      const pkg = (fetched[i] as { pkg: PluginPackage }).pkg;
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

  private async readStored(sha256: string): Promise<PluginPackage> {
    return readPluginPackage(await this.d.blobs.get(sha256), {
      maxBytes: this.d.config().packages.maxBytes,
      hostSdkVersion: SDK_VERSION,
    });
  }

  private async itemView(itemId: string): Promise<DirectoryItemView> {
    const item = await this.d.db
      .selectFrom("directory_items")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    const versions = await this.d.db
      .selectFrom("directory_item_versions")
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
): { action: AppReviewPlugin["action"]; currentVersion: string | null } {
  if (s.kind === "declared") {
    if (!satisfies(s.version, range)) {
      throw new ApiError(
        "app.plugin_conflict",
        `Plugin ${name} is declared by this deployment at version ${s.version}, which does not satisfy the app's range ${range}`,
      );
    }
    return { action: "keep", currentVersion: s.version };
  }
  if (s.kind === "installed") {
    return { action: satisfies(s.version, range) ? "keep" : "upgrade", currentVersion: s.version };
  }
  return { action: "install", currentVersion: null };
}

/**
 * 应用审阅的总摘要（sha256 前 32 位十六进制）：应用名与版本、每个插件的名字 / sha256 / action / 当前版本 / 该插件的
 * reviewHash、每个模板的全部字段、每个技能的名字与路径，以及要存的每个文件的 sha256。
 */
function appReviewHash(
  r: Pick<AppReview, "name" | "version" | "plugins" | "connectorTemplates" | "skills">,
  files: { path: string; sha256: string }[],
): string {
  const canonical = JSON.stringify([
    r.name,
    r.version,
    r.plugins.map((p) => [p.name, p.sha256, p.action, p.currentVersion, p.reviewHash]),
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
