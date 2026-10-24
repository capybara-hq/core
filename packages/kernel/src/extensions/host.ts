import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXTENSION_POINT_CARDINALITY,
  type ExtensionManifest,
  type ExtensionPointRef,
  parseExtensionPoint,
  SDK_VERSION,
  type StaticExtensionManifest,
  type ToolHandler,
  type ToolSpec,
  type UiContribution,
} from "@capybara-hq/plugin-sdk";
import type { core } from "zod";
import {
  changedPaths,
  configFields,
  getPath,
  secretValues,
  setPath,
  unreachableSecrets,
} from "../config/fields.js";
import {
  type ExtensionPointAccess,
  type KernelDeps,
  type KernelExtensionContext,
  pluginSchemaName,
  queryEnabledPlugins,
  type Route,
} from "../ctx/create-ctx.js";
import { kernelDb } from "../db/kernel-schema.js";
import { migrate } from "../db/migrator.js";
import { createDb } from "../db/pool.js";
import type { PluginRouteTable } from "../http/plugin-dispatch.js";
import type { UiActionHandler, UiRender } from "../ui/registry.js";
import {
  type ApprovalDecision,
  ExtensionApprovals,
  type PendingExtension,
  type PermissionSnapshot,
  planApprovals,
  withPreApproved,
} from "./approvals.js";
import { ExtensionBlobIntegrityError } from "./blobs.js";
import { DEFAULT_HOOK_TIMEOUT_MS, HookRegistry } from "./hooks.js";
import { type InflightTracker, type TrackOptions, trackCalls } from "./inflight.js";
import type { DesiredExtension } from "./installs.js";
import {
  DEFAULT_DISPOSE_TIMEOUT_MS,
  type ExtensionInstance,
  ImportTracker,
  importExtensionModule,
  type LoadDeps,
  ManifestMismatchError,
  matchesSection,
  setupInstance,
  warnUpgrades,
} from "./instance.js";
import { toIssues } from "./org-config.js";
import { permissionSetOfSection, readMigrationSql } from "./package.js";
import {
  blockingKeys,
  computePermissionSet,
  type PermissionSet,
  UI_VIEW_KEY_PREFIX,
} from "./permission-set.js";
import { ExtensionRegistry } from "./registry.js";
import { ExtensionResolveError, resolveExtensions } from "./resolve.js";
import type {
  ExtensionLoadStatus,
  ExtensionSource,
  PendingReason,
  ReplicaStatusStore,
} from "./sources.js";
import { PackageShaMismatchError, packageRootOf } from "./sync.js";

/** 键排序后的 JSON（对象键顺序不影响结果）；undefined 字段与 JSON.stringify 一样省略。 */
const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v))
    return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
};

/** 遮蔽 secret 字段后参与摘要的固定占位值。 */
const SECRET_PLACEHOLDER = "<secret>";

/**
 * 插件部署配置（校验后）中非密钥部分的摘要：先把 schema 里所有 secret 叶子（`configFields` 可达路径，
 * 加载时 `assertSecretsReachable` 已保证密钥都在这些路径上）换成固定占位值，再取 sha256(键排序 JSON) 前 16 位十六进制。
 * 给需要「配置变了就失效」的缓存键用（如模型列表）。密钥不参与摘要：不加盐的短摘要写进 Redis 键名后，
 * 低熵密钥可被离线猜测、泄露的密钥可被确认；代价是轮换密钥不会让缓存失效（缓存内容本来就不该依赖密钥）。
 * 没有部署配置 schema 时无从得知哪些是密钥，摘要不按配置区分。同一份配置在各副本上得到同一摘要。
 * 函数自己按 schema 遮蔽，调用方不必（也不能忘记）先打码。
 */
export function deploymentConfigHash(schema: core.$ZodType | undefined, config: unknown): string {
  let redacted: unknown = null;
  if (schema) {
    redacted = structuredClone(config);
    if (redacted !== null && typeof redacted === "object") {
      for (const f of configFields(schema)) {
        if (f.meta?.secret && getPath(redacted, f.path) !== undefined) {
          setPath(redacted as Record<string, unknown>, f.path, SECRET_PLACEHOLDER);
        }
      }
    }
  }
  return createHash("sha256").update(canonicalJson(redacted)).digest("hex").slice(0, 16);
}

/** One item of {@link ExtensionHost.uiContributions}: a UI contribution from the manifest with its registered view / action (embeds have none). */
export interface LoadedUiContribution {
  plugin: string;
  contribution: UiContribution;
  render?: UiRender;
  action?: UiActionHandler;
}

/** One item of {@link ExtensionHost.list}. */
export interface ExtensionPointEntry {
  plugin: string;
  capability: ExtensionPointRef;
  impl: unknown;
  /** 插件清单的 version。 */
  version: string;
  /** 部署配置摘要，见 {@link deploymentConfigHash}。 */
  configHash: string;
  /** 提供方实例的在途计数（connector / sandbox / model-provider 的 `impl` 已经包成计入它的代理）。 */
  inflight: InflightTracker;
}

const CLOSED_DURING_LOAD = "plugin host closed during load";

/** 撤销实例时在途调用的默认排空时限（`extensionHost.drainSeconds` 的默认值）。 */
const DEFAULT_DRAIN_MS = 30_000;
/** 运行中重新加载时 setup 的默认时限（`extensionHost.reloadSetupTimeoutSeconds` 的默认值）。 */
const DEFAULT_RELOAD_SETUP_TIMEOUT_MS = 60_000;
/** 停机时等进行中的 unload / reload 的上限（之后直接关闭 setup 中的 ctx、撤销其余实例）。 */
const CLOSE_LIFECYCLE_WAIT_MS = 2_000;
/** 部署已知插件名（内置 / 配置声明 / 安装记录）缓存的有效期：路由闸门 503 / 404 用，跨副本靠它收敛。 */
const KNOWN_NAMES_TTL_MS = 5_000;

/** The load parameters of one extension ({@link ExtensionHost.reload} runs setup again with the same ones). */
interface InstanceSpec {
  manifest: ExtensionManifest;
  entryUrl: string;
  source: ExtensionSource;
  sha256: string | null;
  config: unknown;
  configHash: string;
  permissions: PermissionSet;
}

/**
 * 第 2 步里 `requires` 只能由安装记录满足的配置声明插件（C13 的遗留问题）：先挑出来，等安装记录加载完再解析。
 * 反复剔除直到不动点（剔除一个插件也拿掉了它提供的能力）。只有 `deferrable` 里的插件会被挑出。
 */
function splitDeferred(
  manifests: ExtensionManifest[],
  deferrable: Set<string>,
): { ready: ExtensionManifest[]; deferred: ExtensionManifest[] } {
  const deferred = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    const provided = new Set(
      manifests.filter((m) => !deferred.has(m.name)).flatMap((m) => m.provides),
    );
    for (const m of manifests) {
      if (deferred.has(m.name) || !deferrable.has(m.name)) continue;
      if ((m.requires ?? []).some((c) => !provided.has(c))) {
        deferred.add(m.name);
        changed = true;
      }
    }
  }
  return {
    ready: manifests.filter((m) => !deferred.has(m.name)),
    deferred: manifests.filter((m) => deferred.has(m.name)),
  };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 把 specifier 解析成模块文件 URL；失败时错误点名 specifier 与 resolveFrom。 */
function toFileUrl(spec: string, resolveFrom: string): string {
  try {
    if (spec.startsWith("file:")) return spec;
    if (isAbsolute(spec)) return pathToFileURL(spec).href;
    const file = createRequire(join(resolveFrom, "noop.js")).resolve(spec);
    return pathToFileURL(file).href;
  } catch (e) {
    throw new Error(`cannot resolve plugin "${spec}" from "${resolveFrom}": ${errMsg(e)}`, {
      cause: e,
    });
  }
}

interface ImportedEntry {
  manifest: ExtensionManifest;
  dir: string;
  /** 模块入口（`file:` URL）。 */
  url: string;
}

/** 按顺序导入各 specifier 的插件模块（不排序）；同时给出模块所在目录。 */
async function importEntries(specifiers: string[], resolveFrom: string): Promise<ImportedEntry[]> {
  const entries: ImportedEntry[] = [];
  for (const spec of specifiers) {
    const url = toFileUrl(spec, resolveFrom);
    entries.push({
      manifest: await importExtensionModule(url, spec, resolveFrom),
      dir: dirname(fileURLToPath(url)),
      url,
    });
  }
  return entries;
}

/**
 * 内置插件与配置声明的插件重名时以内置为准（F-AK）：返回去掉重名项后的配置项，重名项逐个告警。
 */
function dropShadowed(
  config: ImportedEntry[],
  builtin: ImportedEntry[],
  log: { warn(msg: string, fields?: Record<string, unknown>): void },
): ImportedEntry[] {
  const names = new Set(builtin.map((e) => e.manifest.name));
  return config.filter((e) => {
    if (!names.has(e.manifest.name)) return true;
    log.warn(
      "plugin is built in; ignoring the same extension in the extensions config list (remove it from the list)",
      { plugin: e.manifest.name },
    );
    return false;
  });
}

/**
 * The `name` (npm package name) of the nearest `package.json` above the module's directory; undefined
 * when there is none. Builtin / config-declared extensions register their name ownership with it
 * (`extension_name_owners`, I4).
 */
async function packageNameOf(dir: string): Promise<string | undefined> {
  for (let d = resolvePath(dir); ; ) {
    try {
      const pj = JSON.parse(await readFile(join(d, "package.json"), "utf8")) as { name?: unknown };
      if (typeof pj.name === "string" && pj.name !== "") return pj.name;
    } catch {
      // 没有或读不了：继续往上
    }
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/** One item of {@link ExtensionHost.inspect}. */
export interface InspectedExtension {
  /** 内置插件（`opts.builtin`）预先批准，不进审批（C14）；其余为配置声明。 */
  source: "builtin" | "config";
  manifest: ExtensionManifest;
  /** 插件模块所在目录（`migrations` 相对它解析）。 */
  dir: string;
  /** 规范化的权限集合，见 {@link computePermissionSet}。 */
  permissions: PermissionSet;
}

/** 计算各插件的权限集合（按插件名索引）。 */
async function permissionSets(
  ordered: ExtensionManifest[],
  dirs: Map<string, string>,
): Promise<Map<string, PermissionSet>> {
  const sets = new Map<string, PermissionSet>();
  for (const m of ordered) {
    sets.set(m.name, await computePermissionSet(m, dirs.get(m.name) as string));
  }
  return sets;
}

/** 待批准插件的 warn 日志：点名插件、原因与新增项（依赖原因写明阻塞的能力与提供方）。 */
function warnPending(log: KernelDeps["log"], p: PendingExtension): void {
  if (p.reason === "dependency") {
    const missing = (p.blockedBy ?? []).some((b) => b.providers.length === 0);
    log.warn(
      missing
        ? "plugin not loaded: an extension point it needs has no provider (e.g. permissions.storage needs an object-store@1 plugin such as object-store-s3)"
        : "plugin not loaded: a required extension point is only provided by plugins awaiting permission approval",
      { plugin: p.plugin, version: p.version, blockedBy: p.blockedBy },
    );
    return;
  }
  log.warn(
    "plugin not loaded: permissions awaiting approval (an enterprise admin approves it in the admin console, or run `capybara plugins review`, then `capybara plugins approve <name>`; running replicas load it without a restart)",
    { plugin: p.plugin, version: p.version, reason: p.reason, added: p.added, removed: p.removed },
  );
}

/**
 * 跑单个插件的迁移（`migrationsDir` 为迁移目录的绝对路径；没有迁移时为 undefined）；返回已应用的文件，
 * 无迁移时返回 undefined。迁移器在会话上持有按 schema 的咨询锁：多副本同时启动时只有一个在执行，其余等它结束后
 * 发现都已应用。
 */
async function migratePlugin(
  dbUrl: string,
  manifest: ExtensionManifest,
  migrationsDir: string | undefined,
  connectTimeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<{ schema: string; applied: string[] } | undefined> {
  if (!migrationsDir) return undefined;
  const schema = pluginSchemaName(manifest.name);
  try {
    const { applied } = await migrate(
      dbUrl,
      { schema, dir: migrationsDir },
      { connectTimeoutMs, signal },
    );
    return { schema, applied };
  } catch (e) {
    throw new Error(`plugin ${manifest.name}: migration failed: ${errMsg(e)}`, { cause: e });
  }
}

/**
 * 插件两级配置 schema 中的每个 `secret()` 都必须标在对象路径的字段上（见 `unreachableSecrets`），
 * 否则内核无法把它单独加密存储 / 打码、会按明文保存与回显——此时拒绝加载并点名插件与路径。
 */
export function assertSecretsReachable(manifest: ExtensionManifest): void {
  for (const level of ["deployment", "org"] as const) {
    const schema = manifest.config?.[level];
    if (!schema) continue;
    const bad = unreachableSecrets(schema);
    if (bad.length > 0) {
      throw new Error(
        `plugin ${manifest.name}: config.${level}: ${bad.map((p) => `secret() at "${p}"`).join(", ")} is not on an object field path; secret() inside union / intersection / transform / pipe / lazy / array / record / tuple is not supported — mark the whole enclosing object field secret instead`,
      );
    }
  }
}

/** 按模块解析的插件（内置 / 配置声明）的迁移目录：清单 `migrations` 相对模块所在目录。 */
const migrationsDirOf = (m: ExtensionManifest, dir: string): string | undefined =>
  m.migrations ? resolvePath(dir, m.migrations) : undefined;

/**
 * The load entry for install records (C13 / C16): the records desired enabled, syncing to local disk
 * (returns the entry URL) and migrating under the lock. Implemented by the kernel with
 * `ExtensionInstalls` + `syncPackage` + `ensureMigrated`; the host calls it only after the builtin and
 * config-declared extensions have loaded (the package may be in object storage, so the object-store
 * extension must be ready).
 */
export interface InstalledExtensionLoader {
  desired(): Promise<DesiredExtension[]>;
  sync(d: DesiredExtension): Promise<string>;
  /**
   * 该包的迁移（`dir` 为审阅过的 `capybara.migrations` 的绝对路径，没有迁移时为 undefined）：
   * 已迁移或本副本持锁迁移完成 → `migrated`；别的副本正在迁移 → `busy`（记 pending / migration，等
   * `plugins.migrated` 或下一个周期）；迁移出错时抛出。见 `ensureMigrated`。`signal` 在宿主关闭时中止（结束迁移会话）。
   */
  migrate(
    d: DesiredExtension,
    dir: string | undefined,
    signal: AbortSignal,
  ): Promise<"migrated" | "busy">;
}

/**
 * 安装记录加载失败的原因（写进副本状态行的 `reason`，`detail` 只写错误消息）：同步失败、包字节与 sha256 不符、
 * 导入失败、模块清单与审阅过的静态清单不符、setup 失败、迁移失败。
 */
export type InstallFailureReason =
  | "sync_failed"
  | "sha_mismatch"
  | "import_failed"
  | "manifest_mismatch"
  | "setup_failed"
  | "migration_failed";

/** One item of {@link ExtensionHost.declaredPlugins}. */
export interface DeclaredExtensionInfo {
  name: string;
  source: "builtin" | "config";
  version: string;
  permissions: PermissionSet;
  /** 清单有部署级配置 schema。 */
  configurable: boolean;
  /** 启动配置里的部署配置按 schema 校验通过（没有 schema 时恒为 true）。 */
  configValid: boolean;
}

/** The extension sources of {@link ExtensionHost.load}, loaded in this order (see {@link ExtensionSource}). */
export interface ExtensionLoadPlan {
  /** 内置插件（模块 specifier，建议 `file:` URL）：预先批准、始终启用。 */
  builtin?: string[];
  /** The startup config `extensions` list. */
  config?: string[];
  /** 安装记录。 */
  installs?: InstalledExtensionLoader;
}

/** The load parameters of one extension (internal to {@link ExtensionHost}). */
interface Activation {
  manifest: ExtensionManifest;
  source: ExtensionSource;
  sha256: string | null;
  /** 模块入口（`file:` URL）。 */
  entryUrl: string;
  migrationsDir: string | undefined;
  set: PermissionSet;
  decision: ApprovalDecision;
  /** 内置 / 配置声明的插件出错直接抛（内核启动失败）；安装记录只记 failed，其余照常。 */
  fatal: boolean;
  /** Install records: migrate under the lock (see {@link InstalledExtensionLoader.migrate}) instead of migrating under the schema lock directly. */
  migrate?: () => Promise<"migrated" | "busy">;
  /**
   * 安装记录：`manifest` 只是审阅过的静态清单（{@link manifestOfSection}），权限闸门放行之后才调用它导入真实模块
   * 并核对静态清单（不一致抛 {@link ManifestMismatchError}）。批准之前不执行插件的任何代码（含模块顶层代码）。
   */
  importModule?: () => Promise<ExtensionManifest>;
}

/**
 * 安装记录准备好的加载候选（同步、按静态清单与迁移 SQL 算权限之后；不导入模块；同一个包结果不变，按 sha 缓存）。
 * `manifest` 是静态清单（{@link manifestOfSection}），只供依赖解析与权限闸门用。
 */
interface InstallCandidate {
  d: DesiredExtension;
  manifest: ExtensionManifest;
  set: PermissionSet;
  entryUrl: string;
  /** 包根目录（解包后的 `package/`）。 */
  root: string;
  migrationsDir: string | undefined;
}

/**
 * 由审阅过的静态清单拼出解析依赖、判定权限闸门用的清单（没有 setup 与配置 schema，不能用来加载）。
 * 闸门放行后导入的真实模块必须与静态清单一致（{@link matchesSection}），两者在依赖解析上等价。
 */
function manifestOfSection(m: StaticExtensionManifest): ExtensionManifest {
  return {
    name: m.name,
    version: m.version,
    sdk: m.sdk,
    provides: m.provides,
    requires: m.requires,
    optional: m.optional,
    permissions: m.permissions,
    ...(m.ui !== undefined && { ui: m.ui }),
    setup() {
      throw new Error(`plugin ${m.name}: static manifest cannot be set up`);
    },
  } as unknown as ExtensionManifest;
}

/** 内核消费的提供方能力：调用计入提供方实例的在途计数（撤销 / 升级时排空，C17）。 */
const TRACKED_EXTENSION_POINTS: Record<string, TrackOptions> = {
  connector: { sessions: ["open"] },
  sandbox: {},
  "model-provider": {},
};

/** 插件宿主：解析、校验配置、迁移、setup，并登记插件提供的能力与路由。 */
export class ExtensionHost {
  /**
   * Only resolves extensions and runs migrations in dependency order: no deployment config check, no
   * setup, no Redis (for `capybara migrate`). Like `load()` it checks secret markers first
   * (`assertSecretsReachable`); if any extension has a problem, none is migrated.
   * Returns every extension that declares migrations, with the files applied this time.
   * The same permission snapshot gate as `load()`: extensions pending approval (and those whose
   * `requires` only they satisfy) are not migrated and are reported through `onPending`; needs the
   * kernel migrations to have run (reads `extension_permission_snapshots`). With `autoApprove` all are
   * migrated and no snapshot is written (`load()` writes snapshots).
   * `opts.builtin`: builtin extensions (pre-approved, skip the gate; on a name clash with the config
   * list the builtin wins).
   */
  static async migrateOnly(
    specifiers: string[],
    opts: {
      dbUrl: string;
      resolveFrom?: string;
      connectTimeoutMs?: number;
      autoApprove?: boolean;
      builtin?: string[];
      onPending?: (pending: PendingExtension[]) => void;
      log?: { warn(msg: string, fields?: Record<string, unknown>): void };
    },
  ): Promise<{ plugin: string; schema: string; applied: string[] }[]> {
    const from = resolvePath(opts.resolveFrom ?? process.cwd());
    const builtin = await importEntries(opts.builtin ?? [], from);
    const entries = [
      ...builtin,
      ...dropShadowed(await importEntries(specifiers, from), builtin, opts.log ?? { warn() {} }),
    ];
    const dirs = new Map(entries.map((e) => [e.manifest.name, e.dir]));
    const ordered = resolveExtensions(
      entries.map((e) => e.manifest),
      SDK_VERSION,
    );
    const builtinNames = new Set(builtin.map((e) => e.manifest.name));
    for (const manifest of ordered) assertSecretsReachable(manifest);
    let toMigrate = ordered;
    if (!opts.autoApprove && ordered.length > 0) {
      const sets = await permissionSets(ordered, dirs);
      const raw = createDb(opts.dbUrl, 1, () => {}, { connectTimeoutMs: opts.connectTimeoutMs });
      let decisions: ApprovalDecision[];
      try {
        const snapshots = withPreApproved(
          await new ExtensionApprovals(kernelDb(raw)).all(),
          ordered.filter((m) => builtinNames.has(m.name)),
          sets,
        );
        decisions = planApprovals(ordered, sets, snapshots);
      } finally {
        await raw.destroy();
      }
      const pending = decisions.flatMap((d) => (d.action === "pending" ? [d.pending] : []));
      if (pending.length > 0) opts.onPending?.(pending);
      const skip = new Set(pending.map((p) => p.plugin));
      toMigrate = ordered.filter((m) => !skip.has(m.name));
    }
    const out: { plugin: string; schema: string; applied: string[] }[] = [];
    for (const manifest of toMigrate) {
      const r = await migratePlugin(
        opts.dbUrl,
        manifest,
        migrationsDirOf(manifest, dirs.get(manifest.name) as string),
        opts.connectTimeoutMs,
      );
      if (r) out.push({ plugin: manifest.name, ...r });
    }
    return out;
  }

  /**
   * 只导入、校验并按依赖排序插件，计算各自的权限集合；不迁移、不调用 setup、不连数据库与 Redis
   * （供 `capybara plugins review / approve`）。返回依赖拓扑序。
   */
  static async inspect(
    specifiers: string[],
    opts: { resolveFrom?: string; builtin?: string[] } = {},
  ): Promise<InspectedExtension[]> {
    const from = resolvePath(opts.resolveFrom ?? process.cwd());
    const builtin = await importEntries(opts.builtin ?? [], from);
    // 与 load() 一样：与内置插件重名的配置项以内置为准（不告警：只读检查）
    const entries = [
      ...builtin,
      ...dropShadowed(await importEntries(specifiers, from), builtin, { warn() {} }),
    ];
    const dirs = new Map(entries.map((e) => [e.manifest.name, e.dir]));
    const ordered = resolveExtensions(
      entries.map((e) => e.manifest),
      SDK_VERSION,
    );
    const builtinNames = new Set(builtin.map((e) => e.manifest.name));
    for (const manifest of ordered) assertSecretsReachable(manifest);
    const sets = await permissionSets(ordered, dirs);
    return ordered.map((manifest) => ({
      source: builtinNames.has(manifest.name) ? "builtin" : "config",
      manifest,
      dir: dirs.get(manifest.name) as string,
      permissions: sets.get(manifest.name) as PermissionSet,
    }));
  }

  /** 本进程生效的插件实例（C17）：消费方每次实时取，不缓存实现对象。 */
  private readonly registry = new ExtensionRegistry();
  /**
   * M-1: plugin → mount points where deployment state expects `policy` hooks. A per-replica copy of PG
   * deployment state (like the registry), rebuilt on every load / converge, never written elsewhere.
   */
  private policyExpected = new Map<string, readonly string[]>();
  /**
   * Runs the hooks of this process's active plugin instances (resolved from the registry on every
   * call, so an upgrade fires only the new generation; calls go through each instance's in-flight
   * tracker and are drained on revocation). Organization enablement is {@link enabledPlugins}.
   */
  readonly hooks: HookRegistry;
  /** 加载成功过的插件的加载参数（同进程重新加载用；撤销后保留，`unavailable` 据此判断）。 */
  private readonly specs = new Map<string, InstanceSpec>();
  /** 因必需能力没了而随提供方卸下的插件：提供方回来后重新加载。 */
  private readonly unloadedForDependency = new Set<string>();
  /** 每个插件已产生的实例代数。 */
  private readonly generations = new Map<string, number>();
  /** 本进程导入过的模块入口（不同入口数超过阈值时告警：旧代码留在内存直到重启）。 */
  private readonly imports = new ImportTracker();
  /** 串行化 unload / reload（同一时刻只做一件，依赖方的连锁处理不交错）。 */
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly drainMs: () => number;
  private readonly disposeTimeoutMs: () => number;
  private readonly reloadSetupTimeoutMs: () => number;
  private readonly installedNames: (() => Promise<string[]>) | undefined;
  /** 安装记录里的插件名缓存（TTL + 注册表变化时作废）。 */
  private installedCache: { at: number; names: Promise<Set<string>> } | undefined;
  /** 本次因权限待批准（或依赖待批准插件）而未加载的插件。 */
  private readonly pendingPlugins: PendingExtension[] = [];
  /**
   * 待批准（或运行中加载失败）的内置 / 配置声明插件的加载参数：{@link activatePending} / {@link converge} 据此重试。
   * 安装记录不在这里：每次 converge 都按 PG 期望状态重新判定。
   */
  private readonly pendingActivations = new Map<string, Activation>();
  /** 安装记录准备好的候选（按插件名；sha 变了就作废）。 */
  private readonly prepared = new Map<string, InstallCandidate>();
  /** 闸门放行后导入过的安装记录真实清单（按插件名；部署配置 schema 用，含待配置而未加载的）。 */
  private readonly importedManifests = new Map<
    string,
    { sha256: string; manifest: ExtensionManifest }
  >();
  /** 本副本写过状态行的安装记录插件（停用 / 卸载后把未加载的那行标为 unloaded）。 */
  private readonly installRows = new Map<string, { version: string; sha256: string }>();
  /** 启用的安装记录按静态清单声明提供的能力（最近一次 {@link applyInstalls}；待定插件的 blockedBy 用）。 */
  private installProvides = new Map<ExtensionPointRef, string[]>();
  /** 已记过 error 日志的加载失败（插件名 → `<sha>:<原因>`；加载成功后清掉）。 */
  private readonly loggedFailures = new Map<string, string>();
  /** 已告警过的「安装记录与内置 / 配置声明重名」（每个名字只告警一次）。 */
  private readonly warnedConflicts = new Set<string>();
  /** 升级时被替换、后台排空中的旧实例（close() 等它们，最多 lifecycleWaitMs）。 */
  private readonly retiring = new Map<ExtensionInstance, Promise<void>>();
  /** 内置与配置声明插件的清单与权限集合（含未加载的；后台列表与网页批准用）。 */
  private readonly declaredInfo = new Map<
    string,
    { source: "builtin" | "config"; manifest: ExtensionManifest; set: PermissionSet }
  >();
  /** 导入过的插件名 → 来源与包（含未加载的；重名被跳过的一方不在这里）。 */
  private readonly sources = new Map<string, { source: ExtensionSource; sha256: string | null }>();
  private didLoad = false;
  /** load() 的安装记录入口（{@link converge} 据此按 PG 期望状态收敛）。 */
  private installLoader: InstalledExtensionLoader | undefined;
  private closed = false;
  /** close() 时中止进行中的插件迁移。 */
  private readonly abort = new AbortController();
  /** 进行中的插件迁移（close() 等它结束，保证迁移连接不比宿主活得久）。 */
  private migrating: Promise<unknown> | undefined;
  /** 已创建、尚未登记（setup 进行中）的 ctx：close() 时立即关闭，不等 setup 返回。 */
  private settingUp: KernelExtensionContext | undefined;
  private readonly resolveFrom: string;
  private readonly onSecrets: ((values: string[]) => void) | undefined;
  private readonly autoApprove: boolean;
  private readonly status: ReplicaStatusStore | undefined;
  private readonly storedConfig:
    | ((plugin: string, fileValue: unknown, schema: core.$ZodType | undefined) => Promise<unknown>)
    | undefined;
  /** 内置 / 配置声明插件的部署配置最近一次判定是否合法（后台列表用；没判定过时按启动配置校验）。 */
  private readonly configValidity = new Map<string, boolean>();
  /** 已告警过的「部署配置不合法」（插件名 → 说明；每个周期都会重新判定，同一说明只告警一次）。 */
  private readonly configWarned = new Map<string, string>();

  /**
   * @param opts.resolveFrom The directory bare package names are resolved from, default
   * `process.cwd()`; a relative path is made absolute against the cwd at construction.
   * Absolute paths and `file:` URL extension specifiers are used as they are;
   * bare package names are resolved with `createRequire(<resolveFrom>/noop.js).resolve`, so an
   * extension package's exports must expose the `default` (or `require`) condition.
   * @param opts.autoApprove Approve extension permissions automatically (config
   * `extensionPermissions.autoApprove`, development and trials only): extensions needing approval write a
   * snapshot with source auto and load as usual. Default false: extensions pending approval do not
   * load (see {@link pending}).
   * @param opts.status This replica's load status table (`extension_replica_status`): every
   * extension's load result writes a row.
   */
  constructor(
    private readonly deps: KernelDeps,
    private readonly extensionConfig: Record<string, unknown> = {},
    opts: {
      resolveFrom?: string;
      onSecrets?: (values: string[]) => void;
      autoApprove?: boolean;
      status?: ReplicaStatusStore;
      /** 撤销实例时在途调用的排空时限（毫秒），默认 30s；内核传 `extensionHost.drainSeconds`。 */
      drainMs?: () => number;
      /** 插件 `dispose()` 的时限（毫秒），默认 10s；内核传 `extensionHost.disposeTimeoutSeconds`。 */
      disposeTimeoutMs?: () => number;
      /** 运行中重新加载时 setup 的时限（毫秒），默认 60s；内核传 `extensionHost.reloadSetupTimeoutSeconds`。 */
      reloadSetupTimeoutMs?: () => number;
      /** Hook time limit in milliseconds, default 5 s; the kernel passes `hooks.timeoutMs` (hot). */
      hookTimeoutMs?: () => number;
      /**
       * 安装记录里的插件名（T11 安装记录，任何 desired_state）：与内置、配置声明的一起构成「部署已知」的插件，
       * 不在本副本生效时它们的路由返回 503，完全未知的名字 404。缓存 {@link KNOWN_NAMES_TTL_MS}。
       */
      installedNames?: () => Promise<string[]>;
      /**
       * The extension's effective deployment config (C10): the startup config (`fileValue`, file /
       * Nacos merged with env) plus the fields stored in PG
       * (`ExtensionDeploymentConfigService.effective`), not validated yet. Without it only the startup
       * config is used.
       */
      deploymentConfig?: (
        plugin: string,
        fileValue: unknown,
        schema: core.$ZodType | undefined,
      ) => Promise<unknown>;
    } = {},
  ) {
    this.storedConfig = opts.deploymentConfig;
    this.drainMs = opts.drainMs ?? (() => DEFAULT_DRAIN_MS);
    this.disposeTimeoutMs = opts.disposeTimeoutMs ?? (() => DEFAULT_DISPOSE_TIMEOUT_MS);
    this.reloadSetupTimeoutMs =
      opts.reloadSetupTimeoutMs ?? (() => DEFAULT_RELOAD_SETUP_TIMEOUT_MS);
    this.installedNames = opts.installedNames;
    const hookTimeoutMs = opts.hookTimeoutMs ?? (() => DEFAULT_HOOK_TIMEOUT_MS);
    this.hooks = new HookRegistry({
      instances: () => this.registry.all(),
      current: (plugin) => this.registry.current(plugin),
      expectedPolicy: (mount) => this.expectedPolicy(mount),
      enabledPlugins: (orgId) => this.enabledPlugins(orgId),
      redis: deps.redis,
      config: () => ({ hooks: { timeoutMs: hookTimeoutMs() } }),
      log: deps.log,
    });
    this.registry.onChange(() => {
      this.installedCache = undefined;
    });
    this.onSecrets = opts.onSecrets;
    this.autoApprove = opts.autoApprove === true;
    this.resolveFrom = resolvePath(opts.resolveFrom ?? process.cwd());
    this.status = opts.status;
  }

  /**
   * Imports each extension module (default export) and initializes them in dependency order; may be
   * called only once. An array is the same as `{ config: [...] }`.
   *
   * Order (C14 / C15 / C13):
   * 1. Builtin extensions: pre-approved (no comparison, no permission snapshot), always enabled; an
   *    invalid deployment config means not loaded, recorded `pending` (reason config), and the kernel
   *    starts as usual. On a name clash with the config list the builtin wins, with a warning.
   * 2. Config-declared extensions: not loaded while pending approval; an invalid deployment config is
   *    recorded `pending` like builtins (reason config, C10) and the kernel starts as usual; a failed
   *    migration or setup throws and the kernel fails to start.
   *    When an extension point in `requires` did not load because its provider is pending
   *    configuration or similar, it is recorded pending (dependency) and converge loads it once the
   *    provider has loaded.
   * Deployment config = the startup config (`extensionConfig`) plus the fields stored in PG (constructor
   *    parameter `deploymentConfig`, C10).
   *    1 and 2 are resolved and ordered together; a config-declared extension whose `requires` can
   *    only be satisfied by an install record is set aside and resolved and loaded after step 3
   *    together with the loaded extensions (step 4; still unsatisfied -> it throws as before).
   * 3. Install records (`plan.installs`): synced to local disk, the permission set computed from the
   *    reviewed static manifest and migration SQL, dependencies resolved together with the existing
   *    extensions, then the same permission gate in topological order; only after passing is the module
   *    imported and the static manifest checked (name and `capybara.manifest` must both match,
   *    otherwise failed / manifest_mismatch), so no extension code runs before approval; migration
   *    directories come only from the reviewed `capybara.migrations`; a failure at any step only marks
   *    that extension failed (or pending), the rest go on. On a name clash with a builtin /
   *    config-declared extension the latter wins, with a warning.
   * Every extension's result is written to this replica's `extension_replica_status` (when `status`
   * was given at construction).
   * Instances that loaded are registered in the registry (C17): from then on {@link unload} /
   * {@link reload} revoke or reload them in this process.
   *
   * When a builtin / config-declared extension's (trusted) setup never returns, load() (and so the
   * kernel's `start()`) hangs forever: the kernel sets no timeout for them; `close()` / the kernel's
   * `stop()` still close that extension's ctx right away and free its resources. Install records are
   * not trusted: at startup their setup is also limited by `extensionHost.reloadSetupTimeoutSeconds`
   * (timeout -> failed / setup_failed) and migrations by `extensionHost.migrationTimeoutSeconds` (see
   * `ensureMigrated`).
   * When the host is `close()`d during load: running migrations are aborted, the ctx in setup is closed
   * right away (its queue's define / add then throw `queue is closed`), and load() throws
   * `plugin host closed during load` at the next checkpoint.
   */
  async load(plan: string[] | ExtensionLoadPlan): Promise<void> {
    if (this.closed) throw new Error(CLOSED_DURING_LOAD);
    if (this.didLoad) throw new Error("plugin host already loaded; load() may be called once");
    this.didLoad = true;
    const p: ExtensionLoadPlan = Array.isArray(plan) ? { config: plan } : plan;
    this.installLoader = p.installs;
    const builtin = await importEntries(p.builtin ?? [], this.resolveFrom);
    const config = dropShadowed(
      await importEntries(p.config ?? [], this.resolveFrom),
      builtin,
      this.deps.log,
    );
    const entries = [...builtin, ...config];
    await this.claimNames(entries);
    const dirs = new Map(entries.map((e) => [e.manifest.name, e.dir]));
    const urls = new Map(entries.map((e) => [e.manifest.name, e.url]));
    // 有安装记录时：配置声明的插件若 requires 只能由安装记录满足，先挑出来，等安装记录加载完再解析与加载
    const { ready, deferred } = p.installs
      ? splitDeferred(
          entries.map((e) => e.manifest),
          new Set(config.map((e) => e.manifest.name)),
        )
      : { ready: entries.map((e) => e.manifest), deferred: [] };
    const ordered = resolveExtensions(ready, SDK_VERSION);
    for (const e of builtin) this.sources.set(e.manifest.name, { source: "builtin", sha256: null });
    for (const e of config) this.sources.set(e.manifest.name, { source: "config", sha256: null });

    for (const e of entries) assertSecretsReachable(e.manifest);

    const sets = await permissionSets(ordered, dirs);
    this.noteDeclared(ordered, sets);
    const approvals = new ExtensionApprovals(kernelDb(this.deps.db));
    if (this.autoApprove) {
      this.deps.log.warn(
        "extensionPermissions.autoApprove is ON: plugin permissions are approved automatically without review; never enable this in production",
      );
    }
    const snapshots: Map<string, PermissionSnapshot> =
      ordered.length > 0 || p.installs ? await approvals.all() : new Map();
    const builtinManifests = ordered.filter((m) => this.sourceOf(m.name) === "builtin");
    const decisions = new Map(
      planApprovals(ordered, sets, withPreApproved(snapshots, builtinManifests, sets), {
        autoApprove: this.autoApprove,
      }).map((d) => [d.plugin, d]),
    );

    for (const manifest of ordered) {
      await this.activate(approvals, {
        manifest,
        source: this.sourceOf(manifest.name) as ExtensionSource,
        sha256: null,
        entryUrl: urls.get(manifest.name) as string,
        migrationsDir: migrationsDirOf(manifest, dirs.get(manifest.name) as string),
        set: sets.get(manifest.name) as PermissionSet,
        decision: this.blockedByUnloaded(
          manifest,
          decisions.get(manifest.name) as ApprovalDecision,
        ),
        fatal: true,
      });
    }

    let installProviders = new Map<ExtensionPointRef, string[]>();
    let desired: DesiredExtension[] | undefined;
    if (p.installs) {
      // 与运行中的 reconcile 走同一条路径（{@link converge}）；启动时不做依赖方连锁
      try {
        desired = await p.installs.desired();
      } catch (e) {
        this.deps.log.error(
          "cannot read plugin install records; installed plugins are not loaded",
          {
            err: e,
          },
        );
      }
      if (desired) installProviders = await this.applyInstalls(p.installs, desired, true);
    }
    if (deferred.length > 0) {
      await this.loadDeferred(deferred, dirs, urls, snapshots, approvals, installProviders);
    }
    await this.refreshPolicyExpectations(p.installs ? desired : []);

    const orphans = Object.keys(this.extensionConfig).filter((k) => !this.sources.has(k));
    if (orphans.length > 0) {
      this.deps.log.warn("extensionConfig has keys for plugins that are not loaded", {
        keys: orphans,
      });
    }
  }

  /**
   * Builtin and config-declared extensions also take their name (I4, an addition to Ruling P3): the
   * name is inserted into `extension_name_owners` with its npm package name (left alone when present).
   * After it is removed from the config list, no other npm package can install an extension of the
   * same name and take over its data, secrets and approvals. A failed write only warns.
   */
  private async claimNames(entries: ImportedEntry[]): Promise<void> {
    const rows: { name: string; package_name: string }[] = [];
    for (const e of entries) {
      const pkg = await packageNameOf(e.dir);
      if (pkg === undefined) {
        this.deps.log.warn(
          "plugin module has no package.json name; its plugin name is not claimed",
          {
            plugin: e.manifest.name,
          },
        );
        continue;
      }
      rows.push({ name: e.manifest.name, package_name: pkg });
    }
    if (rows.length === 0) return;
    try {
      const kdb = kernelDb(this.deps.db);
      await kdb
        .insertInto("extension_name_owners")
        .values(rows)
        .onConflict((oc) => oc.column("name").doNothing())
        .execute();
      const owners = await kdb
        .selectFrom("extension_name_owners")
        .select(["name", "package_name"])
        .where(
          "name",
          "in",
          rows.map((r) => r.name),
        )
        .execute();
      for (const o of owners) {
        const mine = rows.find((r) => r.name === o.name);
        if (mine && mine.package_name !== o.package_name) {
          this.deps.log.warn(
            "plugin name is owned by a different npm package; the data, secrets and approval kept under this name came from that package",
            { plugin: o.name, owner: o.package_name, package: mine.package_name },
          );
        }
      }
    } catch (err) {
      this.deps.log.warn("cannot record plugin name owners", { err });
    }
  }

  /**
   * 启动时按拓扑序加载：权限闸门放行、但 `requires` 的能力此刻没有生效的提供方（提供方待配置等没加载成）→
   * 改为待定（dependency，blockedBy 点名待定的提供方），提供方加载后由 {@link converge} 一并加载。
   */
  private blockedByUnloaded(
    manifest: ExtensionManifest,
    decision: ApprovalDecision,
  ): ApprovalDecision {
    if (decision.action === "pending") return decision;
    const provided = new Set(this.registry.all().flatMap((i) => [...i.provided.keys()]));
    const missing = (manifest.requires ?? []).filter((c) => !provided.has(c));
    if (missing.length === 0) return decision;
    return {
      plugin: manifest.name,
      action: "pending",
      pending: {
        plugin: manifest.name,
        version: manifest.version,
        added: decision.added,
        removed: decision.removed,
        reason: "dependency",
        blockedBy: missing.map((extensionPoint) => ({
          extensionPoint,
          providers: [...this.pendingActivations.values()]
            .filter((p) => p.manifest.provides.includes(extensionPoint))
            .map((p) => p.manifest.name),
        })),
      },
    };
  }

  /**
   * 插件此刻的部署配置（未校验）：启动配置补上 PG 里保存的字段（C10，见构造参数 `deploymentConfig`）。
   */
  private async rawConfigOf(name: string, schema: core.$ZodType | undefined): Promise<unknown> {
    const fileValue = this.extensionConfig[name];
    if (!this.storedConfig) return fileValue ?? {};
    return this.storedConfig(name, fileValue, schema);
  }

  /** 把一份已校验部署配置里的密钥值交给 onSecrets（日志打码）。 */
  private reportSecrets(schema: core.$ZodType | undefined, config: unknown): void {
    if (!schema || !this.onSecrets) return;
    const values = secretValues(schema, config);
    if (values.length > 0) this.onSecrets(values);
  }

  /**
   * 安装记录收敛到 PG 期望状态（启动第 3 步与运行中的 {@link converge} 共用，C16）；`desired` 为期望启用的记录。
   * 1. 不再期望启用的（停用 / 卸载）：卸下（排空在途调用），未加载但写过状态行的标为 unloaded；
   * 2. 期望启用、本副本已在目标包上的：不动；
   * 3. 其余：准备候选（同步 → 按静态清单与迁移 SQL 算权限集合；失败记 failed：`sync_failed` / `sha_mismatch`），
   *    与生效的插件一起按依赖拓扑序逐个处理：权限闸门（新增权限待批准 → pending / approval，旧实例照常）、
   *    必需能力（此刻没有生效的提供方 → pending / dependency）、导入模块并核对静态清单（`import_failed` /
   *    `manifest_mismatch`；闸门放行之前不导入）、部署配置、
   *    持锁迁移（busy → pending / migration）、setup，成功后登记新实例（先加载新、再撤销旧：旧实例在后台排空后撤销）；
   *    任何一步失败旧实例保留，记 failed（`migration_failed` / `setup_failed`）。
   * 4. 运行中（非启动）：对变了的能力做依赖方连锁（本轮刚加载的除外），此前因依赖卸下的插件随之补回。
   * 返回启用的安装记录在静态清单里声明提供的能力（启动第 4 步据此判断待定还是缺提供方）。
   */
  private async applyInstalls(
    loader: InstalledExtensionLoader,
    desired: DesiredExtension[],
    startup: boolean,
  ): Promise<Map<ExtensionPointRef, string[]>> {
    const declared = this.declared();
    const installProviders = new Map<ExtensionPointRef, string[]>();
    const wanted = new Map<string, DesiredExtension>();
    for (const d of desired) {
      const taken = declared.get(d.name);
      if (taken) {
        if (!this.warnedConflicts.has(d.name)) {
          this.warnedConflicts.add(d.name);
          this.deps.log.warn(
            `plugin is both installed and ${taken === "builtin" ? "built in" : "declared in the extensions config list"}; using the ${taken} plugin`,
            { plugin: d.name, installedVersion: d.version },
          );
          // 该名字的状态行属于生效的一方，不覆盖；在它的 detail 里记下冲突（后台能看到）
          await this.noteStatus(
            d.name,
            `name_conflict: install record ${d.version} (${d.sha256.slice(0, 16)}) ignored; the ${taken} plugin of the same name is used`,
          );
        }
        continue;
      }
      wanted.set(d.name, d);
      // 按审阅过的静态清单（不论随后加载成败）
      for (const cap of d.section.manifest.provides as ExtensionPointRef[]) {
        installProviders.set(cap, [...(installProviders.get(cap) ?? []), d.name]);
      }
    }
    this.installProvides = installProviders;
    const drainMs = this.drainMs();
    const changed: ExtensionPointRef[] = [];

    // 1. 不再期望启用：卸下；未加载但写过状态行的标为 unloaded
    for (const inst of this.registry.all()) {
      if (inst.source !== "install" || wanted.has(inst.name)) continue;
      const gone = await this.doUnload(inst.name, drainMs, null);
      if (gone) changed.push(...gone.manifest.provides);
    }
    for (const [name, row] of [...this.installRows]) {
      if (wanted.has(name) || this.registry.current(name)) continue;
      this.dropPending(name);
      this.prepared.delete(name);
      this.importedManifests.delete(name);
      await this.writeStatus({
        plugin: name,
        version: row.version,
        sha256: row.sha256,
        source: "install",
        state: "unloaded",
        reason: null,
        detail: null,
      });
    }

    // 2 / 3. 需要换包或尚未加载的：准备候选
    const candidates: InstallCandidate[] = [];
    for (const d of wanted.values()) {
      if (this.closed) throw new Error(CLOSED_DURING_LOAD);
      if (this.registry.current(d.name)?.sha256 === d.sha256) continue;
      const c = await this.prepare(loader, d);
      if (c) candidates.push(c);
    }

    // 与生效的插件一起解析依赖：被替换的旧实例在新的被接受之前仍算提供方；解析不过的反复重试直到没有新的能加进来
    const accepted: InstallCandidate[] = [];
    const base = () => {
      const replaced = new Set(accepted.map((a) => a.d.name));
      return this.registry
        .all()
        .filter((i) => !replaced.has(i.name))
        .map((i) => i.manifest);
    };
    const tryResolve = (c: InstallCandidate) =>
      resolveExtensions(
        [
          ...base().filter((m) => m.name !== c.d.name),
          ...accepted.map((a) => a.manifest),
          c.manifest,
        ],
        SDK_VERSION,
      );
    let remaining = candidates;
    for (let progress = true; progress && remaining.length > 0; ) {
      progress = false;
      const next: InstallCandidate[] = [];
      for (const c of remaining) {
        try {
          tryResolve(c);
          accepted.push(c);
          progress = true;
        } catch {
          next.push(c);
        }
      }
      remaining = next;
    }
    for (const c of remaining) {
      let detail = "cannot resolve the plugin's dependencies";
      try {
        tryResolve(c);
      } catch (e) {
        detail = errMsg(e);
      }
      this.notePending({
        plugin: c.d.name,
        version: c.d.version,
        added: [],
        removed: [],
        reason: "dependency",
        blockedBy: (c.manifest.requires ?? []).map((extensionPoint) => ({
          extensionPoint,
          providers: (installProviders.get(extensionPoint) ?? []).filter((n) => n !== c.d.name),
        })),
      });
      await this.writeStatus({
        plugin: c.d.name,
        version: c.d.version,
        sha256: c.d.sha256,
        source: "install",
        state: "pending",
        reason: "dependency",
        detail,
      });
    }
    if (accepted.length === 0) {
      if (!startup && changed.length > 0) await this.cascade(changed, drainMs);
      return installProviders;
    }
    for (const c of accepted) this.sources.set(c.d.name, { source: "install", sha256: c.d.sha256 });

    // 4. 按拓扑序逐个：权限闸门 → 配置 → 迁移 → setup → 登记（替换旧实例）
    const order = resolveExtensions([...base(), ...accepted.map((a) => a.manifest)], SDK_VERSION);
    const byName = new Map(accepted.map((c) => [c.d.name, c]));
    const approvals = new ExtensionApprovals(kernelDb(this.deps.db));
    const snapshots = await approvals.all();
    const activated = new Set<string>();
    for (const m of order) {
      const c = byName.get(m.name);
      if (!c) continue;
      if (this.closed) throw new Error(CLOSED_DURING_LOAD);
      const a: Activation = {
        manifest: c.manifest,
        source: "install",
        sha256: c.d.sha256,
        entryUrl: c.entryUrl,
        migrationsDir: c.migrationsDir,
        set: c.set,
        decision: { plugin: m.name, action: "pending" } as unknown as ApprovalDecision,
        fatal: false,
        migrate: () => loader.migrate(c.d, c.migrationsDir, this.abort.signal),
        importModule: () => this.importInstalled(c),
      };
      a.decision = this.decidePending(m.name, a, snapshots, installProviders);
      const old = this.registry.current(m.name);
      // 安装记录不受信任：启动时 setup 同样限时（I3），挂住的 setup 不卡住内核启动；内置 / 配置声明的启动时不限
      const inst = await this.activate(approvals, a, this.reloadSetupTimeoutMs());
      if (inst) {
        activated.add(m.name);
        changed.push(...inst.manifest.provides, ...(old?.manifest.provides ?? []));
      }
    }
    if (!startup && changed.length > 0) await this.cascade(changed, drainMs, activated);
    return installProviders;
  }

  /**
   * 安装记录的加载候选：同步到本地 → 按审阅过的静态清单与包里的迁移 SQL 算权限集合（与审阅时的
   * `permissionSetOfPackage` 同一算法；迁移目录只取 `capybara.migrations`）。不导入模块：导入在权限闸门放行之后
   * （{@link importInstalled}）。失败记 failed（`sync_failed` / `sha_mismatch`，detail 只写错误消息）并返回
   * undefined。同一个包的结果不变，成功的按 sha 缓存（每个周期的 reconcile 不重复解包）。
   */
  private async prepare(
    loader: InstalledExtensionLoader,
    d: DesiredExtension,
  ): Promise<InstallCandidate | undefined> {
    const hit = this.prepared.get(d.name);
    if (hit && hit.d.sha256 === d.sha256) return { ...hit, d };
    this.prepared.delete(d.name);
    // 换了包：上一个包导入的真实清单作废（部署配置 schema 不能再按旧版本给）
    if (this.importedManifests.get(d.name)?.sha256 !== d.sha256)
      this.importedManifests.delete(d.name);
    const fail = async (reason: InstallFailureReason, e: unknown): Promise<undefined> => {
      this.logFailure(d.name, d.sha256, reason, e, { version: d.version });
      await this.writeStatus({
        plugin: d.name,
        version: d.version,
        sha256: d.sha256,
        source: "install",
        state: "failed",
        reason,
        detail: errMsg(e),
      });
      return undefined;
    };
    let url: string;
    let root: string;
    let set: PermissionSet;
    try {
      url = await loader.sync(d);
      root = packageRootOf(url, d.section.entry);
      set = permissionSetOfSection(d.section, await readMigrationSql(root, d.section));
    } catch (e) {
      const mismatch =
        e instanceof ExtensionBlobIntegrityError || e instanceof PackageShaMismatchError;
      return fail(mismatch ? "sha_mismatch" : "sync_failed", e);
    }
    const migrations = d.section.migrations;
    const c: InstallCandidate = {
      d,
      manifest: manifestOfSection(d.section.manifest),
      set,
      entryUrl: url,
      root,
      migrationsDir: migrations === undefined ? undefined : resolvePath(root, migrations),
    };
    this.prepared.set(d.name, c);
    return c;
  }

  /**
   * 权限闸门放行后导入安装记录的真实模块（模块顶层代码此时才执行）并核对：密钥标记、与审阅过的静态清单一致
   * （名字、版本、能力、权限、界面、配置字段；不一致抛 {@link ManifestMismatchError}）。同一入口 URL 由 Node 模块缓存，
   * 重复调用不重复执行顶层代码。导入限 `extensionHost.reloadSetupTimeoutSeconds`（与 setup 同一时限）：顶层代码
   * 永不结束时记 failed / import_failed，不卡住启动与 reconcile（挂住的模块留在内存里，下次导入同样超时）。
   */
  private async importInstalled(c: InstallCandidate): Promise<ExtensionManifest> {
    const ms = this.reloadSetupTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    const importing = importExtensionModule(c.entryUrl, c.d.name, c.root);
    importing.catch(() => {});
    const manifest = await Promise.race([
      importing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `plugin ${c.d.name}: importing its module did not finish within ${Math.round(ms / 1000)}s (extensionHost.reloadSetupTimeoutSeconds); its top-level code may never finish`,
              ),
            ),
          ms,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    assertSecretsReachable(manifest);
    if (!matchesSection(manifest, c.d.name, c.d.section.manifest)) {
      throw new ManifestMismatchError(c.d.name, manifest.name);
    }
    this.importedManifests.set(c.d.name, { sha256: c.d.sha256, manifest });
    return manifest;
  }

  /**
   * 安装记录加载失败的 error 日志：每个周期都会重试，同一个包、同一个原因只记一次（状态行每次照写）。
   */
  private logFailure(
    plugin: string,
    sha256: string | null,
    reason: InstallFailureReason,
    err: unknown,
    fields: Record<string, unknown>,
  ): void {
    const key = `${sha256}:${reason}`;
    if (this.loggedFailures.get(plugin) === key) return;
    this.loggedFailures.set(plugin, key);
    this.deps.log.error("installed plugin not loaded", { plugin, sha256, reason, err, ...fields });
  }

  /** 记下（替换同名的）待定插件，供 {@link pending} 列出。 */
  private notePending(p: PendingExtension): void {
    const at = this.pendingPlugins.findIndex((x) => x.plugin === p.plugin);
    if (at >= 0) this.pendingPlugins[at] = p;
    else this.pendingPlugins.push(p);
  }

  /** 从待定清单里去掉。 */
  private dropPending(plugin: string): void {
    const at = this.pendingPlugins.findIndex((x) => x.plugin === plugin);
    if (at >= 0) this.pendingPlugins.splice(at, 1);
  }

  /**
   * 第 4 步：第 2 步挑出来的配置声明插件（`requires` 只能由安装记录满足）。与已加载的插件一起解析依赖：
   * - 满足的按拓扑序走同一道权限闸门后加载（出错直接抛，与其他配置声明插件一致）；
   * - 缺的能力有启用的安装记录声明提供、只是它没加载成（待批准 / 失败）→ 待定（pending，原因 dependency），
   *   与「配置声明插件依赖待批准的配置声明插件」一致，内核照常启动；
   * - 缺的能力没有任何提供方 → 与此前一样抛错（内核启动失败）。
   */
  private async loadDeferred(
    deferred: ExtensionManifest[],
    dirs: Map<string, string>,
    urls: Map<string, string>,
    snapshots: Map<string, PermissionSnapshot>,
    approvals: ExtensionApprovals,
    installProviders: Map<ExtensionPointRef, string[]>,
  ): Promise<void> {
    if (this.closed) throw new Error(CLOSED_DURING_LOAD);
    const loaded = this.registry.all();
    const { ready, deferred: blocked } = splitDeferred(
      [...loaded.map((i) => i.manifest), ...deferred],
      new Set(deferred.map((m) => m.name)),
    );
    const deferredSets = await permissionSets(deferred, dirs);
    this.noteDeclared(deferred, deferredSets);
    const sets = new Map([...loaded.map((i) => [i.name, i.permissions] as const), ...deferredSets]);
    const blockedProvides = new Set(blocked.flatMap((m) => m.provides));
    const readyProvides = new Set(ready.flatMap((m) => m.provides));
    for (const m of blocked) {
      const missing = (m.requires ?? []).filter((c) => !readyProvides.has(c));
      if (missing.some((c) => !installProviders.has(c) && !blockedProvides.has(c))) {
        // No provider at all: throw as before (resolveExtensions names the extension and the extension point)
        resolveExtensions([...loaded.map((i) => i.manifest), ...deferred], SDK_VERSION);
      }
    }
    for (const m of blocked) {
      const blockedBy = (m.requires ?? [])
        .filter((c) => !readyProvides.has(c))
        .map((extensionPoint) => ({
          extensionPoint,
          providers: [
            ...(installProviders.get(extensionPoint) ?? []),
            ...blocked.filter((b) => b.provides.includes(extensionPoint)).map((b) => b.name),
          ],
        }));
      await this.activate(approvals, {
        manifest: m,
        source: "config",
        sha256: null,
        entryUrl: urls.get(m.name) as string,
        migrationsDir: migrationsDirOf(m, dirs.get(m.name) as string),
        set: sets.get(m.name) as PermissionSet,
        decision: {
          plugin: m.name,
          action: "pending",
          pending: {
            plugin: m.name,
            version: m.version,
            added: [],
            removed: [],
            reason: "dependency",
            blockedBy,
          },
        },
        fatal: true,
      });
    }
    const loadable = deferred.filter((m) => !blocked.includes(m));
    if (loadable.length === 0) return;
    const all = resolveExtensions([...loaded.map((i) => i.manifest), ...loadable], SDK_VERSION);
    const decisions = new Map(
      planApprovals(
        all,
        sets,
        withPreApproved(
          snapshots,
          loaded.map((i) => i.manifest),
          sets,
        ),
        { autoApprove: this.autoApprove },
      ).map((d) => [d.plugin, d]),
    );
    const names = new Set(loadable.map((m) => m.name));
    for (const manifest of all) {
      if (!names.has(manifest.name)) continue;
      await this.activate(approvals, {
        manifest,
        source: "config",
        sha256: null,
        entryUrl: urls.get(manifest.name) as string,
        migrationsDir: migrationsDirOf(manifest, dirs.get(manifest.name) as string),
        set: sets.get(manifest.name) as PermissionSet,
        // 同一批里的提供方可能刚记为待配置：依赖方改为待定，不让启动失败
        decision: this.blockedByUnloaded(
          manifest,
          decisions.get(manifest.name) as ApprovalDecision,
        ),
        fatal: true,
      });
    }
  }

  /** 给已有状态行补说明；失败只记 warn。 */
  private async noteStatus(plugin: string, detail: string): Promise<void> {
    if (!this.status) return;
    try {
      await this.status.note(plugin, detail);
    } catch (e) {
      this.deps.log.warn("cannot write plugin replica status", { plugin, err: e });
    }
  }

  /**
   * 写本副本的加载状态；失败只记 warn（状态是给后台看的，不影响加载）。这一行的版本没加载成（failed / pending）
   * 而本副本仍有别的版本在跑时，记下那个版本（`servingVersion`，后台同时显示「新版失败、旧版仍在服务」）。
   */
  private async writeStatus(s: ExtensionLoadStatus): Promise<void> {
    if (s.servingVersion === undefined && (s.state === "failed" || s.state === "pending")) {
      const cur = this.registry.current(s.plugin);
      s = {
        ...s,
        servingVersion:
          cur && (cur.sha256 !== s.sha256 || cur.version !== s.version) ? cur.version : null,
      };
    }
    if (s.source === "install") {
      if (s.state === "unloaded") this.installRows.delete(s.plugin);
      else this.installRows.set(s.plugin, { version: s.version, sha256: s.sha256 as string });
    }
    if (!this.status) return;
    try {
      await this.status.write(s);
    } catch (e) {
      this.deps.log.warn("cannot write plugin replica status", { plugin: s.plugin, err: e });
    }
  }

  /**
   * 加载一个插件：权限闸门结论、部署配置、迁移、setup、登记。`fatal` 时（内置 / 配置声明）出错直接抛；
   * 否则（安装记录）记 failed 后返回。部署配置不合法时（任何来源）只记 pending（reason config），不抛（C10）。
   * 已有同名实例时（升级）：新实例登记后旧实例才撤销（后台排空在途调用）；新实例没加载成时旧实例保持不变。
   * 返回新登记的实例（没有加载时返回 undefined）。
   */
  private async activate(
    approvals: ExtensionApprovals,
    a: Activation,
    setupTimeoutMs?: number,
  ): Promise<ExtensionInstance | undefined> {
    const { decision } = a;
    let manifest = a.manifest;
    const name = manifest.name;
    const base = { plugin: name, version: manifest.version, sha256: a.sha256, source: a.source };
    const failSoft = async (reason: InstallFailureReason, e: unknown): Promise<undefined> => {
      this.logFailure(name, a.sha256, reason, e, { version: manifest.version });
      await this.writeStatus({ ...base, state: "failed", reason, detail: errMsg(e) });
      return undefined;
    };
    // 安装记录：闸门放行之后才导入真实模块（I1：批准之前不执行插件代码）；待批准时只有静态清单，不读部署配置
    if (a.importModule && decision.action !== "pending") {
      try {
        manifest = await a.importModule();
      } catch (e) {
        if (this.closed) throw new Error(CLOSED_DURING_LOAD, { cause: e });
        return failSoft(
          e instanceof ManifestMismatchError ? "manifest_mismatch" : "import_failed",
          e,
        );
      }
    }
    const schema = manifest.config?.deployment;
    // 安装记录每次 converge 都按 PG 重新判定，不进 pendingActivations
    const retryLater = () => {
      if (a.source !== "install") this.pendingActivations.set(name, a);
    };
    const readConfig = !(a.importModule && decision.action === "pending");
    let raw: unknown;
    try {
      if (readConfig) raw = await this.rawConfigOf(name, schema);
    } catch (e) {
      if (this.closed) throw new Error(CLOSED_DURING_LOAD, { cause: e });
      // 读不到 PG 里保存的部署配置：按待配置处理，下次 reconcile 再试
      this.deps.log.error("cannot read the stored deployment config of plugin", {
        plugin: name,
        err: e,
      });
      retryLater();
      await this.writeStatus({
        ...base,
        state: "pending",
        reason: "config",
        detail: "cannot read the stored deployment config",
      });
      return undefined;
    }
    let config: unknown = raw;
    const parsed = readConfig ? schema?.safeParse(raw) : undefined;
    if (a.source !== "install") this.configValidity.set(name, parsed?.success ?? true);
    if (decision.action === "pending") {
      // 待批准：不校验配置、不迁移、不 setup；配置合法时仍登记其中的密钥，避免日志泄露
      if (parsed?.success) this.reportSecrets(schema, parsed.data);
      const before = this.pendingPlugins.find((p) => p.plugin === name);
      this.notePending(decision.pending);
      retryLater();
      // 每个周期都会重新判定：同一版本、同一原因只告警一次
      if (
        before?.version !== decision.pending.version ||
        before.reason !== decision.pending.reason
      ) {
        warnPending(this.deps.log, decision.pending);
      }
      const reason: PendingReason =
        decision.pending.reason === "dependency" ? "dependency" : "approval";
      await this.writeStatus({ ...base, state: "pending", reason, detail: null });
      return undefined;
    }
    this.dropPending(name);
    // 权限放行在部署配置之前记下（autoApprove 的快照不因待配置而缺失，后台不会把待配置显示成待批准）
    if (decision.changed) {
      if (decision.autoApprove) {
        await approvals.approve(name, manifest.version, a.set, { source: "auto" });
        this.deps.log.warn("plugin permissions auto-approved (extensionPermissions.autoApprove)", {
          plugin: name,
          version: manifest.version,
          added: decision.added,
        });
      } else {
        // 权限变少、不变（版本变了）或只多出视图（ui.view:*，不卡加载）：直接加载，快照跟上当前清单。
        // 补进视图不写审计（与 autoApprove 一样，Ruling A4），只记日志
        const updated = await approvals.refresh(name, manifest.version, a.set);
        const merged = decision.added.filter((k) => k.startsWith(UI_VIEW_KEY_PREFIX));
        if (updated && merged.length > 0 && blockingKeys(decision.added).length === 0) {
          this.deps.log.info("plugin ui views merged into the permission snapshot", {
            plugin: name,
            version: manifest.version,
            merged,
          });
        }
      }
    }
    if (schema && parsed) {
      if (!parsed.success) {
        // 只列路径与按 issue 类型生成的说明（不用 zod 的 message：自定义消息可能拼入输入值）
        const detail = toIssues(parsed.error)
          .map((i) => `${i.path || "<root>"}: ${i.message}`)
          .join("; ");
        // 待配置（C10）：内置、配置声明与安装记录都一样，内核照常启动；配置改好后下一次 reconcile 加载
        if (this.configWarned.get(name) !== detail) {
          this.configWarned.set(name, detail);
          this.deps.log.warn(
            "plugin not loaded: its deployment config is missing or invalid (set it in the admin console or the startup config; it loads without a restart)",
            { plugin: name, source: a.source, detail },
          );
        }
        retryLater();
        await this.writeStatus({ ...base, state: "pending", reason: "config", detail });
        return undefined;
      }
      this.configWarned.delete(name);
      config = parsed.data;
      this.reportSecrets(schema, config);
    }
    if (this.closed) throw new Error(CLOSED_DURING_LOAD);
    // 安装记录：一个副本持锁迁移（C16），别的副本正在迁移时待定、旧实例照常；内置 / 配置声明：按 schema 锁直接迁移
    const migrating: Promise<unknown> = a.migrate
      ? a.migrate()
      : migratePlugin(
          this.deps.dbUrl,
          manifest,
          a.migrationsDir,
          this.deps.connectTimeoutMs,
          this.abort.signal,
        );
    this.migrating = migrating;
    try {
      if ((await migrating) === "busy") {
        await this.writeStatus({
          ...base,
          state: "pending",
          reason: "migration",
          detail: "another replica is running this package's migrations",
        });
        return undefined;
      }
    } catch (e) {
      if (this.closed) throw new Error(CLOSED_DURING_LOAD, { cause: e });
      if (a.fatal) throw e;
      return failSoft("migration_failed", e);
    } finally {
      this.migrating = undefined;
    }
    if (this.closed) throw new Error(CLOSED_DURING_LOAD);
    const spec: InstanceSpec = {
      manifest,
      entryUrl: a.entryUrl,
      source: a.source,
      sha256: a.sha256,
      config,
      configHash: deploymentConfigHash(schema, config),
      permissions: a.set,
    };
    let inst: ExtensionInstance;
    try {
      inst = await this.setup(spec, setupTimeoutMs);
    } catch (e) {
      if (this.closed) throw new Error(CLOSED_DURING_LOAD, { cause: e });
      if (a.fatal) throw e;
      return failSoft("setup_failed", e);
    }
    if (this.closed) {
      await inst.dispose({ drainMs: 0 }).catch((err: unknown) => {
        this.deps.log.warn("plugin context close failed", { plugin: name, err });
      });
      throw new Error(CLOSED_DURING_LOAD);
    }
    // 升级：替换加载参数（之后的依赖方连锁与 reload 用新版本），先登记新实例、再撤销旧实例
    this.specs.set(name, spec);
    this.unloadedForDependency.delete(name);
    const old = this.registry.activate(inst);
    this.loggedFailures.delete(name);
    await this.writeStatus({ ...base, state: "loaded", reason: null, detail: null });
    if (old) this.retire(old);
    return inst;
  }

  /**
   * 后台撤销被替换的旧实例（排空在途调用，最多 `extensionHost.drainSeconds`）：不挡住本副本后续的生命周期操作。
   * close() 等它们（最多 lifecycleWaitMs）。
   */
  private retire(old: ExtensionInstance): void {
    const p = this.disposeQuietly(old, this.drainMs()).finally(() => {
      this.retiring.delete(old);
      this.deps.log.info("previous plugin instance retired", {
        plugin: old.name,
        generation: old.generation,
      });
    });
    this.retiring.set(old, p);
  }

  /** 记下内置 / 配置声明插件的清单与权限集合（安装记录不在这里）。 */
  private noteDeclared(manifests: ExtensionManifest[], sets: Map<string, PermissionSet>): void {
    for (const m of manifests) {
      const source = this.sourceOf(m.name);
      if (source !== "builtin" && source !== "config") continue;
      this.declaredInfo.set(m.name, {
        source,
        manifest: m,
        set: sets.get(m.name) as PermissionSet,
      });
    }
  }

  /**
   * 内置与配置声明的插件（含待批准、待配置而未加载的）：权限集合（{@link computePermissionSet}）、
   * 部署配置此刻是否合法（按清单的 deployment schema 校验启动配置）。按导入顺序。
   */
  declaredPlugins(): DeclaredExtensionInfo[] {
    return [...this.declaredInfo].map(([name, d]) => {
      const schema = d.manifest.config?.deployment;
      return {
        name,
        source: d.source,
        version: d.manifest.version,
        permissions: d.set,
        configurable: schema !== undefined,
        configValid:
          this.configValidity.get(name) ??
          (schema ? schema.safeParse(this.extensionConfig[name] ?? {}).success : true),
      };
    });
  }

  /**
   * 在本副本加载此刻能加载的待定内置 / 配置声明插件（批准之后，或运行中加载失败后的重试），见 {@link converge}。
   * 与 unload / reload 串行。返回本次加载的插件名。
   */
  activatePending(): Promise<string[]> {
    return this.serial(() => this.activatePendingNow());
  }

  /**
   * 本副本收敛到部署的期望状态（T14 reconcile 的一步，与 unload / reload 串行）：
   * 1. 待定的内置 / 配置声明插件（批准后、或运行中加载失败的）按此刻的快照与生效的提供方重试；
   * 2. 安装记录按 PG 期望状态收敛（见 {@link applyInstalls}：停用 / 卸载的卸下，换包的先加载新再撤销旧，
   *    失败的每次重试），之后做依赖方连锁；
   * 3. 再试一次第 1 步（安装记录提供的能力可能放行了依赖它的配置声明插件）。
   * 读不到安装记录时只做第 1 步并抛错（调用方记日志，下一个周期再来）。
   */
  converge(): Promise<void> {
    return this.serial(async () => {
      await this.activatePendingNow();
      const loader = this.installLoader;
      if (!loader) return;
      const desired = await loader.desired();
      // N-2: drop plugins no longer desired before applyInstalls unloads them (the drain can take
      // extensionHost.drainSeconds; meanwhile a disabled policy plugin must not fail calls closed).
      // Shrink only: plugins that are newly expected are added after they had their chance to load.
      await this.refreshPolicyExpectations(desired, { shrinkOnly: true });
      await this.applyInstalls(loader, desired, false);
      if (this.pendingActivations.size > 0) await this.activatePendingNow();
      await this.refreshPolicyExpectations(desired);
    });
  }

  /**
   * Refreshes {@link policyExpected} from deployment state (M-1): builtin plugins from their manifest,
   * config-declared plugins and enabled installs (`desired`) from their approved permission snapshot.
   * `desired` undefined (install records unreadable) keeps the previous install entries.
   * `shrinkOnly`: only remove entries (a plugin no longer desired or approved), never add new ones.
   */
  private async refreshPolicyExpectations(
    desired: readonly DesiredExtension[] | undefined,
    opts: { shrinkOnly?: boolean } = {},
  ) {
    const snapshots = await new ExtensionApprovals(kernelDb(this.deps.db)).all();
    const next = new Map<string, readonly string[]>();
    const add = (name: string, set: PermissionSet | undefined) => {
      const mounts = set?.permissions?.policyHooks ?? [];
      if (mounts.length > 0) next.set(name, [...mounts]);
    };
    for (const [name, info] of this.declaredInfo) {
      add(name, info.source === "builtin" ? info.set : snapshots.get(name)?.permissions);
    }
    const declared = this.declared();
    if (desired === undefined) {
      for (const [name, mounts] of this.policyExpected) {
        if (!this.declaredInfo.has(name)) next.set(name, mounts);
      }
    } else {
      for (const d of desired) {
        if (!declared.has(d.name)) add(d.name, snapshots.get(d.name)?.permissions);
      }
    }
    if (opts.shrinkOnly) {
      for (const name of [...next.keys()]) {
        if (!this.policyExpected.has(name)) next.delete(name);
      }
    }
    this.policyExpected = next;
  }

  /**
   * Plugins that deployment state expects to run `policy` hooks on the mount point (M-1): enabled and
   * approved, with the mount in `permissions.policyHooks`. In-process, no I/O (see
   * {@link refreshPolicyExpectations}); the hook registry fails calls closed for those not loaded here.
   */
  expectedPolicy(mount: string): string[] {
    return [...this.policyExpected].flatMap(([name, mounts]) =>
      mounts.includes(mount) ? [name] : [],
    );
  }

  /**
   * 待定的内置 / 配置声明插件（{@link pendingActivations}）：重读快照，按启动时同一套判定（{@link planApprovals}，
   * 另加「必需能力此刻要有生效的提供方」）逐个处理；能加载的走与启动相同的加载流程（部署配置、迁移、setup，
   * setup 时限 `extensionHost.reloadSetupTimeoutSeconds`），失败只记 failed、留着下次重试（T13 → T14 交接）；
   * 仍被依赖阻塞的改记 pending / dependency。反复直到不动点（加载一个可能放行依赖它的），
   * 最后对新提供的能力做依赖方连锁（与 {@link reload} 相同）。
   */
  private async activatePendingNow(): Promise<string[]> {
    if (this.pendingActivations.size === 0) return [];
    const approvals = new ExtensionApprovals(kernelDb(this.deps.db));
    const snapshots = await approvals.all();
    const activated: string[] = [];
    /** 本次已经试过且失败的：同一次不再重试（下一次 converge 再试）。 */
    const failedNow = new Set<string>();
    for (let progress = true; progress; ) {
      progress = false;
      for (const [name, a] of [...this.pendingActivations]) {
        if (this.closed) throw new Error("plugin host is closed");
        if (failedNow.has(name)) continue;
        const decision = this.decidePending(name, a, snapshots);
        if (decision.action === "pending") {
          await this.stillPending(a, decision.pending);
          continue;
        }
        this.pendingActivations.delete(name);
        this.dropPending(name);
        try {
          await this.activate(
            approvals,
            { ...a, decision, fatal: false },
            this.reloadSetupTimeoutMs(),
          );
        } catch (e) {
          if (this.closed) throw e;
          // 配置声明的插件迁移 / setup 出错时 activate 抛错（启动时内核失败）；运行中只记 failed
          this.deps.log.error("approved plugin not loaded", { plugin: name, err: e });
          await this.writeStatus({
            plugin: name,
            version: a.manifest.version,
            sha256: a.sha256,
            source: a.source,
            state: "failed",
            reason: "setup_failed",
            detail: errMsg(e),
          });
        }
        if (this.registry.current(name)) {
          activated.push(name);
          progress = true;
          this.deps.log.info("approved plugin loaded", { plugin: name });
        } else {
          // 加载失败（迁移、setup）或待配置：留着，下一次 converge 重试（同一次不再试）
          if (!this.pendingActivations.has(name)) this.pendingActivations.set(name, a);
          failedNow.add(name);
        }
      }
    }
    if (activated.length > 0) {
      await this.cascade(
        activated.flatMap((n) => this.registry.current(n)?.manifest.provides ?? []),
        this.drainMs(),
        new Set(activated),
      );
    }
    return activated;
  }

  /**
   * 待批准插件此刻的判定：已生效的（同名实例除外：升级时按新权限集合比对快照）视为已批准；必需能力没有生效的
   * 提供方时仍待定（dependency）。`providers` 给出能力 → 声明提供它但没生效的安装记录（填 blockedBy）。
   */
  private decidePending(
    name: string,
    a: Activation,
    snapshots: Map<string, PermissionSnapshot>,
    providers: Map<ExtensionPointRef, string[]> = this.installProvides,
  ): ApprovalDecision {
    const loaded = this.registry.all().filter((i) => i.name !== name);
    const manifests = loaded.map((i) => i.manifest);
    const sets = new Map([
      ...loaded.map((i) => [i.name, i.permissions] as const),
      [name, a.set] as const,
    ]);
    // 内置插件预先批准（C14；待配置的内置插件也在这里重试）
    const preApproved = a.source === "builtin" ? [...manifests, a.manifest] : manifests;
    const decision = planApprovals(
      [...manifests, a.manifest],
      sets,
      withPreApproved(snapshots, preApproved, sets),
      { autoApprove: this.autoApprove },
    ).find((d) => d.plugin === name) as ApprovalDecision;
    if (decision.action === "pending") return decision;
    const provided = new Set(loaded.flatMap((i) => [...i.provided.keys()]));
    const missing = (a.manifest.requires ?? []).filter((c) => !provided.has(c));
    if (missing.length === 0) return decision;
    return {
      plugin: name,
      action: "pending",
      pending: {
        plugin: name,
        version: a.manifest.version,
        added: decision.added,
        removed: decision.removed,
        reason: "dependency",
        blockedBy: missing.map((extensionPoint) => ({
          extensionPoint,
          providers: [
            ...new Set([
              ...[...this.pendingActivations.values()]
                .filter((p) => p.manifest.provides.includes(extensionPoint))
                .map((p) => p.manifest.name),
              ...(providers.get(extensionPoint) ?? []).filter((n) => n !== name),
            ]),
          ],
        })),
      },
    };
  }

  /** 仍不能加载的待批准插件：原因变了（如已批准、只剩依赖阻塞）时更新待批准清单与副本状态。 */
  private async stillPending(a: Activation, p: PendingExtension): Promise<void> {
    const at = this.pendingPlugins.findIndex((x) => x.plugin === p.plugin);
    const before = at >= 0 ? this.pendingPlugins[at] : undefined;
    if (at >= 0) this.pendingPlugins[at] = p;
    else this.pendingPlugins.push(p);
    if (before?.reason === p.reason) return;
    const reason: PendingReason = p.reason === "dependency" ? "dependency" : "approval";
    await this.writeStatus({
      plugin: p.plugin,
      version: a.manifest.version,
      sha256: a.sha256,
      source: a.source,
      state: "pending",
      reason,
      detail: null,
    });
  }

  /** 插件的来源（导入过的；未知返回 undefined）。 */
  sourceOf(plugin: string): ExtensionSource | undefined {
    return this.sources.get(plugin)?.source;
  }

  /** 内置与配置声明的插件名 → 来源（安装包不能与它们重名）。 */
  declared(): Map<string, ExtensionSource> {
    return new Map(
      [...this.sources].flatMap(([n, s]) =>
        s.source === "install" ? [] : [[n, s.source] as const],
      ),
    );
  }

  /** 内置插件名（始终启用：组织启用检查对它们直接放行）。 */
  builtinNames(): Set<string> {
    return new Set([...this.sources].flatMap(([n, s]) => (s.source === "builtin" ? [n] : [])));
  }

  /**
   * Extensions enabled in the org: `extension_org_configs.enabled` plus every builtin extension;
   * queried every time, not cached.
   * Cost (M-4): hooks call this on every run, so one PG query per model attempt and per tool call.
   * Acceptable for now; if a cache is ever added, give it a short TTL so an org disabling a plugin
   * takes effect quickly.
   */
  async enabledPlugins(orgId: string): Promise<Set<string>> {
    const set = await queryEnabledPlugins(this.deps.db, orgId);
    for (const n of this.builtinNames()) set.add(n);
    return set;
  }

  /**
   * The access behind an extension's `ctx.extensionPoints`: only active instances in the registry
   * (dependencies load in topological order, so the depended-on are ready first); org enablement is
   * read from `extension_org_configs` every time, not cached. Resolved live on every call: once a
   * provider is revoked it is no longer returned.
   */
  private readonly extensionPointAccess: ExtensionPointAccess = {
    providers: (ref) =>
      this.registry
        .all()
        .flatMap((i) =>
          i.provided.has(ref) ? [{ plugin: i.name, impl: i.provided.get(ref) }] : [],
        ),
    enabledPlugins: (orgId) => this.enabledPlugins(orgId),
  };

  private get loadDeps(): LoadDeps {
    return {
      kernel: this.deps,
      extensionPointAccess: this.extensionPointAccess,
      nextGeneration: (name) => {
        const g = (this.generations.get(name) ?? 0) + 1;
        this.generations.set(name, g);
        return g;
      },
      imports: this.imports,
    };
  }

  /**
   * 按加载参数建一个新实例（setup 期间的 ctx 记在 `settingUp`，close() 时立即关闭）。
   * `timeoutMs`（运行中重新加载）：setup 超时或宿主被关闭时关闭这个 ctx 并抛错；迟到完成的实例随即撤销。
   * 内置 / 配置声明的插件启动时不设时限（见 {@link load}）。
   */
  private async setup(spec: InstanceSpec, timeoutMs?: number): Promise<ExtensionInstance> {
    if (this.imports.record(spec.manifest.name, spec.entryUrl)) {
      warnUpgrades(this.deps.log, this.imports);
    }
    let ctx: KernelExtensionContext | undefined;
    const p = setupInstance(this.loadDeps, spec.manifest, {
      entryUrl: spec.entryUrl,
      source: spec.source,
      sha256: spec.sha256,
      config: spec.config,
      configHash: spec.configHash,
      permissions: spec.permissions,
      onCtx: (c) => {
        if (c) ctx = c;
        if (c || this.settingUp === ctx) this.settingUp = c;
      },
    });
    if (timeoutMs === undefined) return p;
    let timer: NodeJS.Timeout | undefined;
    let onClose: () => void = () => {};
    const stop = new Promise<"timeout" | "closed">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      onClose = () => resolve("closed");
      if (this.abort.signal.aborted) onClose();
      else this.abort.signal.addEventListener("abort", onClose, { once: true });
    });
    try {
      const r = await Promise.race([p.then((inst) => ({ inst })), stop]);
      if (typeof r === "object") return r.inst;
      // setup 迟迟不返回：关闭它的 ctx（此后它的登记立即撤销），迟到完成的实例直接撤销
      p.then(
        (inst) => this.disposeQuietly(inst, 0),
        () => {},
      );
      if (this.settingUp === ctx) this.settingUp = undefined;
      await ctx?.close().catch((err: unknown) => {
        this.deps.log.warn("plugin context close failed", { plugin: spec.manifest.name, err });
      });
      if (r === "closed") throw new Error(CLOSED_DURING_LOAD);
      throw new Error(
        `plugin ${spec.manifest.name}: setup did not finish within ${timeoutMs} ms during reload; the previous instance is kept`,
      );
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener("abort", onClose);
    }
  }

  /** 取能力实现：单选能力无需 providerName，多选能力必须指定。 */
  get<T>(capability: ExtensionPointRef, providerName?: string): T {
    const providers = this.registry.all().filter((i) => i.provided.has(capability));
    if (providers.length === 0) throw new Error(`extension point ${capability} has no provider`);
    const single = EXTENSION_POINT_CARDINALITY[parseExtensionPoint(capability).name] === "single";
    let chosen: ExtensionInstance | undefined;
    if (providerName !== undefined) {
      chosen = providers.find((p) => p.name === providerName);
      if (!chosen) {
        throw new Error(`extension point ${capability} is not provided by plugin ${providerName}`);
      }
    } else if (single) {
      chosen = providers[0];
    } else {
      // 多选能力即使只有一个提供者也要显式指定，避免新增提供者后行为悄悄变化
      throw new Error(
        `extension point ${capability} is multi-provider; specify a provider name (available: ${providers.map((p) => p.name).join(", ")})`,
      );
    }
    return (chosen as ExtensionInstance).provided.get(capability) as T;
  }

  /**
   * 列出提供某能力（任意主版本）的所有插件及实现；`capability` 为完整引用（含主版本），
   * 同一插件提供多个主版本时各占一项，由调用方按主版本选择。
   * 每项带插件版本与部署配置摘要（{@link deploymentConfigHash}），供调用方做「插件升级 / 改配置即失效」的缓存键。
   * 实时取自注册表：调用方不要缓存实现对象（插件撤销 / 升级后旧实现不再有效）。
   */
  list(extensionPointName: string): ExtensionPointEntry[] {
    const out: ExtensionPointEntry[] = [];
    const tracked = TRACKED_EXTENSION_POINTS[extensionPointName];
    for (const i of this.registry.all()) {
      for (const [cap, impl] of i.provided) {
        if (parseExtensionPoint(cap).name === extensionPointName) {
          out.push({
            plugin: i.name,
            capability: cap,
            // 内核消费的提供方调用计入实例在途计数：停用 / 升级时先排空、到时限中止（C17）
            impl:
              tracked && typeof impl === "object" && impl !== null
                ? trackCalls(impl, i.inflight, tracked)
                : impl,
            version: i.version,
            configHash: i.configHash,
            inflight: i.inflight,
          });
        }
      }
    }
    return out;
  }

  /**
   * 已加载插件的部署配置（已按清单 schema 校验，含密钥），供内核调用该插件的能力时作为 `config` 传回
   * （如 `identity-source@1` 的登录配置）；未加载返回 undefined。不得回显到响应或日志。
   */
  deploymentConfig(plugin: string): unknown {
    return this.registry.current(plugin)?.config;
  }

  /**
   * 本副本拿得到的插件清单里的部署级 schema（生效实例 → 内置 / 配置声明 → 安装记录准备好的候选）；
   * 都没有返回 undefined（如未加载的安装记录：调用方改用包内静态清单）。
   */
  deploymentSchema(
    plugin: string,
  ): { version: string; schema: core.$ZodType | undefined } | undefined {
    const m =
      this.registry.current(plugin)?.manifest ??
      this.declaredInfo.get(plugin)?.manifest ??
      this.importedManifests.get(plugin)?.manifest;
    return m && { version: m.version, schema: m.config?.deployment };
  }

  /** 在本副本生效、声明了部署级配置的插件。 */
  configurablePlugins(): string[] {
    return this.registry
      .all()
      .filter((i) => i.manifest.config?.deployment !== undefined)
      .map((i) => i.name);
  }

  /**
   * 部署配置保存后（`kernel.plugin-deployment-config`）本副本重读并校验（C10；与 unload / reload 串行）：
   * - 插件没在本副本生效 → `not_loaded`（内置 / 配置声明的刷新后台的合法性判定；待配置的由 reconcile 加载）；
   * - 不合法 → `invalid`：保持当前值，告警；
   * - 没变 → `unchanged`；只改了 hot 字段 → `hot`：就地替换，插件经 `ctx.config` 读到新值，不重新 setup；
   * - 改了非 hot 字段 → `reload`：用新配置重新加载实例（先新后旧，排空在途调用），依赖方连锁；
   *   重新加载失败旧实例保留（`reload_failed`，记 error）。
   */
  applyDeploymentConfig(
    plugin: string,
  ): Promise<"not_loaded" | "invalid" | "unchanged" | "hot" | "reload" | "reload_failed"> {
    return this.serial(async () => {
      const inst = this.registry.current(plugin);
      const spec = this.specs.get(plugin);
      if (!inst || !spec) {
        const declared = this.declaredInfo.get(plugin);
        const schema = declared?.manifest.config?.deployment;
        if (schema) {
          try {
            const raw = await this.rawConfigOf(plugin, schema);
            this.configValidity.set(plugin, schema.safeParse(raw).success);
          } catch (err) {
            this.deps.log.warn("cannot read the stored deployment config of plugin", {
              plugin,
              err,
            });
          }
        }
        return "not_loaded";
      }
      const schema = inst.manifest.config?.deployment;
      if (!schema) return "unchanged";
      let raw: unknown;
      try {
        raw = await this.rawConfigOf(plugin, schema);
      } catch (err) {
        this.deps.log.error(
          "cannot read the stored deployment config of plugin; keeping its current config",
          { plugin, err },
        );
        return "invalid";
      }
      const r = schema.safeParse(raw);
      if (!r.success) {
        this.deps.log.warn(
          "plugin deployment config changed but is invalid on this replica; keeping the current config",
          {
            plugin,
            detail: toIssues(r.error)
              .map((i) => `${i.path || "<root>"}: ${i.message}`)
              .join("; "),
          },
        );
        return "invalid";
      }
      const next = r.data;
      if (inst.source !== "install") this.configValidity.set(plugin, true);
      const changed = changedPaths(schema, inst.config, next);
      if (changed.length === 0) return "unchanged";
      this.reportSecrets(schema, next);
      const hot = new Set(
        configFields(schema)
          .filter((f) => f.meta?.hot)
          .map((f) => f.path),
      );
      const configHash = deploymentConfigHash(schema, next);
      // 之后的重新加载（依赖方连锁等）都用新配置；重新加载失败时恢复原来的（旧实例的配置）
      this.specs.set(plugin, { ...spec, config: next, configHash });
      if (changed.every((p) => hot.has(p))) {
        inst.updateConfig(next, configHash);
        this.deps.log.info("plugin deployment config updated in place (hot fields)", {
          plugin,
          changed,
        });
        return "hot";
      }
      const drainMs = this.drainMs();
      let fresh: ExtensionInstance;
      try {
        fresh = await this.doReload(plugin, drainMs);
      } catch (err) {
        // 旧实例保留，加载参数也回到旧实例的（否则依赖方连锁 / reload 会用失败的配置重建）；
        // 配置仍与 PG 不同，下次消息或周期 reconcile 再试
        if (this.specs.get(plugin)?.config === next) this.specs.set(plugin, spec);
        if (this.closed) throw err;
        this.deps.log.error(
          "plugin reload after a deployment config change failed; it keeps its previous instance",
          { plugin, changed, err },
        );
        return "reload_failed";
      }
      await this.cascade(fresh.manifest.provides, drainMs);
      this.deps.log.info("plugin reloaded after a deployment config change", { plugin, changed });
      return "reload";
    });
  }

  /** 本次未加载、等待批准权限的插件（含因 `requires` 只能由它们满足而未加载的插件），按依赖拓扑序。 */
  pending(): PendingExtension[] {
    return structuredClone(this.pendingPlugins);
  }

  /** 已加载插件的清单（按加载顺序，即依赖拓扑序）。 */
  manifests(): ExtensionManifest[] {
    return this.registry.all().map((i) => i.manifest);
  }

  /** 已加载插件的权限集合（加载时计算，清单不可变）；未加载返回 undefined。 */
  permissionSet(plugin: string): PermissionSet | undefined {
    return this.registry.current(plugin)?.permissions;
  }

  /** 生效的插件实例；未加载 / 已撤销返回 undefined。 */
  current(plugin: string): ExtensionInstance | undefined {
    return this.registry.current(plugin);
  }

  /** 生效的插件实例（按加载顺序）。 */
  instances(): ExtensionInstance[] {
    return this.registry.all();
  }

  /**
   * Route gate: the extension belongs to this deployment (builtin, config-declared, or an install
   * record in PG) but is not active on this replica right now -> true, and its `/plugins/<name>/*` and
   * `/plugin-ui/<name>/*` answer 503 `extension.unavailable` (the routes stay mounted and only gate);
   * active, or a completely unknown name -> false (unknown is a plain 404). Looks only at what the
   * deployment knows, not at this process's load history. Install record names are cached for
   * {@link KNOWN_NAMES_TTL_MS} and invalidated on registry changes; when they cannot be read the name
   * counts as unknown (404).
   */
  async unavailable(plugin: string): Promise<boolean> {
    if (this.registry.current(plugin)) return false;
    // 内置 / 配置声明（含待批准、配置不合法的）；安装记录以 PG 为准（卸载后的名字回到 404）
    const source = this.sources.get(plugin)?.source;
    if (source === "builtin" || source === "config") return true;
    return (await this.installed()).has(plugin);
  }

  /**
   * 作废路由闸门的安装记录名字缓存（收到 `kernel.plugins.changed` 时各副本调用：卸载 / 新装后不等 TTL）。
   */
  invalidateKnownNames(): void {
    this.installedCache = undefined;
  }

  /** 安装记录里的插件名（缓存，见 {@link unavailable}）。 */
  private installed(): Promise<Set<string>> {
    const load = this.installedNames;
    if (!load) return Promise.resolve(new Set());
    const now = Date.now();
    if (!this.installedCache || now - this.installedCache.at > KNOWN_NAMES_TTL_MS) {
      const names = load()
        .then((xs) => new Set(xs))
        .catch((err: unknown) => {
          this.deps.log.warn("cannot read plugin install records for the route gate", { err });
          this.installedCache = undefined;
          return new Set<string>();
        });
      this.installedCache = { at: now, names };
    }
    return this.installedCache.names;
  }

  /** Subscribes to registry changes (activated / replaced / removed, the argument is the extension name): this process only, see {@link ExtensionRegistry.onChange}. */
  onChange(listener: (name: string) => void): () => void {
    return this.registry.onChange(listener);
  }

  /** 插件路由表（给 HTTP 的插件转发用）：实时路由、注册表版本、闸门与变化通知（中止该插件进行中的请求）。 */
  routeTable(): PluginRouteTable {
    return {
      routes: () => this.routes(),
      revision: () => this.registry.revision(),
      unavailable: (plugin) => this.unavailable(plugin),
      onChange: (listener) => this.registry.onChange(listener),
    };
  }

  /** 所有插件注册的 HTTP 路由（路径已带 `/plugins/<name>` 前缀）。 */
  routes(): Route[] {
    return this.registry.all().flatMap((i) => [...i.routes]);
  }

  /**
   * 所有插件经 `ctx.tools.register` 注册的工具（按加载顺序、注册顺序），附带实例的在途计数：
   * 执行时经 `inflight.run` 调用 handler，实例撤销时排空 / 中止。
   */
  tools(): { plugin: string; spec: ToolSpec; handler: ToolHandler; inflight: InflightTracker }[] {
    return this.registry.all().flatMap((i) =>
      i.tools.map((t) => ({
        plugin: i.name,
        spec: t.spec,
        handler: t.handler,
        inflight: i.inflight,
      })),
    );
  }

  /**
   * 已加载插件清单里的界面贡献（按加载顺序、清单顺序），附带 setup 期间注册的视图 render / 动作处理函数。
   * 是否在某组织启用由调用方另查（每次查询，不缓存）。
   */
  uiContributions(): LoadedUiContribution[] {
    return this.registry.all().flatMap((i) =>
      (i.manifest.ui ?? []).map((c) => {
        const render = c.kind === "view" ? i.uiViews.get(c.id) : undefined;
        const action = c.kind === "view" ? i.uiActions.get(c.id) : undefined;
        return {
          plugin: i.name,
          contribution: c,
          ...(render !== undefined && { render }),
          ...(action !== undefined && { action }),
        };
      }),
    );
  }

  /** 串行执行生命周期操作（unload / reload 互不交错）；宿主关闭后拒绝。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = () => {
      if (this.closed) return Promise.reject(new Error("plugin host is closed"));
      return fn();
    };
    const run = this.lifecycle.then(guarded, guarded);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /**
   * 撤销一个插件（本副本，C17）：从注册表摘下（此后新请求取不到它）、排空在途调用（最多 `drainMs`，
   * 默认 `extensionHost.drainSeconds`）、逐项撤销登记、调插件 `dispose`（最多 `extensionHost.disposeTimeoutSeconds`）。连锁：
   * - `requires` 它提供的能力、且该能力已没有其他提供方的插件随之卸下（状态 `unloaded`、原因 `dependency`），
   *   提供方回来后（{@link reload}）自动重新加载；
   * - 其余 `requires` / `optional` 它提供的能力的插件（含间接依赖）在本副本按拓扑序各重新加载一次。
   * 返回卸下的插件名（含连锁卸下的）；插件不在注册表时返回空数组。宿主关闭后拒绝。
   */
  unload(plugin: string, opts: { drainMs?: number } = {}): Promise<string[]> {
    return this.serial(async () => {
      const drainMs = opts.drainMs ?? this.drainMs();
      const inst = await this.doUnload(plugin, drainMs, null);
      if (!inst) return [];
      return [plugin, ...(await this.cascade(inst.manifest.provides, drainMs))];
    });
  }

  /**
   * 用同一份加载参数（同一模块入口、部署配置与权限）新建一个实例并原子替换（同进程重新加载 / 撤销后重新启用）：
   * 新实例 setup 成功后才登记（setup 最多 `extensionHost.reloadSetupTimeoutSeconds`），旧实例随后撤销（排空在途调用）；
   * setup 失败或超时时旧实例保持不变并抛错。依赖它的插件在本副本按拓扑序各重新加载一次；此前因它卸下的依赖方重新加载。
   * 同一入口的重新加载不新增模块代码；升级到新入口（T14）的模块代码留在内存直到进程重启，不同入口数超过阈值时告警。
   * 宿主关闭后拒绝。
   */
  reload(plugin: string, opts: { drainMs?: number } = {}): Promise<ExtensionInstance> {
    return this.serial(async () => {
      const drainMs = opts.drainMs ?? this.drainMs();
      const inst = await this.doReload(plugin, drainMs);
      await this.cascade(inst.manifest.provides, drainMs);
      return inst;
    });
  }

  /** 摘下并撤销一个实例（不做连锁）；不在注册表时返回 undefined。 */
  private async doUnload(
    plugin: string,
    drainMs: number,
    reason: "dependency" | null,
  ): Promise<ExtensionInstance | undefined> {
    if (this.closed) throw new Error("plugin host is closed");
    const inst = this.registry.deactivate(plugin);
    if (!inst) return undefined;
    if (reason === "dependency") this.unloadedForDependency.add(plugin);
    else this.unloadedForDependency.delete(plugin);
    await this.disposeQuietly(inst, drainMs);
    await this.writeStatus({
      plugin,
      version: inst.version,
      sha256: inst.sha256,
      source: inst.source,
      state: "unloaded",
      reason,
      detail: null,
    });
    this.deps.log.info("plugin unloaded", { plugin, generation: inst.generation, reason });
    return inst;
  }

  /** 新建实例并原子替换、撤销旧实例（不做连锁）。 */
  private async doReload(plugin: string, drainMs: number): Promise<ExtensionInstance> {
    if (this.closed) throw new Error("plugin host is closed");
    const spec = this.specs.get(plugin);
    if (!spec) throw new Error(`plugin ${plugin} has never been loaded in this process`);
    const available = new Set(
      this.registry
        .all()
        .filter((i) => i.name !== plugin)
        .flatMap((i) => [...i.provided.keys()]),
    );
    const missing = (spec.manifest.requires ?? []).filter((cap) => !available.has(cap));
    if (missing.length > 0) {
      throw new ExtensionResolveError(
        `plugin ${plugin}: required extension point ${missing.join(", ")} has no provider`,
      );
    }
    const inst = await this.setup(spec, this.reloadSetupTimeoutMs());
    if (this.closed) {
      await this.disposeQuietly(inst, 0);
      throw new Error("plugin host is closed");
    }
    this.unloadedForDependency.delete(plugin);
    const old = this.registry.activate(inst);
    await this.writeStatus({
      plugin,
      version: inst.version,
      sha256: inst.sha256,
      source: inst.source,
      state: "loaded",
      reason: null,
      detail: null,
    });
    if (old) await this.disposeQuietly(old, drainMs);
    this.deps.log.info("plugin reloaded", { plugin, generation: inst.generation });
    return inst;
  }

  /** 生效实例按依赖拓扑排序（解析不了时退回注册表顺序）。 */
  private topoOrder(): ExtensionInstance[] {
    const all = this.registry.all();
    try {
      const order = resolveExtensions(
        all.map((i) => i.manifest),
        SDK_VERSION,
      ).map((m) => m.name);
      return order.flatMap((n) => {
        const i = this.registry.current(n);
        return i ? [i] : [];
      });
    } catch {
      return all;
    }
  }

  /**
   * 提供方实例变了（撤销 / 替换）之后的连锁：先一次性收集受影响的插件（`requires` / `optional` 这些能力的，
   * 以及间接依赖它们的——菱形依赖只收一次），再按拓扑序逐个处理：必需能力已无提供方的卸下（dependency），
   * 其余重新加载一次。最后把此前因依赖卸下、现在能满足的插件加回来。返回连锁卸下的插件名。
   * `skip`：本轮刚加载的插件（已按新的提供方 setup，不再重新加载）。
   */
  private async cascade(
    caps: ExtensionPointRef[],
    drainMs: number,
    skip: ReadonlySet<string> = new Set(),
  ): Promise<string[]> {
    const removed: string[] = [];
    const order = this.topoOrder();
    const changing = new Set(caps);
    const affected: string[] = [];
    for (const i of order) {
      const deps = [...(i.manifest.requires ?? []), ...(i.manifest.optional ?? [])];
      if (!deps.some((c) => changing.has(c))) continue;
      if (skip.has(i.name)) continue;
      affected.push(i.name);
      for (const c of i.manifest.provides) changing.add(c);
    }
    const providedNow = () => new Set(this.registry.all().flatMap((i) => [...i.provided.keys()]));
    for (const name of affected) {
      const i = this.registry.current(name);
      if (!i) continue;
      if ((i.manifest.requires ?? []).some((c) => !providedNow().has(c))) {
        if (await this.doUnload(name, drainMs, "dependency")) removed.push(name);
        continue;
      }
      try {
        await this.doReload(name, drainMs);
      } catch (err) {
        if (this.closed) throw err;
        this.deps.log.error("dependent plugin reload failed; it keeps its previous instance", {
          plugin: name,
          err,
        });
      }
    }
    // 此前因依赖卸下的：必需能力都有提供方了就加回来（加回来的可能又满足别的，反复直到不动点）
    for (let progress = true; progress; ) {
      progress = false;
      for (const name of [...this.unloadedForDependency]) {
        const spec = this.specs.get(name);
        if (!spec || this.registry.current(name)) {
          this.unloadedForDependency.delete(name);
          continue;
        }
        const available = providedNow();
        if (!(spec.manifest.requires ?? []).every((c) => available.has(c))) continue;
        try {
          await this.doReload(name, drainMs);
          progress = true;
        } catch (err) {
          if (this.closed) throw err;
          this.deps.log.error("plugin reload after its dependency came back failed", {
            plugin: name,
            err,
          });
          this.unloadedForDependency.delete(name);
        }
      }
    }
    return removed;
  }

  /** 撤销实例；失败只记 error（已从注册表摘下，不影响其余）。 */
  private async disposeQuietly(inst: ExtensionInstance, drainMs: number): Promise<void> {
    try {
      await inst.dispose({ drainMs, disposeTimeoutMs: this.disposeTimeoutMs() });
    } catch (err) {
      this.deps.log.error("plugin dispose failed", { plugin: inst.name, err });
    }
  }

  /**
   * 按加载顺序（拓扑序）逆序串行撤销各插件：依赖方先于被依赖方。停机路径：不排空在途调用（运行此时已停），
   * 队列 worker 等进行中的任务结束。调用后宿主进入 closed 状态（幂等），此后 unload / reload 拒绝。
   * 进行中的 `load()`：迁移被中止并等其连接结束，setup 中的 ctx 被立即关闭（不等 setup 返回），load() 随后在检查点放弃。
   * 进行中的 unload / reload 最多等 `lifecycleWaitMs`（默认 2s；卡住的 setup / dispose 不拖住停机），
   * 之后关闭 setup 中的 ctx、撤销其余实例。单个插件关闭失败记 error 后继续关闭其余插件。
   */
  async close(opts: { lifecycleWaitMs?: number } = {}): Promise<void> {
    this.closed = true;
    this.abort.abort();
    await this.migrating?.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.lifecycle.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, opts.lifecycleWaitMs ?? CLOSE_LIFECYCLE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    // 升级时被替换、后台排空中的旧实例：同样最多等 lifecycleWaitMs，之后强制撤销（中止在途调用、不再排空），
    // 赶在共用资源（Redis / PG）关闭之前
    if (this.retiring.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.retiring.values()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, opts.lifecycleWaitMs ?? CLOSE_LIFECYCLE_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      await Promise.allSettled(
        [...this.retiring.keys()].map((old) =>
          old.hurry().catch((err: unknown) => {
            this.deps.log.warn("plugin close failed", { plugin: old.name, err });
          }),
        ),
      );
    }
    const settingUp = this.settingUp;
    this.settingUp = undefined;
    await settingUp?.close().catch((e: unknown) => {
      this.deps.log.error("plugin close failed", { err: e });
    });
    for (const inst of this.registry.all().reverse()) {
      this.registry.deactivate(inst.name);
      try {
        await inst.dispose({
          drainMs: 0,
          waitQueueJobs: true,
          disposeTimeoutMs: this.disposeTimeoutMs(),
        });
        this.deps.log.info("plugin closed", { plugin: inst.name });
      } catch (e) {
        this.deps.log.error("plugin close failed", { plugin: inst.name, err: e });
      }
    }
  }
}
