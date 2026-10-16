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

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 插件宿主：解析、校验配置、迁移、setup，并登记插件提供的能力与路由。 */
export class PluginHost {
  private readonly loaded: Loaded[] = [];
  private didLoad = false;
  private readonly resolveFrom: string;

  /**
   * @param opts.resolveFrom 解析裸包名的目录，默认 `process.cwd()`。绝对路径与 `file:` URL 直接使用；
   * 裸包名经 `createRequire(<resolveFrom>/noop.js).resolve` 解析，因此插件包的 exports 必须暴露
   * `default`（或 `require`）条件。
   */
  constructor(
    private readonly deps: KernelDeps,
    private readonly pluginConfig: Record<string, unknown> = {},
    opts: { resolveFrom?: string } = {},
  ) {
    this.resolveFrom = opts.resolveFrom ?? process.cwd();
  }

  /** 把 specifier 解析成模块文件 URL；失败时错误点名 specifier 与 resolveFrom。 */
  private toFileUrl(spec: string): string {
    try {
      if (spec.startsWith("file:")) return spec;
      if (isAbsolute(spec)) return pathToFileURL(spec).href;
      const file = createRequire(join(this.resolveFrom, "noop.js")).resolve(spec);
      return pathToFileURL(file).href;
    } catch (e) {
      throw new Error(`cannot resolve plugin "${spec}" from "${this.resolveFrom}": ${errMsg(e)}`, {
        cause: e,
      });
    }
  }

  /** 导入各插件模块（default 导出）并按依赖顺序初始化；只能调用一次。 */
  async load(specifiers: string[]): Promise<void> {
    if (this.didLoad) throw new Error("plugin host already loaded; load() may be called once");
    this.didLoad = true;
    const entries: { manifest: PluginManifest; dir: string }[] = [];
    for (const spec of specifiers) {
      const url = this.toFileUrl(spec);
      let mod: { default?: unknown };
      try {
        mod = (await import(url)) as { default?: unknown };
      } catch (e) {
        throw new Error(`cannot import plugin "${spec}" from "${this.resolveFrom}": ${errMsg(e)}`, {
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
      }
      if (manifest.migrations) {
        const dir = resolvePath(dirs.get(name) as string, manifest.migrations);
        try {
          await migrate(this.deps.dbUrl, { schema: pluginSchemaName(name), dir });
        } catch (e) {
          throw new Error(`plugin ${name}: migration failed: ${errMsg(e)}`, { cause: e });
        }
      }
      const ctx = createPluginContext(this.deps, manifest, config);
      try {
        await manifest.setup(ctx);
        for (const cap of manifest.provides) {
          if (!ctx.provided.has(cap)) {
            throw new Error(`declared capability ${cap} was not provided by setup`);
          }
        }
      } catch (e) {
        await ctx.close().catch(() => {});
        throw new Error(`plugin ${name}: setup failed: ${errMsg(e)}`, { cause: e });
      }
      this.loaded.push({ manifest, provided: ctx.provided, routes: ctx.routes, close: ctx.close });
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

  /** 所有插件注册的 HTTP 路由（路径已带 `/plugins/<name>` 前缀）。 */
  routes(): Route[] {
    return this.loaded.flatMap((l) => l.routes);
  }

  /** 关闭所有插件的队列。 */
  async close(): Promise<void> {
    await Promise.all(this.loaded.map((l) => l.close()));
  }
}
