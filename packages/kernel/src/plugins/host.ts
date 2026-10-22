import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CAPABILITY_CARDINALITY,
  type CapabilityRef,
  type PluginManifest,
  parseCapability,
  SDK_VERSION,
  type ToolHandler,
  type ToolSpec,
  type UiContribution,
} from "@capybara-hq/plugin-sdk";
import type { core } from "zod";
import {
  configFields,
  getPath,
  secretValues,
  setPath,
  unreachableSecrets,
} from "../config/fields.js";
import {
  type CapabilityAccess,
  type KernelDeps,
  type KernelPluginContext,
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
  type PendingPlugin,
  type PermissionSnapshot,
  PluginApprovals,
  planApprovals,
} from "./approvals.js";
import type { InflightTracker } from "./inflight.js";
import type { DesiredPlugin } from "./installs.js";
import {
  importPluginModule,
  type LoadDeps,
  matchesSection,
  type PluginInstance,
  setupInstance,
} from "./instance.js";
import {
  blockingKeys,
  computePermissionSet,
  type PermissionSet,
  UI_VIEW_KEY_PREFIX,
} from "./permission-set.js";
import { PluginRegistry } from "./registry.js";
import { PluginResolveError, resolvePlugins } from "./resolve.js";
import type {
  PendingReason,
  PluginLoadStatus,
  PluginSource,
  ReplicaStatusStore,
} from "./sources.js";
import { packageRootOf } from "./sync.js";

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

/** {@link PluginHost.uiContributions} 的一项：清单里的界面贡献及其注册的视图 / 动作（embed 没有）。 */
export interface LoadedUiContribution {
  plugin: string;
  contribution: UiContribution;
  render?: UiRender;
  action?: UiActionHandler;
}

/** {@link PluginHost.list} 的一项。 */
export interface PluginCapabilityEntry {
  plugin: string;
  capability: CapabilityRef;
  impl: unknown;
  /** 插件清单的 version。 */
  version: string;
  /** 部署配置摘要，见 {@link deploymentConfigHash}。 */
  configHash: string;
}

const CLOSED_DURING_LOAD = "plugin host closed during load";

/** 撤销实例时在途调用的默认排空时限（`pluginHost.drainSeconds` 的默认值）。 */
const DEFAULT_DRAIN_MS = 30_000;
/** 同进程重新加载超过这么多次就告警：每次新实例的模块代码都留在内存里，直到进程重启。 */
export const RELOAD_WARN_THRESHOLD = 20;

/** 一个插件的加载参数（{@link PluginHost.reload} 用同一份重新 setup）。 */
interface InstanceSpec {
  manifest: PluginManifest;
  entryUrl: string;
  source: PluginSource;
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
  manifests: PluginManifest[],
  deferrable: Set<string>,
): { ready: PluginManifest[]; deferred: PluginManifest[] } {
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
  manifest: PluginManifest;
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
      manifest: await importPluginModule(url, spec, resolveFrom),
      dir: dirname(fileURLToPath(url)),
      url,
    });
  }
  return entries;
}

/** 导入并校验各插件清单，按依赖拓扑排序；同时返回每个插件模块所在目录。 */
async function importPlugins(
  specifiers: string[],
  resolveFrom: string,
): Promise<{ ordered: PluginManifest[]; dirs: Map<string, string> }> {
  const entries = await importEntries(specifiers, resolveFrom);
  const dirs = new Map(entries.map((e) => [e.manifest.name, e.dir]));
  const ordered = resolvePlugins(
    entries.map((e) => e.manifest),
    SDK_VERSION,
  );
  return { ordered, dirs };
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
      "plugin is built in; ignoring the same plugin in the plugins config list (remove it from the list)",
      { plugin: e.manifest.name },
    );
    return false;
  });
}

/** {@link PluginHost.inspect} 的一项。 */
export interface InspectedPlugin {
  manifest: PluginManifest;
  /** 插件模块所在目录（`migrations` 相对它解析）。 */
  dir: string;
  /** 规范化的权限集合，见 {@link computePermissionSet}。 */
  permissions: PermissionSet;
}

/** 计算各插件的权限集合（按插件名索引）。 */
async function permissionSets(
  ordered: PluginManifest[],
  dirs: Map<string, string>,
): Promise<Map<string, PermissionSet>> {
  const sets = new Map<string, PermissionSet>();
  for (const m of ordered) {
    sets.set(m.name, await computePermissionSet(m, dirs.get(m.name) as string));
  }
  return sets;
}

/** 待批准插件的 warn 日志：点名插件、原因与新增项（依赖原因写明阻塞的能力与提供方）。 */
function warnPending(log: KernelDeps["log"], p: PendingPlugin): void {
  if (p.reason === "dependency") {
    const missing = (p.blockedBy ?? []).some((b) => b.providers.length === 0);
    log.warn(
      missing
        ? "plugin not loaded: a capability it needs has no provider (e.g. permissions.storage needs an object-store@1 plugin such as object-store-s3)"
        : "plugin not loaded: a required capability is only provided by plugins awaiting permission approval",
      { plugin: p.plugin, version: p.version, blockedBy: p.blockedBy },
    );
    return;
  }
  log.warn(
    "plugin not loaded: permissions awaiting approval (run `capybara plugins review`, then `capybara plugins approve <name>` and restart)",
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
  manifest: PluginManifest,
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
export function assertSecretsReachable(manifest: PluginManifest): void {
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
const migrationsDirOf = (m: PluginManifest, dir: string): string | undefined =>
  m.migrations ? resolvePath(dir, m.migrations) : undefined;

/**
 * 给预先批准的插件（内置，C14；以及已决定加载的插件）补一份与当前权限集合相同的快照，
 * 让 {@link planApprovals} 视其为「已批准、无变化」：不进待批准、不写快照，依赖它的插件照常判定。
 */
function withPreApproved(
  snapshots: Map<string, PermissionSnapshot>,
  manifests: PluginManifest[],
  sets: Map<string, PermissionSet>,
): Map<string, PermissionSnapshot> {
  const out = new Map(snapshots);
  for (const m of manifests) {
    out.set(m.name, {
      plugin: m.name,
      version: m.version,
      permissions: sets.get(m.name) as PermissionSet,
      approvedBy: null,
      approvedAt: new Date(0),
      source: "auto",
    });
  }
  return out;
}

/**
 * 安装记录的加载入口（C13）：期望启用的记录、同步到本地（返回 entry URL）与记下已迁移。
 * 由内核用 `PluginInstalls` + `syncPackage` 实现；宿主在内置与配置声明的插件都加载完之后才调用
 * （包可能存在对象存储里，要等 object-store 插件就绪）。
 */
export interface InstalledPluginLoader {
  desired(): Promise<DesiredPlugin[]>;
  sync(d: DesiredPlugin): Promise<string>;
  markMigrated(name: string, sha256: string): Promise<void>;
}

/** {@link PluginHost.load} 的插件来源，按此顺序加载（见 {@link PluginSource}）。 */
export interface PluginLoadPlan {
  /** 内置插件（模块 specifier，建议 `file:` URL）：预先批准、始终启用。 */
  builtin?: string[];
  /** 启动配置 `plugins` 列表。 */
  config?: string[];
  /** 安装记录。 */
  installs?: InstalledPluginLoader;
}

/** 单个插件的加载参数（{@link PluginHost} 内部）。 */
interface Activation {
  manifest: PluginManifest;
  source: PluginSource;
  sha256: string | null;
  /** 模块入口（`file:` URL）。 */
  entryUrl: string;
  migrationsDir: string | undefined;
  set: PermissionSet;
  decision: ApprovalDecision;
  /** 内置 / 配置声明的插件出错直接抛（内核启动失败）；安装记录只记 failed，其余照常。 */
  fatal: boolean;
  onMigrated?: () => Promise<void>;
}

/** 插件宿主：解析、校验配置、迁移、setup，并登记插件提供的能力与路由。 */
export class PluginHost {
  /**
   * 只解析插件并按依赖顺序跑迁移，不校验部署配置、不调用 setup、不需要 Redis（供 `capybara migrate`）。
   * 与 `load()` 一样先检查密钥标记（`assertSecretsReachable`），有问题的插件一个都不迁移。
   * 返回每个声明了迁移的插件及其本次应用的文件。
   * 与 `load()` 同一道权限快照闸门：待批准的插件（及只能由它满足 `requires` 的插件）不迁移，经 `onPending` 报告；
   * 需要内核迁移已执行（读 `plugin_permission_snapshots`）。`autoApprove` 时全部迁移、不写快照（快照由 `load()` 写）。
   * `opts.builtin`：内置插件（预先批准，不过闸门；与配置列表重名时以内置为准）。
   */
  static async migrateOnly(
    specifiers: string[],
    opts: {
      dbUrl: string;
      resolveFrom?: string;
      connectTimeoutMs?: number;
      autoApprove?: boolean;
      builtin?: string[];
      onPending?: (pending: PendingPlugin[]) => void;
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
    const ordered = resolvePlugins(
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
          await new PluginApprovals(kernelDb(raw)).all(),
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
    opts: { resolveFrom?: string } = {},
  ): Promise<InspectedPlugin[]> {
    const { ordered, dirs } = await importPlugins(
      specifiers,
      resolvePath(opts.resolveFrom ?? process.cwd()),
    );
    for (const manifest of ordered) assertSecretsReachable(manifest);
    const sets = await permissionSets(ordered, dirs);
    return ordered.map((manifest) => ({
      manifest,
      dir: dirs.get(manifest.name) as string,
      permissions: sets.get(manifest.name) as PermissionSet,
    }));
  }

  /** 本进程生效的插件实例（C17）：消费方每次实时取，不缓存实现对象。 */
  private readonly registry = new PluginRegistry();
  /** 加载成功过的插件的加载参数（同进程重新加载用；撤销后保留，`unavailable` 据此判断）。 */
  private readonly specs = new Map<string, InstanceSpec>();
  /** 因必需能力没了而随提供方卸下的插件：提供方回来后重新加载。 */
  private readonly unloadedForDependency = new Set<string>();
  /** 每个插件已产生的实例代数。 */
  private readonly generations = new Map<string, number>();
  /** 本进程启动之后的重新加载次数（旧代码留在内存直到重启，超过阈值告警）。 */
  private reloads = 0;
  /** 串行化 unload / reload（同一时刻只做一件，依赖方的连锁处理不交错）。 */
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly drainMs: () => number;
  /** 本次因权限待批准（或依赖待批准插件）而未加载的插件。 */
  private readonly pendingPlugins: PendingPlugin[] = [];
  /** 导入过的插件名 → 来源与包（含未加载的；重名被跳过的一方不在这里）。 */
  private readonly sources = new Map<string, { source: PluginSource; sha256: string | null }>();
  private didLoad = false;
  private closed = false;
  /** close() 时中止进行中的插件迁移。 */
  private readonly abort = new AbortController();
  /** 进行中的插件迁移（close() 等它结束，保证迁移连接不比宿主活得久）。 */
  private migrating: Promise<unknown> | undefined;
  /** 已创建、尚未登记（setup 进行中）的 ctx：close() 时立即关闭，不等 setup 返回。 */
  private settingUp: KernelPluginContext | undefined;
  private readonly resolveFrom: string;
  private readonly onSecrets: ((values: string[]) => void) | undefined;
  private readonly autoApprove: boolean;
  private readonly status: ReplicaStatusStore | undefined;

  /**
   * @param opts.resolveFrom 解析裸包名的目录，默认 `process.cwd()`；相对路径按构造时的 cwd 转为绝对路径。
   * 绝对路径与 `file:` URL 的插件 specifier 直接使用；
   * 裸包名经 `createRequire(<resolveFrom>/noop.js).resolve` 解析，因此插件包的 exports 必须暴露
   * `default`（或 `require`）条件。
   * @param opts.autoApprove 自动批准插件权限（配置 `pluginPermissions.autoApprove`，仅开发与试用）：
   * 需要批准的插件以 source auto 写快照后照常加载。默认 false：待批准的插件不加载（见 {@link pending}）。
   * @param opts.status 本副本的加载状态表（`plugin_replica_status`）：每个插件的加载结果都写一行。
   */
  constructor(
    private readonly deps: KernelDeps,
    private readonly pluginConfig: Record<string, unknown> = {},
    opts: {
      resolveFrom?: string;
      onSecrets?: (values: string[]) => void;
      autoApprove?: boolean;
      status?: ReplicaStatusStore;
      /** 撤销实例时在途调用的排空时限（毫秒），默认 30s；内核传 `pluginHost.drainSeconds`。 */
      drainMs?: () => number;
    } = {},
  ) {
    this.drainMs = opts.drainMs ?? (() => DEFAULT_DRAIN_MS);
    this.onSecrets = opts.onSecrets;
    this.autoApprove = opts.autoApprove === true;
    this.resolveFrom = resolvePath(opts.resolveFrom ?? process.cwd());
    this.status = opts.status;
  }

  /**
   * 导入各插件模块（default 导出）并按依赖顺序初始化；只能调用一次。传数组等同 `{ config: [...] }`。
   *
   * 顺序（C14 / C15 / C13）：
   * 1. 内置插件：预先批准（不比对、不写权限快照）、始终启用；部署配置不合法时不加载，记 `pending`（reason config），
   *    内核照常启动。与配置列表重名时以内置为准并告警。
   * 2. 配置声明的插件：与此前相同（待批准不加载；配置不合法、迁移或 setup 失败时抛错，内核启动失败）。
   *    1、2 一起解析依赖与排序；配置声明的插件 `requires` 的能力只能由安装记录提供时，先挑出来，等第 3 步之后
   *    与已加载的插件一起解析再加载（第 4 步；仍不满足时与此前一样抛错）。
   * 3. 安装记录（`plan.installs`）：同步到本地、导入、核对静态清单（名字与 `capybara.manifest` 都须一致，
   *    否则 failed / manifest_mismatch），与已有插件一起解析依赖后按拓扑序走同一道权限闸门，迁移目录只取审阅过的
   *    `capybara.migrations`；任何一步失败只把该插件记为 failed（或 pending），其余照常。与内置 / 配置声明的插件重名时
   *    以后者为准并告警。
   * 每个插件的结果都写进本副本的 `plugin_replica_status`（构造时给了 `status`）。
   * 加载成功的实例登记进注册表（C17）：此后可用 {@link unload} / {@link reload} 在本进程撤销或重新加载。
   *
   * 插件 setup 永不返回时 load()（进而内核 `start()`）永远挂起：内核不给 setup 设超时；
   * 此时 `close()` / 内核 `stop()` 仍会立即关闭该插件的 ctx 并释放资源。
   * 加载期间宿主被 `close()` 时：进行中的迁移被中止、setup 中的 ctx 被立即关闭（此后其 queue 的
   * define / add 抛 `queue is closed`），load() 在下一个检查点抛 `plugin host closed during load`。
   */
  async load(plan: string[] | PluginLoadPlan): Promise<void> {
    if (this.closed) throw new Error(CLOSED_DURING_LOAD);
    if (this.didLoad) throw new Error("plugin host already loaded; load() may be called once");
    this.didLoad = true;
    const p: PluginLoadPlan = Array.isArray(plan) ? { config: plan } : plan;
    const builtin = await importEntries(p.builtin ?? [], this.resolveFrom);
    const config = dropShadowed(
      await importEntries(p.config ?? [], this.resolveFrom),
      builtin,
      this.deps.log,
    );
    const entries = [...builtin, ...config];
    const dirs = new Map(entries.map((e) => [e.manifest.name, e.dir]));
    const urls = new Map(entries.map((e) => [e.manifest.name, e.url]));
    // 有安装记录时：配置声明的插件若 requires 只能由安装记录满足，先挑出来，等安装记录加载完再解析与加载
    const { ready, deferred } = p.installs
      ? splitDeferred(
          entries.map((e) => e.manifest),
          new Set(config.map((e) => e.manifest.name)),
        )
      : { ready: entries.map((e) => e.manifest), deferred: [] };
    const ordered = resolvePlugins(ready, SDK_VERSION);
    for (const e of builtin) this.sources.set(e.manifest.name, { source: "builtin", sha256: null });
    for (const e of config) this.sources.set(e.manifest.name, { source: "config", sha256: null });

    for (const e of entries) assertSecretsReachable(e.manifest);

    const sets = await permissionSets(ordered, dirs);
    const approvals = new PluginApprovals(kernelDb(this.deps.db));
    if (this.autoApprove) {
      this.deps.log.warn(
        "pluginPermissions.autoApprove is ON: plugin permissions are approved automatically without review; never enable this in production",
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
        source: this.sourceOf(manifest.name) as PluginSource,
        sha256: null,
        entryUrl: urls.get(manifest.name) as string,
        migrationsDir: migrationsDirOf(manifest, dirs.get(manifest.name) as string),
        set: sets.get(manifest.name) as PermissionSet,
        decision: decisions.get(manifest.name) as ApprovalDecision,
        fatal: true,
      });
    }

    if (p.installs) await this.loadInstalls(p.installs, ordered, sets, snapshots, approvals);
    if (deferred.length > 0) await this.loadDeferred(deferred, dirs, urls, snapshots, approvals);

    const orphans = Object.keys(this.pluginConfig).filter((k) => !this.sources.has(k));
    if (orphans.length > 0) {
      this.deps.log.warn("pluginConfig has keys for plugins that are not loaded", {
        keys: orphans,
      });
    }
  }

  /** 第 3 步：安装记录（见 {@link load}）。`phase1` / `phase1Sets` 是第 1、2 步的插件及其权限集合。 */
  private async loadInstalls(
    loader: InstalledPluginLoader,
    phase1: PluginManifest[],
    phase1Sets: Map<string, PermissionSet>,
    snapshots: Map<string, PermissionSnapshot>,
    approvals: PluginApprovals,
  ): Promise<void> {
    let desired: DesiredPlugin[];
    try {
      desired = await loader.desired();
    } catch (e) {
      this.deps.log.error("cannot read plugin install records; installed plugins are not loaded", {
        err: e,
      });
      return;
    }
    const fail = async (d: DesiredPlugin, reason: string, detail: string): Promise<void> => {
      this.deps.log.error("installed plugin not loaded", {
        plugin: d.name,
        version: d.version,
        sha256: d.sha256,
        reason,
        detail,
      });
      await this.writeStatus({
        plugin: d.name,
        version: d.version,
        sha256: d.sha256,
        source: "install",
        state: "failed",
        reason,
        detail,
      });
    };
    interface Candidate {
      d: DesiredPlugin;
      manifest: PluginManifest;
      set: PermissionSet;
      entryUrl: string;
      migrationsDir: string | undefined;
    }
    const candidates: Candidate[] = [];
    for (const d of desired) {
      if (this.closed) throw new Error(CLOSED_DURING_LOAD);
      const taken = this.sources.get(d.name);
      if (taken) {
        this.deps.log.warn(
          `plugin is both installed and ${taken.source === "builtin" ? "built in" : "declared in the plugins config list"}; using the ${taken.source} plugin`,
          { plugin: d.name, installedVersion: d.version },
        );
        // 该名字的状态行属于生效的一方，不覆盖；在它的 detail 里记下冲突（后台能看到）
        await this.noteStatus(
          d.name,
          `name_conflict: install record ${d.version} (${d.sha256.slice(0, 16)}) ignored; the ${taken.source} plugin of the same name is used`,
        );
        continue;
      }
      let url: string;
      try {
        url = await loader.sync(d);
      } catch (e) {
        await fail(d, "sync", errMsg(e));
        continue;
      }
      let manifest: PluginManifest;
      let root: string;
      try {
        root = packageRootOf(url, d.section.entry);
        manifest = await importPluginModule(url, d.name, root);
        assertSecretsReachable(manifest);
      } catch (e) {
        await fail(d, "import", errMsg(e));
        continue;
      }
      // 审阅看的是静态清单：真实模块必须与它一致（名字、版本、能力、权限、界面、配置字段）
      if (!matchesSection(manifest, d.name, d.section.manifest)) {
        await fail(
          d,
          "manifest_mismatch",
          `the plugin module's manifest does not match the reviewed package manifest (module name "${manifest.name}")`,
        );
        continue;
      }
      // 迁移目录只取审阅过的静态 `capybara.migrations`（不认模块清单里的 migrations）
      const migrations = d.section.migrations;
      const reviewed = { ...manifest, migrations } as PluginManifest;
      let set: PermissionSet;
      try {
        set = await computePermissionSet(reviewed, root);
      } catch (e) {
        await fail(d, "import", errMsg(e));
        continue;
      }
      candidates.push({
        d,
        manifest,
        set,
        entryUrl: url,
        migrationsDir: migrations === undefined ? undefined : resolvePath(root, migrations),
      });
    }

    // 与已有插件一起解析依赖：解析不过的逐个剔除（反复尝试，直到没有新的能加进来）
    const accepted: Candidate[] = [];
    const tryResolve = (c: Candidate) =>
      resolvePlugins([...phase1, ...accepted.map((a) => a.manifest), c.manifest], SDK_VERSION);
    let remaining = candidates;
    for (let changed = true; changed && remaining.length > 0; ) {
      changed = false;
      const next: Candidate[] = [];
      for (const c of remaining) {
        try {
          tryResolve(c);
          accepted.push(c);
          changed = true;
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
      await fail(c.d, "dependency", detail);
    }
    if (accepted.length === 0) return;
    for (const c of accepted) this.sources.set(c.d.name, { source: "install", sha256: c.d.sha256 });

    const all = resolvePlugins([...phase1, ...accepted.map((a) => a.manifest)], SDK_VERSION);
    const sets = new Map([...phase1Sets, ...accepted.map((c) => [c.d.name, c.set] as const)]);
    // 第 1、2 步已加载的视为已批准；没加载的（待批准、待配置）从快照里拿掉 → 依赖它们的安装插件同样待定
    const loadedNow = new Set(this.registry.all().map((i) => i.name));
    const plan = new Map(snapshots);
    for (const m of phase1) if (!loadedNow.has(m.name)) plan.delete(m.name);
    const decisions = new Map(
      planApprovals(
        all,
        sets,
        withPreApproved(
          plan,
          phase1.filter((m) => loadedNow.has(m.name)),
          sets,
        ),
        { autoApprove: this.autoApprove },
      ).map((d) => [d.plugin, d]),
    );
    const byName = new Map(accepted.map((c) => [c.d.name, c]));
    for (const m of all) {
      const c = byName.get(m.name);
      if (!c) continue;
      await this.activate(approvals, {
        manifest: m,
        source: "install",
        sha256: c.d.sha256,
        entryUrl: c.entryUrl,
        migrationsDir: c.migrationsDir,
        set: c.set,
        decision: decisions.get(m.name) as ApprovalDecision,
        fatal: false,
        onMigrated: () => loader.markMigrated(c.d.name, c.d.sha256),
      });
    }
  }

  /**
   * 第 4 步：第 2 步挑出来的配置声明插件（`requires` 只能由安装记录满足）。与已加载的插件一起解析依赖——
   * 仍不满足时与此前一样抛错（内核启动失败）；满足的按拓扑序走同一道权限闸门后加载（出错同样直接抛）。
   */
  private async loadDeferred(
    deferred: PluginManifest[],
    dirs: Map<string, string>,
    urls: Map<string, string>,
    snapshots: Map<string, PermissionSnapshot>,
    approvals: PluginApprovals,
  ): Promise<void> {
    if (this.closed) throw new Error(CLOSED_DURING_LOAD);
    const loaded = this.registry.all();
    const all = resolvePlugins([...loaded.map((i) => i.manifest), ...deferred], SDK_VERSION);
    const sets = new Map([
      ...loaded.map((i) => [i.name, i.permissions] as const),
      ...(await permissionSets(deferred, dirs)),
    ]);
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
    const names = new Set(deferred.map((m) => m.name));
    for (const manifest of all) {
      if (!names.has(manifest.name)) continue;
      await this.activate(approvals, {
        manifest,
        source: "config",
        sha256: null,
        entryUrl: urls.get(manifest.name) as string,
        migrationsDir: migrationsDirOf(manifest, dirs.get(manifest.name) as string),
        set: sets.get(manifest.name) as PermissionSet,
        decision: decisions.get(manifest.name) as ApprovalDecision,
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

  /** 写本副本的加载状态；失败只记 warn（状态是给后台看的，不影响加载）。 */
  private async writeStatus(s: PluginLoadStatus): Promise<void> {
    if (!this.status) return;
    try {
      await this.status.write(s);
    } catch (e) {
      this.deps.log.warn("cannot write plugin replica status", { plugin: s.plugin, err: e });
    }
  }

  /**
   * 加载一个插件：权限闸门结论、部署配置、迁移、setup、登记。`fatal` 时（内置 / 配置声明）出错直接抛；
   * 否则（安装记录）记 failed 后返回。内置与安装记录的部署配置不合法时只记 pending（reason config），不抛。
   */
  private async activate(approvals: PluginApprovals, a: Activation): Promise<void> {
    const { manifest, decision } = a;
    const name = manifest.name;
    const base = { plugin: name, version: manifest.version, sha256: a.sha256, source: a.source };
    const raw = this.pluginConfig[name] ?? {};
    let config: unknown = raw;
    const schema = manifest.config?.deployment;
    if (decision.action === "pending") {
      // 待批准：不校验配置、不迁移、不 setup；配置合法时仍登记其中的密钥，避免日志泄露
      if (schema && this.onSecrets) {
        const r = schema.safeParse(raw);
        if (r.success) {
          const values = secretValues(schema, r.data);
          if (values.length > 0) this.onSecrets(values);
        }
      }
      this.pendingPlugins.push(decision.pending);
      warnPending(this.deps.log, decision.pending);
      const reason: PendingReason =
        decision.pending.reason === "dependency" ? "dependency" : "approval";
      await this.writeStatus({ ...base, state: "pending", reason, detail: null });
      return;
    }
    if (schema) {
      const r = schema.safeParse(raw);
      if (!r.success) {
        const detail = r.error.issues
          .map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        if (a.source === "config") {
          throw new Error(`plugin ${name}: invalid deployment config: ${detail}`);
        }
        // 内置 / 安装记录：待配置（C10），内核照常启动
        this.deps.log.warn("plugin not loaded: its deployment config is missing or invalid", {
          plugin: name,
          source: a.source,
          detail,
        });
        await this.writeStatus({ ...base, state: "pending", reason: "config", detail });
        return;
      }
      config = r.data;
      if (this.onSecrets) {
        const values = secretValues(schema, config);
        if (values.length > 0) this.onSecrets(values);
      }
    }
    const failSoft = async (reason: string, e: unknown): Promise<void> => {
      this.deps.log.error("installed plugin not loaded", { plugin: name, reason, err: e });
      await this.writeStatus({ ...base, state: "failed", reason, detail: errMsg(e) });
    };
    if (decision.changed) {
      if (decision.autoApprove) {
        await approvals.approve(name, manifest.version, a.set, { source: "auto" });
        this.deps.log.warn("plugin permissions auto-approved (pluginPermissions.autoApprove)", {
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
    if (this.closed) throw new Error(CLOSED_DURING_LOAD);
    this.migrating = migratePlugin(
      this.deps.dbUrl,
      manifest,
      a.migrationsDir,
      this.deps.connectTimeoutMs,
      this.abort.signal,
    );
    try {
      await this.migrating;
      await a.onMigrated?.();
    } catch (e) {
      if (this.closed) throw new Error(CLOSED_DURING_LOAD, { cause: e });
      if (a.fatal) throw e;
      await failSoft("migration", e);
      return;
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
    let inst: PluginInstance;
    try {
      inst = await this.setup(spec);
    } catch (e) {
      if (this.closed) throw new Error(CLOSED_DURING_LOAD, { cause: e });
      if (a.fatal) throw e;
      await failSoft("setup", e);
      return;
    }
    if (this.closed) {
      await inst.dispose({ drainMs: 0 }).catch((err: unknown) => {
        this.deps.log.warn("plugin context close failed", { plugin: name, err });
      });
      throw new Error(CLOSED_DURING_LOAD);
    }
    this.specs.set(name, spec);
    this.registry.activate(inst);
    await this.writeStatus({ ...base, state: "loaded", reason: null, detail: null });
  }

  /** 插件的来源（导入过的；未知返回 undefined）。 */
  sourceOf(plugin: string): PluginSource | undefined {
    return this.sources.get(plugin)?.source;
  }

  /** 内置与配置声明的插件名 → 来源（安装包不能与它们重名）。 */
  declared(): Map<string, PluginSource> {
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

  /** 在该组织启用的插件：`plugin_org_configs.enabled` 加上全部内置插件；每次查询，不缓存。 */
  async enabledPlugins(orgId: string): Promise<Set<string>> {
    const set = await queryEnabledPlugins(this.deps.db, orgId);
    for (const n of this.builtinNames()) set.add(n);
    return set;
  }

  /**
   * 插件 `ctx.capabilities` 的取用接口：只看注册表里生效的实例（依赖按拓扑序加载，被依赖方先就绪）；
   * 组织启用每次查 `plugin_org_configs`，不缓存。每次调用实时取：提供方撤销后立即取不到。
   */
  private readonly capabilityAccess: CapabilityAccess = {
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
      capabilityAccess: this.capabilityAccess,
      nextGeneration: (name) => {
        const g = (this.generations.get(name) ?? 0) + 1;
        this.generations.set(name, g);
        return g;
      },
    };
  }

  /** 按加载参数建一个新实例（setup 期间的 ctx 记在 `settingUp`，close() 时立即关闭）。 */
  private setup(spec: InstanceSpec): Promise<PluginInstance> {
    return setupInstance(this.loadDeps, spec.manifest, {
      entryUrl: spec.entryUrl,
      source: spec.source,
      sha256: spec.sha256,
      config: spec.config,
      configHash: spec.configHash,
      permissions: spec.permissions,
      onCtx: (ctx) => {
        this.settingUp = ctx;
      },
    });
  }

  /** 取能力实现：单选能力无需 providerName，多选能力必须指定。 */
  get<T>(capability: CapabilityRef, providerName?: string): T {
    const providers = this.registry.all().filter((i) => i.provided.has(capability));
    if (providers.length === 0) throw new Error(`capability ${capability} has no provider`);
    const single = CAPABILITY_CARDINALITY[parseCapability(capability).name] === "single";
    let chosen: PluginInstance | undefined;
    if (providerName !== undefined) {
      chosen = providers.find((p) => p.name === providerName);
      if (!chosen) {
        throw new Error(`capability ${capability} is not provided by plugin ${providerName}`);
      }
    } else if (single) {
      chosen = providers[0];
    } else {
      // 多选能力即使只有一个提供者也要显式指定，避免新增提供者后行为悄悄变化
      throw new Error(
        `capability ${capability} is multi-provider; specify a provider name (available: ${providers.map((p) => p.name).join(", ")})`,
      );
    }
    return (chosen as PluginInstance).provided.get(capability) as T;
  }

  /**
   * 列出提供某能力（任意主版本）的所有插件及实现；`capability` 为完整引用（含主版本），
   * 同一插件提供多个主版本时各占一项，由调用方按主版本选择。
   * 每项带插件版本与部署配置摘要（{@link deploymentConfigHash}），供调用方做「插件升级 / 改配置即失效」的缓存键。
   * 实时取自注册表：调用方不要缓存实现对象（插件撤销 / 升级后旧实现不再有效）。
   */
  list(capabilityName: string): PluginCapabilityEntry[] {
    const out: PluginCapabilityEntry[] = [];
    for (const i of this.registry.all()) {
      for (const [cap, impl] of i.provided) {
        if (parseCapability(cap).name === capabilityName) {
          out.push({
            plugin: i.name,
            capability: cap,
            impl,
            version: i.version,
            configHash: i.configHash,
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

  /** 本次未加载、等待批准权限的插件（含因 `requires` 只能由它们满足而未加载的插件），按依赖拓扑序。 */
  pending(): PendingPlugin[] {
    return structuredClone(this.pendingPlugins);
  }

  /** 已加载插件的清单（按加载顺序，即依赖拓扑序）。 */
  manifests(): PluginManifest[] {
    return this.registry.all().map((i) => i.manifest);
  }

  /** 已加载插件的权限集合（加载时计算，清单不可变）；未加载返回 undefined。 */
  permissionSet(plugin: string): PermissionSet | undefined {
    return this.registry.current(plugin)?.permissions;
  }

  /** 生效的插件实例；未加载 / 已撤销返回 undefined。 */
  current(plugin: string): PluginInstance | undefined {
    return this.registry.current(plugin);
  }

  /** 生效的插件实例（按加载顺序）。 */
  instances(): PluginInstance[] {
    return this.registry.all();
  }

  /**
   * 插件在本进程加载过、此刻不在注册表里（已撤销 / 随依赖卸下）：它的 `/plugins/<name>/*` 与
   * `/plugin-ui/<name>/*` 返回 503 `plugin.unavailable`（路由保留挂载只做闸门）。从未加载过的（待批准、加载失败、
   * 不存在）不算，照常 404。
   */
  unavailable(plugin: string): boolean {
    return !this.registry.current(plugin) && this.specs.has(plugin);
  }

  /** 订阅注册表变化（激活 / 替换 / 摘下，参数为插件名）：只通知本进程，见 {@link PluginRegistry.onChange}。 */
  onChange(listener: (name: string) => void): () => void {
    return this.registry.onChange(listener);
  }

  /** 插件路由表（给 HTTP 的插件转发用）：实时路由、注册表版本与闸门。 */
  routeTable(): PluginRouteTable {
    return {
      routes: () => this.routes(),
      revision: () => this.registry.revision(),
      unavailable: (plugin) => this.unavailable(plugin),
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

  /** 串行执行生命周期操作（unload / reload 互不交错）。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /**
   * 撤销一个插件（本副本，C17）：从注册表摘下（此后新请求取不到它）、排空在途调用（最多 `drainMs`，
   * 默认 `pluginHost.drainSeconds`）、逐项撤销登记、调插件 `dispose`。连锁：
   * - `requires` 它提供的能力、且该能力已没有其他提供方的插件随之卸下（状态 `unloaded`、原因 `dependency`），
   *   提供方回来后（{@link reload}）自动重新加载；
   * - 其余 `requires` / `optional` 它提供的能力的插件在本副本重新加载（拿到新的取用视图）。
   * 返回卸下的插件名（含连锁卸下的）；插件不在注册表时返回空数组。
   */
  unload(plugin: string, opts: { drainMs?: number } = {}): Promise<string[]> {
    return this.serial(() => this.doUnload(plugin, opts.drainMs ?? this.drainMs(), null));
  }

  /**
   * 用同一份加载参数（同一模块入口、部署配置与权限）新建一个实例并原子替换（同进程重新加载 / 撤销后重新启用）：
   * 新实例 setup 成功后才登记，旧实例随后撤销（排空在途调用）；setup 失败时旧实例保持不变并抛错。
   * 依赖它的插件在本副本重新加载；此前因它卸下的依赖方重新加载。旧模块代码留在内存直到进程重启，
   * 本进程重新加载超过 {@link RELOAD_WARN_THRESHOLD} 次时告警。
   */
  reload(plugin: string, opts: { drainMs?: number } = {}): Promise<PluginInstance> {
    return this.serial(() => this.doReload(plugin, opts.drainMs ?? this.drainMs()));
  }

  private async doUnload(
    plugin: string,
    drainMs: number,
    reason: "dependency" | null,
  ): Promise<string[]> {
    const inst = this.registry.deactivate(plugin);
    if (!inst) return [];
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
    const removed = [plugin];
    removed.push(...(await this.afterProviderChanged(inst.manifest.provides, drainMs)));
    return removed;
  }

  private async doReload(plugin: string, drainMs: number): Promise<PluginInstance> {
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
      throw new PluginResolveError(
        `plugin ${plugin}: required capability ${missing.join(", ")} has no provider`,
      );
    }
    const inst = await this.setup(spec);
    this.reloads += 1;
    if (this.reloads === RELOAD_WARN_THRESHOLD + 1) {
      this.deps.log.warn(
        "plugins were reloaded many times in this process; the code of earlier plugin versions stays in memory until the process restarts, so restart this replica to free it",
        { plugin, reloads: this.reloads },
      );
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
    await this.afterProviderChanged(inst.manifest.provides, drainMs);
    return inst;
  }

  /**
   * 提供方实例变了（撤销 / 替换）之后的连锁：按拓扑序，必需能力已无提供方的依赖方卸下（dependency），
   * 其余 `requires` / `optional` 这些能力的插件重新加载；最后把此前因依赖卸下、现在能满足的插件加回来。
   * 返回连锁卸下的插件名。
   */
  private async afterProviderChanged(caps: CapabilityRef[], drainMs: number): Promise<string[]> {
    const changed = new Set(caps);
    const removed: string[] = [];
    const providedNow = () => new Set(this.registry.all().flatMap((i) => [...i.provided.keys()]));
    if (changed.size > 0) {
      for (const i of this.registry.all()) {
        if (this.registry.current(i.name) !== i) continue;
        const requires = i.manifest.requires ?? [];
        const optional = i.manifest.optional ?? [];
        if (![...requires, ...optional].some((c) => changed.has(c))) continue;
        if (requires.some((c) => !providedNow().has(c))) {
          removed.push(...(await this.doUnload(i.name, drainMs, "dependency")));
          continue;
        }
        try {
          await this.doReload(i.name, drainMs);
        } catch (err) {
          this.deps.log.error("dependent plugin reload failed; it keeps its previous instance", {
            plugin: i.name,
            err,
          });
        }
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
  private async disposeQuietly(inst: PluginInstance, drainMs: number): Promise<void> {
    try {
      await inst.dispose({ drainMs });
    } catch (err) {
      this.deps.log.error("plugin dispose failed", { plugin: inst.name, err });
    }
  }

  /**
   * 按加载顺序（拓扑序）逆序串行撤销各插件：依赖方先于被依赖方。停机路径：不排空在途调用（运行此时已停），
   * 队列 worker 等进行中的任务结束。调用后宿主进入 closed 状态（幂等）。进行中的 `load()`：迁移被中止并等其连接结束，
   * setup 中的 ctx 被立即关闭（不等 setup 返回），load() 随后在检查点放弃。
   * 单个插件关闭失败记 error 后继续关闭其余插件。返回时本宿主建立的连接都已关闭。
   */
  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    await this.migrating?.catch(() => {});
    const settingUp = this.settingUp;
    this.settingUp = undefined;
    await settingUp?.close().catch((e: unknown) => {
      this.deps.log.error("plugin close failed", { err: e });
    });
    await this.lifecycle.catch(() => {});
    for (const inst of this.registry.all().reverse()) {
      this.registry.deactivate(inst.name);
      try {
        await inst.dispose({ drainMs: 0, waitQueueJobs: true });
        this.deps.log.info("plugin closed", { plugin: inst.name });
      } catch (e) {
        this.deps.log.error("plugin close failed", { plugin: inst.name, err: e });
      }
    }
  }
}
