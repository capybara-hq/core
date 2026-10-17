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
} from "@capybara-hq/plugin-sdk";
import { secretValues, unreachableSecrets } from "../config/fields.js";
import {
  createPluginContext,
  type KernelDeps,
  pluginSchemaName,
  type Route,
} from "../ctx/create-ctx.js";
import { migrate } from "../db/migrator.js";
import { resolvePlugins } from "./resolve.js";

interface Loaded {
  manifest: PluginManifest;
  provided: Map<CapabilityRef, unknown>;
  routes: Route[];
  close(): Promise<void>;
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

/** 导入并校验各插件清单，按依赖拓扑排序；同时返回每个插件模块所在目录。 */
async function importPlugins(
  specifiers: string[],
  resolveFrom: string,
): Promise<{ ordered: PluginManifest[]; dirs: Map<string, string> }> {
  const entries: { manifest: PluginManifest; dir: string }[] = [];
  for (const spec of specifiers) {
    const url = toFileUrl(spec, resolveFrom);
    let mod: { default?: unknown };
    try {
      mod = (await import(url)) as { default?: unknown };
    } catch (e) {
      throw new Error(`cannot import plugin "${spec}" from "${resolveFrom}": ${errMsg(e)}`, {
        cause: e,
      });
    }
    if (typeof mod.default !== "object" || mod.default === null)
      throw new Error(`plugin module "${spec}" has no default export object`);
    let manifest: PluginManifest;
    try {
      manifest = definePlugin(mod.default as PluginManifest);
    } catch (e) {
      throw new PluginManifestError(spec, errMsg(e));
    }
    entries.push({ manifest, dir: dirname(fileURLToPath(url)) });
  }
  const dirs = new Map(entries.map((e) => [e.manifest.name, e.dir]));
  const ordered = resolvePlugins(
    entries.map((e) => e.manifest),
    SDK_VERSION,
  );
  return { ordered, dirs };
}

/** 跑单个插件的迁移（若声明了 migrations）；返回已应用的文件，无迁移时返回 undefined。 */
async function migratePlugin(
  dbUrl: string,
  manifest: PluginManifest,
  dir: string,
  connectTimeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<{ schema: string; applied: string[] } | undefined> {
  if (!manifest.migrations) return undefined;
  const schema = pluginSchemaName(manifest.name);
  try {
    const { applied } = await migrate(
      dbUrl,
      { schema, dir: resolvePath(dir, manifest.migrations) },
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
function assertSecretsReachable(manifest: PluginManifest): void {
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

/** 插件宿主：解析、校验配置、迁移、setup，并登记插件提供的能力与路由。 */
export class PluginHost {
  /**
   * 只解析插件并按依赖顺序跑迁移，不校验部署配置、不调用 setup、不需要 Redis（供 `capybara migrate`）。
   * 与 `load()` 一样先检查密钥标记（`assertSecretsReachable`），有问题的插件一个都不迁移。
   * 返回每个声明了迁移的插件及其本次应用的文件。
   */
  static async migrateOnly(
    specifiers: string[],
    opts: { dbUrl: string; resolveFrom?: string; connectTimeoutMs?: number },
  ): Promise<{ plugin: string; schema: string; applied: string[] }[]> {
    const { ordered, dirs } = await importPlugins(
      specifiers,
      resolvePath(opts.resolveFrom ?? process.cwd()),
    );
    for (const manifest of ordered) assertSecretsReachable(manifest);
    const out: { plugin: string; schema: string; applied: string[] }[] = [];
    for (const manifest of ordered) {
      const r = await migratePlugin(
        opts.dbUrl,
        manifest,
        dirs.get(manifest.name) as string,
        opts.connectTimeoutMs,
      );
      if (r) out.push({ plugin: manifest.name, ...r });
    }
    return out;
  }

  private readonly loaded: Loaded[] = [];
  private didLoad = false;
  private closed = false;
  /** close() 时中止进行中的插件迁移。 */
  private readonly abort = new AbortController();
  /** 进行中的插件迁移（close() 等它结束，保证迁移连接不比宿主活得久）。 */
  private migrating: Promise<unknown> | undefined;
  /** 已创建、尚未登记（setup 进行中）的 ctx：close() 时立即关闭，不等 setup 返回。 */
  private pending: { close(): Promise<void> } | undefined;
  private readonly resolveFrom: string;
  private readonly onSecrets: ((values: string[]) => void) | undefined;

  /**
   * @param opts.resolveFrom 解析裸包名的目录，默认 `process.cwd()`；相对路径按构造时的 cwd 转为绝对路径。
   * 绝对路径与 `file:` URL 的插件 specifier 直接使用；
   * 裸包名经 `createRequire(<resolveFrom>/noop.js).resolve` 解析，因此插件包的 exports 必须暴露
   * `default`（或 `require`）条件。
   */
  constructor(
    private readonly deps: KernelDeps,
    private readonly pluginConfig: Record<string, unknown> = {},
    opts: { resolveFrom?: string; onSecrets?: (values: string[]) => void } = {},
  ) {
    this.onSecrets = opts.onSecrets;
    this.resolveFrom = resolvePath(opts.resolveFrom ?? process.cwd());
  }

  /**
   * 导入各插件模块（default 导出）并按依赖顺序初始化；只能调用一次。
   * 插件 setup 永不返回时 load()（进而内核 `start()`）永远挂起：内核不给 setup 设超时；
   * 此时 `close()` / 内核 `stop()` 仍会立即关闭该插件的 ctx 并释放资源。
   * 加载期间宿主被 `close()` 时：进行中的迁移被中止、setup 中的 ctx 被立即关闭（此后其 queue 的
   * define / add 抛 `queue is closed`），load() 在下一个检查点抛 `plugin host closed during load`。
   */
  async load(specifiers: string[]): Promise<void> {
    if (this.closed) throw new Error(CLOSED_DURING_LOAD);
    if (this.didLoad) throw new Error("plugin host already loaded; load() may be called once");
    this.didLoad = true;
    const { ordered, dirs } = await importPlugins(specifiers, this.resolveFrom);

    const orphans = Object.keys(this.pluginConfig).filter(
      (k) => !ordered.some((m) => m.name === k),
    );
    if (orphans.length > 0) {
      this.deps.log.warn("pluginConfig has keys for plugins that are not loaded", {
        keys: orphans,
      });
    }

    for (const manifest of ordered) assertSecretsReachable(manifest);

    for (const manifest of ordered) {
      const name = manifest.name;
      const raw = this.pluginConfig[name] ?? {};
      let config: unknown = raw;
      const schema = manifest.config?.deployment;
      if (schema) {
        const r = schema.safeParse(raw);
        if (!r.success) {
          const detail = r.error.issues
            .map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`)
            .join("; ");
          throw new Error(`plugin ${name}: invalid deployment config: ${detail}`);
        }
        config = r.data;
        if (this.onSecrets) {
          const values = secretValues(schema, config);
          if (values.length > 0) this.onSecrets(values);
        }
      }
      if (this.closed) throw new Error(CLOSED_DURING_LOAD);
      this.migrating = migratePlugin(
        this.deps.dbUrl,
        manifest,
        dirs.get(name) as string,
        this.deps.connectTimeoutMs,
        this.abort.signal,
      );
      try {
        await this.migrating;
      } catch (e) {
        if (this.closed) throw new Error(CLOSED_DURING_LOAD, { cause: e });
        throw e;
      } finally {
        this.migrating = undefined;
      }
      if (this.closed) throw new Error(CLOSED_DURING_LOAD);
      const ctx = createPluginContext(this.deps, manifest, config);
      this.pending = ctx;
      try {
        await manifest.setup(ctx);
        for (const cap of manifest.provides) {
          if (!ctx.provided.has(cap)) {
            throw new Error(`declared capability ${cap} was not provided by setup`);
          }
        }
      } catch (e) {
        await this.closeQuietly(ctx, name);
        if (this.closed) throw new Error(CLOSED_DURING_LOAD, { cause: e });
        throw new Error(`plugin ${name}: setup failed: ${errMsg(e)}`, { cause: e });
      } finally {
        this.pending = undefined;
      }
      if (this.closed) {
        await this.closeQuietly(ctx, name);
        throw new Error(CLOSED_DURING_LOAD);
      }
      this.loaded.push({ manifest, provided: ctx.provided, routes: ctx.routes, close: ctx.close });
    }
  }

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

  /** 列出提供某能力（任意主版本）的所有插件及实现。 */
  list(capabilityName: string): { plugin: string; impl: unknown }[] {
    const out: { plugin: string; impl: unknown }[] = [];
    for (const l of this.loaded) {
      for (const [cap, impl] of l.provided) {
        if (parseCapability(cap).name === capabilityName) {
          out.push({ plugin: l.manifest.name, impl });
        }
      }
    }
    return out;
  }

  /** 已加载插件的清单（按加载顺序，即依赖拓扑序）。 */
  manifests(): PluginManifest[] {
    return this.loaded.map((l) => l.manifest);
  }

  /** 所有插件注册的 HTTP 路由（路径已带 `/plugins/<name>` 前缀）。 */
  routes(): Route[] {
    return this.loaded.flatMap((l) => l.routes);
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
    const pending = this.pending;
    this.pending = undefined;
    await pending?.close().catch((e: unknown) => {
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
