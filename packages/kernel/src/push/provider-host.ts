import { PUSH_PROVIDER_EXTENSION_POINT, type PushProvider } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { ExtensionRegistry, ExtensionRegistryModule } from "../extensions/registry.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";

/** One app id and the push providers whose credentials cover it. */
export interface PushCoverage {
  appId: string;
  providers: string[];
}

/**
 * Reads the `push-provider@1` extensions the registry holds. Nothing is cached (the public meta
 * calls {@link coverage} on every request): `apps()` is synchronous and derived from deployment
 * config, so a disabled or reconfigured provider is reflected at once.
 */
@Injectable()
export class PushProviderHost {
  constructor(
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /** The `@1` provider of `plugin`, or null when it provides none (or is not loaded). */
  provider(plugin: string): PushProvider | null {
    const entry = this.registry
      .list("push-provider")
      .find((e) => e.plugin === plugin && e.capability === PUSH_PROVIDER_EXTENSION_POINT);
    return entry === undefined ? null : (entry.impl as PushProvider);
  }

  /** Whether `plugin`'s credentials cover `appId`; a throwing `apps()` counts as not covered. */
  covers(plugin: string, appId: string): boolean {
    const provider = this.provider(plugin);
    if (provider === null) return false;
    return this.appsOf(plugin, provider, "warn").includes(appId);
  }

  /** Every covered app id with its providers, sorted by app id, then provider name. */
  coverage(): PushCoverage[] {
    const byApp = new Map<string, Set<string>>();
    for (const entry of this.registry.list("push-provider")) {
      if (entry.capability !== PUSH_PROVIDER_EXTENSION_POINT) continue;
      for (const appId of this.appsOf(entry.plugin, entry.impl as PushProvider, "debug")) {
        const set = byApp.get(appId) ?? new Set<string>();
        set.add(entry.plugin);
        byApp.set(appId, set);
      }
    }
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...byApp.keys()].sort(cmp).map((appId) => ({
      appId,
      providers: [...(byApp.get(appId) as Set<string>)].sort(cmp),
    }));
  }

  /** Whether any push provider is loaded (the fanout gate). */
  any(): boolean {
    return this.registry
      .list("push-provider")
      .some((e) => e.capability === PUSH_PROVIDER_EXTENSION_POINT);
  }

  /**
   * `apps()` of one provider; a throw is logged with the plugin name only (never config). The
   * public meta lists coverage on every request, so that path logs at debug, not warn.
   */
  private appsOf(
    plugin: string,
    provider: PushProvider,
    level: "warn" | "debug",
  ): readonly string[] {
    try {
      return provider.apps();
    } catch {
      this.log[level]("push provider apps() failed", { plugin });
      return [];
    }
  }
}

/** {@link PushProviderHost}: below the extension host, imported by the domains that push. */
@Module({
  imports: [ExtensionRegistryModule],
  providers: [PushProviderHost],
  exports: [PushProviderHost],
})
export class PushHostModule {}
