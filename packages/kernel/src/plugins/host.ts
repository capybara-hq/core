import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_CARDINALITY,
  type CapabilityRef,
  type PluginManifest,
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

  constructor(
    private readonly deps: KernelDeps,
    private readonly pluginConfig: Record<string, unknown> = {},
  ) {}

  /** 导入各插件模块（default 导出）并按依赖顺序初始化。 */
  async load(specifiers: string[]): Promise<void> {
    const entries: { manifest: PluginManifest; dir: string }[] = [];
    for (const spec of specifiers) {
      const mod = (await import(spec)) as { default?: PluginManifest };
      if (!mod.default) throw new Error(`plugin module "${spec}" has no default export`);
      entries.push({
        manifest: mod.default,
        dir: dirname(fileURLToPath(import.meta.resolve(spec))),
      });
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
