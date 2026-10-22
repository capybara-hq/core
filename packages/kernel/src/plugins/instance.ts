import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CapabilityRef,
  definePlugin,
  type PluginManifest,
  PluginManifestError,
  type StaticPluginManifest,
  staticManifestOf,
} from "@capybara-hq/plugin-sdk";
import {
  type CapabilityAccess,
  createPluginContext,
  type KernelDeps,
  type KernelPluginContext,
  type RegisteredTool,
  type Route,
} from "../ctx/create-ctx.js";
import type { UiActionHandler, UiRender } from "../ui/registry.js";
import { InflightTracker } from "./inflight.js";
import type { Registration } from "./ledger.js";
import type { PermissionSet } from "./permission-set.js";
import type { PluginSource } from "./sources.js";

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
  manifest: PluginManifest,
  name: string,
  section: StaticPluginManifest,
): boolean {
  return manifest.name === name && canonical(staticManifestOf(manifest)) === canonical(section);
}

/** 导入一个插件模块（default 导出）并按 definePlugin 校验清单。 */
export async function importPluginModule(
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

/** {@link PluginInstance} 的构造参数（内核内部）。 */
export interface PluginInstanceInit {
  manifest: PluginManifest;
  source: PluginSource;
  sha256: string | null;
  generation: number;
  permissions: PermissionSet;
  /** 部署配置摘要（见 `deploymentConfigHash`）。 */
  configHash: string;
  /** 已按清单 schema 校验的部署配置（含密钥）。 */
  config: unknown;
  /** 模块入口（`file:` URL）：同进程重新加载时用。 */
  entryUrl: string;
  ctx: KernelPluginContext;
  log: KernelDeps["log"];
}

/**
 * 一个已完成 setup 的插件实例（一代）：清单、来源、权限、部署配置，以及它经 ctx 做过的全部登记（账）。
 * 同一插件升级 / 重新加载会产生新实例（generation 加一），旧实例 `dispose` 后它的登记全部撤销；
 * 旧模块代码留在内存里直到进程重启（ESM 无法卸载）。
 */
export class PluginInstance {
  readonly name: string;
  readonly version: string;
  readonly sha256: string | null;
  readonly source: PluginSource;
  readonly generation: number;
  readonly manifest: PluginManifest;
  readonly permissions: PermissionSet;
  readonly configHash: string;
  readonly config: unknown;
  readonly entryUrl: string;
  readonly inflight: InflightTracker;
  private readonly ctx: KernelPluginContext;
  private readonly log: KernelDeps["log"];
  private disposing: Promise<void> | undefined;

  constructor(init: PluginInstanceInit) {
    this.manifest = init.manifest;
    this.name = init.manifest.name;
    this.version = init.manifest.version;
    this.sha256 = init.sha256;
    this.source = init.source;
    this.generation = init.generation;
    this.permissions = init.permissions;
    this.configHash = init.configHash;
    this.config = init.config;
    this.entryUrl = init.entryUrl;
    this.ctx = init.ctx;
    this.log = init.log;
    this.inflight = new InflightTracker(this.name);
  }

  /** 提供的能力（撤销后为空）。 */
  get provided(): ReadonlyMap<CapabilityRef, unknown> {
    return this.ctx.provided;
  }
  get routes(): readonly Route[] {
    return this.ctx.routes;
  }
  get tools(): readonly RegisteredTool[] {
    return this.ctx.registeredTools;
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
   * 撤销本实例（幂等；调用方应先把它从注册表摘下或替换掉）。依次：
   * 1. 停止接新的（在途计数关闭、队列 worker 停止取新任务）；
   * 2. 等在途的工具调用结束，最多 `drainMs`；队列 worker 的进行中任务同一截止时刻；
   * 3. 中止：余下的在途调用以 `PluginUnloadedError` 结束（模型收到 `PLUGIN_UNLOADED_TOOL_ERROR`），`ctx.signal` abort；
   * 4. 逐项（倒序）撤销账上的登记；
   * 5. 调插件的 `dispose(ctx)`（抛错只记日志）；
   * 6. 关闭 ctx（队列连接、未完成的审计写入）。第 6 步失败时抛出（由调用方记日志）。
   * `waitQueueJobs`（停机路径）：队列 worker 一直等进行中的任务结束，不按截止时刻强制关闭。
   */
  dispose(opts: { drainMs: number; waitQueueJobs?: boolean }): Promise<void> {
    this.disposing ??= this.doDispose(opts);
    return this.disposing;
  }

  private async doDispose(opts: { drainMs: number; waitQueueJobs?: boolean }): Promise<void> {
    const deadline = Date.now() + Math.max(0, opts.drainMs);
    this.inflight.close();
    if (!opts.waitQueueJobs) {
      await this.ctx.beginDispose(deadline).catch((err: unknown) => {
        this.log.warn("plugin queue pause failed", { plugin: this.name, err });
      });
    }
    const drained = await this.inflight.drain(Math.max(0, deadline - Date.now()));
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
      try {
        await this.manifest.dispose(this.ctx);
      } catch (err) {
        this.log.warn("plugin dispose() failed", { plugin: this.name, err });
      }
    }
    await this.ctx.close();
  }
}

/** {@link setupInstance} / {@link loadInstance} 的依赖。 */
export interface LoadDeps {
  kernel: KernelDeps;
  capabilityAccess: CapabilityAccess;
  /** 该插件下一代的编号（宿主按插件名递增）。 */
  nextGeneration(name: string): number;
}

/** 在已导入、已核对的清单上建 ctx（记账）并 setup；setup 抛错时撤销已登记的再抛。 */
export async function setupInstance(
  deps: LoadDeps,
  manifest: PluginManifest,
  input: {
    entryUrl: string;
    source: PluginSource;
    sha256: string | null;
    config: unknown;
    configHash: string;
    permissions: PermissionSet;
    /** 已建好 ctx、setup 进行中时回调（宿主据此在 close() 时立即关闭它）。 */
    onCtx?: (ctx: KernelPluginContext | undefined) => void;
  },
): Promise<PluginInstance> {
  const ctx = createPluginContext(deps.kernel, manifest, input.config, deps.capabilityAccess);
  input.onCtx?.(ctx);
  try {
    await manifest.setup(ctx);
    ctx.sealTools();
    for (const cap of manifest.provides) {
      if (!ctx.provided.has(cap)) {
        throw new Error(`declared capability ${cap} was not provided by setup`);
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
  return new PluginInstance({
    manifest,
    source: input.source,
    sha256: input.sha256,
    generation: deps.nextGeneration(manifest.name),
    permissions: input.permissions,
    configHash: input.configHash,
    config: input.config,
    entryUrl: input.entryUrl,
    ctx,
    log: deps.kernel.log,
  });
}

/**
 * 加载一个插件实例：import → definePlugin → 有包内静态清单（`section`）时与 {@link staticManifestOf} 核对
 * （名字与静态清单都须一致，否则抛 {@link ManifestMismatchError}；配置声明 / 内置插件没有 section，跳过核对）
 * → 建 ctx（记账）→ setup；setup 抛错时撤销已登记的再抛。
 * 不做权限闸门、部署配置校验与迁移（宿主在此之前完成）；`config` 为已校验的部署配置。
 */
export async function loadInstance(
  deps: LoadDeps,
  input: {
    entryUrl: string;
    source: PluginSource;
    sha256: string | null;
    config: unknown;
    configHash: string;
    permissions: PermissionSet;
    /** 安装记录的包内静态清单与插件名（审阅过的那份）。 */
    section?: { name: string; manifest: StaticPluginManifest };
    onCtx?: (ctx: KernelPluginContext | undefined) => void;
  },
): Promise<PluginInstance> {
  const label = input.section?.name ?? input.entryUrl;
  const manifest = await importPluginModule(
    input.entryUrl,
    label,
    dirname(fileURLToPath(input.entryUrl)),
  );
  if (input.section && !matchesSection(manifest, input.section.name, input.section.manifest)) {
    throw new ManifestMismatchError(input.section.name, manifest.name);
  }
  return setupInstance(deps, manifest, input);
}
