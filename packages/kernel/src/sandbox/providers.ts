import { SANDBOX_EXTENSION_POINT, type SandboxProvider } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ExtensionRegistry } from "../extensions/registry.js";
import { guardProviderConnection } from "./unreachable.js";

/** 当前的 `sandbox@2` 提供方：插件名与实现。 */
export interface SandboxProviderEntry {
  plugin: string;
  impl: SandboxProvider;
}

/**
 * The `sandbox@2` providers of this process, read from the {@link ExtensionRegistry} at every
 * call: providers are ready only after the extension load, and change with installs. Every
 * provider is handed out guarded: a network-level failure to reach it is rethrown as
 * `SandboxProviderUnreachableError` (`./unreachable.ts`), so the tools can tell it apart.
 */
@Injectable()
export class SandboxProviders {
  constructor(
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
  ) {}

  /** The current provider; undefined without one. */
  current(): SandboxProviderEntry | undefined {
    const e = this.registry.list("sandbox").find((x) => x.capability === SANDBOX_EXTENSION_POINT);
    return e
      ? { plugin: e.plugin, impl: guardProviderConnection(e.impl as SandboxProvider) }
      : undefined;
  }

  /** A still-loaded provider by plugin name (to destroy an earlier provider's instance). */
  lookup(plugin: string): SandboxProvider | undefined {
    const impl = this.registry
      .list("sandbox")
      .find((x) => x.capability === SANDBOX_EXTENSION_POINT && x.plugin === plugin)?.impl as
      | SandboxProvider
      | undefined;
    return impl && guardProviderConnection(impl);
  }
}
