import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CAPABILITY_CARDINALITY,
  type CapabilityRef,
  definePlugin,
  type PluginManifest,
  PluginManifestError,
  parseCapability,
  SDK_VERSION,
  staticManifestOf,
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
  createPluginContext,
  type KernelDeps,
  pluginSchemaName,
  queryEnabledPlugins,
  type RegisteredTool,
  type Route,
} from "../ctx/create-ctx.js";
import { kernelDb } from "../db/kernel-schema.js";
import { migrate } from "../db/migrator.js";
import { createDb } from "../db/pool.js";
import type { UiActionHandler, UiRender } from "../ui/registry.js";
import {
  type ApprovalDecision,
  type PendingPlugin,
  type PermissionSnapshot,
  PluginApprovals,
  planApprovals,
} from "./approvals.js";
import type { DesiredPlugin } from "./installs.js";
import {
  blockingKeys,
  computePermissionSet,
  type PermissionSet,
  UI_VIEW_KEY_PREFIX,
} from "./permission-set.js";
import { resolvePlugins } from "./resolve.js";
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

interface Loaded {
  manifest: PluginManifest;
  source: PluginSource;
  /** 安装记录的包（其余来源为 null）。 */
  sha256: string | null;
  /** 加载时计算的权限集合（清单不可变，进程内只读）。 */
  permissions: PermissionSet;
  /** 部署配置摘要，见 {@link deploymentConfigHash}。 */
  configHash: string;
  /** 已按清单 schema 校验的部署配置（含密钥；只交给该插件自己的能力调用）。 */
  config: unknown;
  provided: Map<CapabilityRef, unknown>;
  routes: Route[];
  tools: RegisteredTool[];
  uiViews: ReadonlyMap<string, UiRender>;
  uiActions: ReadonlyMap<string, UiActionHandler>;
  close(): Promise<void>;
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

/** 导入一个插件模块（default 导出）并按 definePlugin 校验清单。 */
async function importManifest(
  url: string,
  label: string,
  resolveFrom: string,
): Promise<PluginManifest> {
  let mod: { default?: unknown };
  try {
    mod = (await import(url)) as { default?: unknown };
  } catch (e) {
    throw new Error(`cannot import plugin "${label}" from "${resolveFrom}": ${errMsg(e)}`, {
      cause: e,
    });
  }
  if (typeof mod.default !== "object" || mod.default === null)
    throw new Error(`plugin module "${label}" has no default export object`);
  try {
    return definePlugin(mod.default as PluginManifest);
  } catch (e) {
    throw new PluginManifestError(label, errMsg(e));
  }
}

interface ImportedEntry {
  manifest: PluginManifest;
  dir: string;
}

/** 按顺序导入各 specifier 的插件模块（不排序）；同时给出模块所在目录。 */
async function importEntries(specifiers: string[], resolveFrom: string): Promise<ImportedEntry[]> {
  const entries: ImportedEntry[] = [];
  for (const spec of specifiers) {
    const url = toFileUrl(spec, resolveFrom);
    entries.push({
      manifest: await importManifest(url, spec, resolveFrom),
      dir: dirname(fileURLToPath(url)),
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

/** 键排序 JSON 比较（jsonb 会重排对象键）。 */
const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

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

  private readonly loaded: Loaded[] = [];
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
  private settingUp: { close(): Promise<void> } | undefined;
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
    } = {},
  ) {
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
   *    1、2 一起解析依赖与排序（配置声明的插件不能依赖安装记录提供的能力）。
   * 3. 安装记录（`plan.installs`）：同步到本地、导入、核对静态清单（名字与 `capybara.manifest` 都须一致，
   *    否则 failed / manifest_mismatch），与已有插件一起解析依赖后按拓扑序走同一道权限闸门，迁移目录只取审阅过的
   *    `capybara.migrations`；任何一步失败只把该插件记为 failed（或 pending），其余照常。与内置 / 配置声明的插件重名时
   *    以后者为准并告警。
   * 每个插件的结果都写进本副本的 `plugin_replica_status`（构造时给了 `status`）。
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
    const ordered = resolvePlugins(
      entries.map((e) => e.manifest),
      SDK_VERSION,
    );
    for (const e of builtin) this.sources.set(e.manifest.name, { source: "builtin", sha256: null });
    for (const e of config) this.sources.set(e.manifest.name, { source: "config", sha256: null });

    for (const manifest of ordered) assertSecretsReachable(manifest);

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
        migrationsDir: migrationsDirOf(manifest, dirs.get(manifest.name) as string),
        set: sets.get(manifest.name) as PermissionSet,
        decision: decisions.get(manifest.name) as ApprovalDecision,
        fatal: true,
      });
    }

    if (p.installs) await this.loadInstalls(p.installs, ordered, sets, snapshots, approvals);

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
        manifest = await importManifest(url, d.name, root);
        assertSecretsReachable(manifest);
      } catch (e) {
        await fail(d, "import", errMsg(e));
        continue;
      }
      // 审阅看的是静态清单：真实模块必须与它一致（名字、版本、能力、权限、界面、配置字段）
      if (manifest.name !== d.name || !sameJson(staticManifestOf(manifest), d.section.manifest)) {
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
    const loadedNow = new Set(this.loaded.map((l) => l.manifest.name));
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
        migrationsDir: c.migrationsDir,
        set: c.set,
        decision: decisions.get(m.name) as ApprovalDecision,
        fatal: false,
        onMigrated: () => loader.markMigrated(c.d.name, c.d.sha256),
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
    const ctx = createPluginContext(this.deps, manifest, config, this.capabilityAccess);
    this.settingUp = ctx;
    try {
      await manifest.setup(ctx);
      ctx.sealTools();
      for (const cap of manifest.provides) {
        if (!ctx.provided.has(cap)) {
          throw new Error(`declared capability ${cap} was not provided by setup`);
        }
      }
    } catch (e) {
      await this.closeQuietly(ctx, name);
      if (this.closed) throw new Error(CLOSED_DURING_LOAD, { cause: e });
      const err = new Error(`plugin ${name}: setup failed: ${errMsg(e)}`, { cause: e });
      if (a.fatal) throw err;
      await failSoft("setup", err);
      return;
    } finally {
      this.settingUp = undefined;
    }
    if (this.closed) {
      await this.closeQuietly(ctx, name);
      throw new Error(CLOSED_DURING_LOAD);
    }
    this.loaded.push({
      manifest,
      source: a.source,
      sha256: a.sha256,
      permissions: a.set,
      configHash: deploymentConfigHash(schema, config),
      config,
      provided: ctx.provided,
      routes: ctx.routes,
      tools: ctx.registeredTools,
      uiViews: ctx.uiViews,
      uiActions: ctx.uiActions,
      close: ctx.close,
    });
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
   * 插件 `ctx.capabilities` 的取用接口：只看已完成 setup 的插件（依赖按拓扑序加载，被依赖方先就绪）；
   * 组织启用每次查 `plugin_org_configs`，不缓存。
   */
  private readonly capabilityAccess: CapabilityAccess = {
    providers: (ref) =>
      this.loaded.flatMap((l) =>
        l.provided.has(ref) ? [{ plugin: l.manifest.name, impl: l.provided.get(ref) }] : [],
      ),
    enabledPlugins: (orgId) => this.enabledPlugins(orgId),
  };

  /** load() 放弃一个插件时关闭其 ctx：失败只记 warn（不掩盖导致放弃的原错误）。 */
  private async closeQuietly(ctx: { close(): Promise<void> }, plugin: string): Promise<void> {
    try {
      await ctx.close();
    } catch (e) {
      this.deps.log.warn("plugin context close failed", { plugin, err: e });
    }
  }

  /** 取能力实现：单选能力无需 providerName，多选能力必须指定。 */
  get<T>(capability: CapabilityRef, providerName?: string): T {
    const providers = this.loaded.filter((l) => l.provided.has(capability));
    if (providers.length === 0) throw new Error(`capability ${capability} has no provider`);
    const single = CAPABILITY_CARDINALITY[parseCapability(capability).name] === "single";
    let chosen: Loaded | undefined;
    if (providerName !== undefined) {
      chosen = providers.find((p) => p.manifest.name === providerName);
      if (!chosen) {
        throw new Error(`capability ${capability} is not provided by plugin ${providerName}`);
      }
    } else if (single) {
      chosen = providers[0];
    } else {
      // 多选能力即使只有一个提供者也要显式指定，避免新增提供者后行为悄悄变化
      throw new Error(
        `capability ${capability} is multi-provider; specify a provider name (available: ${providers.map((p) => p.manifest.name).join(", ")})`,
      );
    }
    return (chosen as Loaded).provided.get(capability) as T;
  }

  /**
   * 列出提供某能力（任意主版本）的所有插件及实现；`capability` 为完整引用（含主版本），
   * 同一插件提供多个主版本时各占一项，由调用方按主版本选择。
   * 每项带插件版本与部署配置摘要（{@link deploymentConfigHash}），供调用方做「插件升级 / 改配置即失效」的缓存键。
   */
  list(capabilityName: string): PluginCapabilityEntry[] {
    const out: PluginCapabilityEntry[] = [];
    for (const l of this.loaded) {
      for (const [cap, impl] of l.provided) {
        if (parseCapability(cap).name === capabilityName) {
          out.push({
            plugin: l.manifest.name,
            capability: cap,
            impl,
            version: l.manifest.version,
            configHash: l.configHash,
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
    return this.loaded.find((l) => l.manifest.name === plugin)?.config;
  }

  /** 本次未加载、等待批准权限的插件（含因 `requires` 只能由它们满足而未加载的插件），按依赖拓扑序。 */
  pending(): PendingPlugin[] {
    return structuredClone(this.pendingPlugins);
  }

  /** 已加载插件的清单（按加载顺序，即依赖拓扑序）。 */
  manifests(): PluginManifest[] {
    return this.loaded.map((l) => l.manifest);
  }

  /** 已加载插件的权限集合（加载时计算，清单不可变）；未加载返回 undefined。 */
  permissionSet(plugin: string): PermissionSet | undefined {
    return this.loaded.find((l) => l.manifest.name === plugin)?.permissions;
  }

  /** 所有插件注册的 HTTP 路由（路径已带 `/plugins/<name>` 前缀）。 */
  routes(): Route[] {
    return this.loaded.flatMap((l) => l.routes);
  }

  /** 所有插件经 `ctx.tools.register` 注册的工具（按加载顺序、注册顺序）。 */
  tools(): { plugin: string; spec: ToolSpec; handler: ToolHandler }[] {
    return this.loaded.flatMap((l) =>
      l.tools.map((t) => ({ plugin: l.manifest.name, spec: t.spec, handler: t.handler })),
    );
  }

  /**
   * 已加载插件清单里的界面贡献（按加载顺序、清单顺序），附带 setup 期间注册的视图 render / 动作处理函数。
   * 是否在某组织启用由调用方另查（每次查询，不缓存）。
   */
  uiContributions(): LoadedUiContribution[] {
    return this.loaded.flatMap((l) =>
      (l.manifest.ui ?? []).map((c) => {
        const render = c.kind === "view" ? l.uiViews.get(c.id) : undefined;
        const action = c.kind === "view" ? l.uiActions.get(c.id) : undefined;
        return {
          plugin: l.manifest.name,
          contribution: c,
          ...(render !== undefined && { render }),
          ...(action !== undefined && { action }),
        };
      }),
    );
  }

  /**
   * 按加载顺序（拓扑序）逆序串行关闭各插件：依赖方先于被依赖方关闭。
   * 调用后宿主进入 closed 状态（幂等）。进行中的 `load()`：迁移被中止并等其连接结束，
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
    while (this.loaded.length > 0) {
      const l = this.loaded.pop() as Loaded;
      const plugin = l.manifest.name;
      try {
        await l.close();
        this.deps.log.info("plugin closed", { plugin });
      } catch (e) {
        this.deps.log.error("plugin close failed", { plugin, err: e });
      }
    }
  }
}
