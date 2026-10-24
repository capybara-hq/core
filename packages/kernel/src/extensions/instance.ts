import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineExtension,
  type ExtensionManifest,
  ExtensionManifestError,
  type ExtensionPointRef,
  type StaticExtensionManifest,
  staticManifestOf,
} from "@capybara-hq/plugin-sdk";
import {
  createExtensionContext,
  type ExtensionPointAccess,
  type KernelDeps,
  type KernelExtensionContext,
  LiveConfig,
  type RegisteredTool,
  type Route,
} from "../ctx/create-ctx.js";
import type { UiActionHandler, UiRender } from "../ui/registry.js";
import type { RegisteredHook } from "./hooks.js";
import { InflightTracker } from "./inflight.js";
import type { Registration } from "./ledger.js";
import type { PermissionSet } from "./permission-set.js";
import type { ExtensionSource } from "./sources.js";

export type { Registration, RegistrationKind } from "./ledger.js";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 模块清单与审阅过的静态清单（包内 `capybara.manifest`）不一致。 */
export class ManifestMismatchError extends Error {
  constructor(plugin: string, moduleName: string) {
    super(
      `plugin ${plugin}: the plugin module's manifest does not match the reviewed package manifest (module name "${moduleName}")`,
    );
    this.name = "ManifestMismatchError";
  }
}

/** 键排序 JSON（jsonb 会重排对象键；比较静态清单用）。 */
const canonical = (v: unknown): string => {
  if (Array.isArray(v))
    return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
};

/** 模块清单与审阅过的静态清单是否一致（名字与 {@link staticManifestOf} 都须相同）。 */
export function matchesSection(
  manifest: ExtensionManifest,
  name: string,
  section: StaticExtensionManifest,
): boolean {
  return manifest.name === name && canonical(staticManifestOf(manifest)) === canonical(section);
}

/** 导入一个插件模块（default 导出）并按 defineExtension 校验清单。 */
export async function importExtensionModule(
  url: string,
  label: string,
  resolveFrom: string,
): Promise<ExtensionManifest> {
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
    return defineExtension(mod.default as ExtensionManifest);
  } catch (e) {
    throw new ExtensionManifestError(label, errMsg(e));
  }
}

/** Constructor parameters of {@link ExtensionInstance} (kernel internal). */
export interface ExtensionInstanceInit {
  manifest: ExtensionManifest;
  source: ExtensionSource;
  sha256: string | null;
  generation: number;
  permissions: PermissionSet;
  /** 部署配置摘要（见 `deploymentConfigHash`）。 */
  configHash: string;
  /** 已按清单 schema 校验的部署配置（含密钥）；与 ctx 共用同一个 {@link LiveConfig}。 */
  config: LiveConfig;
  /** 模块入口（`file:` URL）：同进程重新加载时用。 */
  entryUrl: string;
  ctx: KernelExtensionContext;
  log: KernelDeps["log"];
}

/**
 * 一个已完成 setup 的插件实例（一代）：清单、来源、权限、部署配置，以及它经 ctx 做过的全部登记（账）。
 * 同一插件升级 / 重新加载会产生新实例（generation 加一），旧实例 `dispose` 后它的登记全部撤销；
 * 旧模块代码留在内存里直到进程重启（ESM 无法卸载）。
 */
export class ExtensionInstance {
  readonly name: string;
  readonly version: string;
  readonly sha256: string | null;
  readonly source: ExtensionSource;
  readonly generation: number;
  readonly manifest: ExtensionManifest;
  readonly permissions: PermissionSet;
  private hash: string;
  private readonly live: LiveConfig;
  readonly entryUrl: string;
  readonly inflight: InflightTracker;
  private readonly ctx: KernelExtensionContext;
  private readonly log: KernelDeps["log"];
  private disposing: Promise<void> | undefined;
  /** {@link hurry}：进行中的 dispose 不再等排空时限。 */
  private readonly hurried = new AbortController();

  constructor(init: ExtensionInstanceInit) {
    this.manifest = init.manifest;
    this.name = init.manifest.name;
    this.version = init.manifest.version;
    this.sha256 = init.sha256;
    this.source = init.source;
    this.generation = init.generation;
    this.permissions = init.permissions;
    this.hash = init.configHash;
    this.live = init.config;
    this.entryUrl = init.entryUrl;
    this.ctx = init.ctx;
    this.log = init.log;
    this.inflight = new InflightTracker(this.name);
  }

  /** 此刻的部署配置（hot 改动后是新值）。 */
  get config(): unknown {
    return this.live.value;
  }

  /** 部署配置摘要（见 `deploymentConfigHash`；hot 改动后随之更新）。 */
  get configHash(): string {
    return this.hash;
  }

  /** hot 字段改动：就地替换部署配置（插件下次读 `ctx.config` 拿到新值），不重新 setup（C10）。 */
  updateConfig(config: unknown, configHash: string): void {
    this.live.value = config;
    this.hash = configHash;
  }

  /** 提供的能力（撤销后为空）。 */
  get provided(): ReadonlyMap<ExtensionPointRef, unknown> {
    return this.ctx.provided;
  }
  get routes(): readonly Route[] {
    return this.ctx.routes;
  }
  get tools(): readonly RegisteredTool[] {
    return this.ctx.registeredTools;
  }
  /** Hooks registered through `ctx.hooks.on` (empty after revocation). */
  get hooks(): readonly RegisteredHook[] {
    return this.ctx.registeredHooks;
  }
  get uiViews(): ReadonlyMap<string, UiRender> {
    return this.ctx.uiViews;
  }
  get uiActions(): ReadonlyMap<string, UiActionHandler> {
    return this.ctx.uiActions;
  }
  /** 账上仍在的登记（撤销后为空）。 */
  registrations(): Registration[] {
    return this.ctx.ledger.list();
  }
  get disposed(): boolean {
    return this.disposing !== undefined;
  }

  /**
   * Revokes this instance (idempotent; the caller should first remove it from the registry or replace
   * it). In order:
   * 1. stop taking new work (in-flight tracker closed, queue workers stop taking new jobs);
   * 2. wait for in-flight tool calls and running queue worker jobs together, up to `drainMs` (one
   *    deadline);
   * 3. abort: remaining in-flight calls end with `ExtensionUnloadedError` (the model gets
   *    `PLUGIN_UNLOADED_TOOL_ERROR`), `ctx.signal` aborts (so work that honours `ctx.signal` is not
   *    aborted within the drain limit);
   * 4. revoke the ledger's registrations one by one (in reverse; queue jobs still running at the
   *    deadline are forced to stay in the queue);
   * 5. call the extension's `dispose(ctx)`, up to `disposeTimeoutMs` (a throw or timeout is only
   *    logged, and it goes on);
   * 6. close the ctx (queue connections, pending audit writes). Step 6 throws on failure (the caller
   *    logs it).
   * `waitQueueJobs` (shutdown path): queue workers wait for running jobs to finish instead of being
   * force-closed at the deadline.
   */
  dispose(opts: DisposeOptions): Promise<void> {
    this.disposing ??= this.doDispose(opts);
    return this.disposing;
  }

  /**
   * 让进行中（或之后开始）的 {@link dispose} 立即结束排空：余下的在途调用随即中止，队列任务按到时处理
   * （停机时宿主对后台撤销中的旧实例调用）。没有在撤销时等同于以排空时限 0 撤销。
   */
  hurry(): Promise<void> {
    this.hurried.abort();
    this.inflight.abort();
    return this.dispose({ drainMs: 0 });
  }

  private async doDispose(opts: DisposeOptions): Promise<void> {
    const deadline = Date.now() + Math.max(0, opts.drainMs);
    this.inflight.close();
    let queues: Promise<"drained" | "timeout"> = Promise.resolve("drained");
    if (!opts.waitQueueJobs) {
      await this.ctx.beginDispose(deadline).catch((err: unknown) => {
        this.log.warn("plugin queue pause failed", { plugin: this.name, err });
      });
      queues = this.ctx.drainQueues(deadline).catch(() => "timeout" as const);
    }
    let onHurry: () => void = () => {};
    const hurried = new Promise<"timeout">((resolve) => {
      onHurry = () => resolve("timeout");
      if (this.hurried.signal.aborted) onHurry();
      else this.hurried.signal.addEventListener("abort", onHurry, { once: true });
    });
    const [calls, jobs] = await Promise.all([
      Promise.race([this.inflight.drain(Math.max(0, deadline - Date.now())), hurried]),
      Promise.race([queues, hurried]),
    ]);
    this.hurried.signal.removeEventListener("abort", onHurry);
    if (jobs === "timeout") {
      this.log.warn(
        "plugin queue jobs still running after the drain timeout; leaving them queued",
        {
          plugin: this.name,
          generation: this.generation,
          drainMs: opts.drainMs,
        },
      );
    }
    const drained = calls;
    if (drained === "timeout") {
      this.log.warn("plugin calls still running after the drain timeout; aborting them", {
        plugin: this.name,
        generation: this.generation,
        inflight: this.inflight.size,
        drainMs: opts.drainMs,
      });
    }
    this.inflight.abort();
    this.ctx.abort();
    this.ctx.ledger.seal();
    await this.ctx.ledger.disposeAll((r, err) =>
      this.log.warn("plugin registration dispose failed", {
        plugin: this.name,
        kind: r.kind,
        key: r.key,
        err,
      }),
    );
    if (this.manifest.dispose) {
      const dispose = this.manifest.dispose;
      const ms = opts.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      try {
        const r = await Promise.race([
          Promise.resolve()
            .then(() => dispose(this.ctx))
            .then(() => "done" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), ms);
          }),
        ]);
        if (r === "timeout") {
          this.log.warn("plugin dispose() did not finish in time; continuing without it", {
            plugin: this.name,
            generation: this.generation,
            timeoutMs: ms,
          });
        }
      } catch (err) {
        this.log.warn("plugin dispose() failed", { plugin: this.name, err });
      } finally {
        clearTimeout(timer);
      }
    }
    await this.ctx.close();
  }
}

/** 插件 `dispose()` 的默认时限（`pluginHost.disposeTimeoutSeconds` 的默认值）。 */
export const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;

/** Parameters of {@link ExtensionInstance.dispose}. */
export interface DisposeOptions {
  /** 在途调用与队列任务的排空时限（毫秒）。 */
  drainMs: number;
  /** 插件 `dispose()` 的时限（毫秒），默认 {@link DEFAULT_DISPOSE_TIMEOUT_MS}。 */
  disposeTimeoutMs?: number;
  /** 停机路径：队列 worker 一直等进行中的任务结束，不按截止时刻强制关闭。 */
  waitQueueJobs?: boolean;
}

/** 同进程导入过的插件模块数超过多少（每个插件第一个入口不算）就告警。 */
export const UPGRADE_WARN_THRESHOLD = 20;

/**
 * 记录本进程导入过的插件模块入口（按插件名去重的 URL）：ESM 模块无法卸载，每个新入口（升级到新包）
 * 的代码都留在内存里直到进程重启。同一 URL 的重新加载不新增模块，不计数。
 * 升级数 = 各插件「不同入口数 - 1」之和；第一次超过 {@link UPGRADE_WARN_THRESHOLD} 时 `record` 返回 true（只一次）。
 */
export class ImportTracker {
  private readonly urls = new Map<string, Set<string>>();
  private warned = false;

  /** 本进程的升级数（见类注释）。 */
  get upgrades(): number {
    let n = 0;
    for (const set of this.urls.values()) n += set.size - 1;
    return n;
  }

  /** 记一次导入；返回这次是否应当告警。 */
  record(plugin: string, url: string): boolean {
    let set = this.urls.get(plugin);
    if (!set) {
      set = new Set();
      this.urls.set(plugin, set);
    }
    set.add(url);
    if (!this.warned && this.upgrades > UPGRADE_WARN_THRESHOLD) {
      this.warned = true;
      return true;
    }
    return false;
  }
}

/** 升级次数超过阈值的告警（旧模块代码留在内存直到重启）。 */
export function warnUpgrades(log: KernelDeps["log"], imports: ImportTracker): void {
  log.warn(
    "plugins were upgraded many times in this process; the code of earlier plugin versions stays in memory until the process restarts, so restart this replica to free it",
    { upgrades: imports.upgrades, threshold: UPGRADE_WARN_THRESHOLD },
  );
}

/** {@link setupInstance} / {@link loadInstance} 的依赖。 */
export interface LoadDeps {
  kernel: KernelDeps;
  extensionPointAccess: ExtensionPointAccess;
  /** 该插件下一代的编号（宿主按插件名递增）。 */
  nextGeneration(name: string): number;
  /** 本进程导入过的模块入口（{@link loadInstance} 每次导入都记一笔，超过阈值时告警）。 */
  imports?: ImportTracker;
}

/** 在已导入、已核对的清单上建 ctx（记账）并 setup；setup 抛错时撤销已登记的再抛。 */
export async function setupInstance(
  deps: LoadDeps,
  manifest: ExtensionManifest,
  input: {
    entryUrl: string;
    source: ExtensionSource;
    sha256: string | null;
    config: unknown;
    configHash: string;
    permissions: PermissionSet;
    /** 已建好 ctx、setup 进行中时回调（宿主据此在 close() 时立即关闭它）。 */
    onCtx?: (ctx: KernelExtensionContext | undefined) => void;
  },
): Promise<ExtensionInstance> {
  const live = new LiveConfig(input.config);
  const ctx = createExtensionContext(deps.kernel, manifest, live, deps.extensionPointAccess);
  input.onCtx?.(ctx);
  try {
    await manifest.setup(ctx);
    ctx.sealTools();
    for (const cap of manifest.provides) {
      if (!ctx.provided.has(cap)) {
        throw new Error(`declared extension point ${cap} was not provided by setup`);
      }
    }
  } catch (e) {
    try {
      await ctx.close();
    } catch (err) {
      deps.kernel.log.warn("plugin context close failed", { plugin: manifest.name, err });
    }
    throw new Error(`plugin ${manifest.name}: setup failed: ${errMsg(e)}`, { cause: e });
  } finally {
    input.onCtx?.(undefined);
  }
  return new ExtensionInstance({
    manifest,
    source: input.source,
    sha256: input.sha256,
    generation: deps.nextGeneration(manifest.name),
    permissions: input.permissions,
    configHash: input.configHash,
    config: live,
    entryUrl: input.entryUrl,
    ctx,
    log: deps.kernel.log,
  });
}

/**
 * 加载一个插件实例：import → defineExtension → 有包内静态清单（`section`）时与 {@link staticManifestOf} 核对
 * （名字与静态清单都须一致，否则抛 {@link ManifestMismatchError}；配置声明 / 内置插件没有 section，跳过核对）
 * → 建 ctx（记账）→ setup；setup 抛错时撤销已登记的再抛。
 * 不做权限闸门、部署配置校验与迁移（宿主在此之前完成）；`config` 为已校验的部署配置。
 */
export async function loadInstance(
  deps: LoadDeps,
  input: {
    entryUrl: string;
    source: ExtensionSource;
    sha256: string | null;
    config: unknown;
    configHash: string;
    permissions: PermissionSet;
    /** 安装记录的包内静态清单与插件名（审阅过的那份）。 */
    section?: { name: string; manifest: StaticExtensionManifest };
    onCtx?: (ctx: KernelExtensionContext | undefined) => void;
  },
): Promise<ExtensionInstance> {
  const label = input.section?.name ?? input.entryUrl;
  const manifest = await importExtensionModule(
    input.entryUrl,
    label,
    dirname(fileURLToPath(input.entryUrl)),
  );
  if (input.section && !matchesSection(manifest, input.section.name, input.section.manifest)) {
    throw new ManifestMismatchError(input.section.name, manifest.name);
  }
  if (deps.imports?.record(manifest.name, input.entryUrl))
    warnUpgrades(deps.kernel.log, deps.imports);
  return setupInstance(deps, manifest, input);
}
