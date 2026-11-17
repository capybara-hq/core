import { SANDBOX_EXTENSION_POINT, type SandboxProvider } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ExtensionRegistry } from "../extensions/registry.js";
import { guardProviderConnection } from "./unreachable.js";

/** The kernel-internal provider of connected machines (local devices). */
export const LOCAL_PROVIDER = "@local";

/**
 * A kernel-internal provider name: it starts with `@`, which no extension name can
 * (`EXTENSION_NAME_RE`), so it never collides with a loaded `sandbox@2` plugin.
 */
export const isInternalProvider = (name: string): boolean => name.startsWith("@");

/**
 * Post-commit binding of a committed instance generation (permission runtime cutover B4/B-8).
 * Present only on the staged v3 registration of a kernel-internal provider; protocol 2 has none.
 */
export interface SandboxInstanceBinder {
  /**
   * The binding committed for the device's current instance generation: installed, still awaiting
   * the device, or null when none was committed (an instance from before the staged path).
   */
  status(deviceId: string): Promise<"installed" | "awaiting-device" | null>;
  /**
   * Sends the committed binding (the same binding id on every retry) and installs the verified
   * answer; refuses while a legacy retirement obligation is open. Never inside a transaction.
   */
  bind(deviceId: string, signal: AbortSignal): Promise<unknown>;
}

/** A sandbox provider: its name (plugin name, or an internal `@…` name) and implementation. */
export interface SandboxProviderEntry {
  plugin: string;
  version?: string;
  impl: SandboxProvider;
  /**
   * The staged path's instance binder: the exclusive lifecycle holder binds the generation before
   * it downgrades, and shared use waits for an installed binding. Absent on protocol 2.
   */
  binder?: SandboxInstanceBinder;
}

/**
 * The sandbox providers of this process. The cloud provider is the loaded `sandbox@2` extension,
 * read from the {@link ExtensionRegistry} at every call (providers are ready only after the
 * extension load, and change with installs). Kernel-internal providers (`@local`) are registered
 * by their module on init, in every replica: they are code, not shared state.
 *
 * Every `sandbox@2` extension is handed out guarded: a network-level failure to reach it is
 * rethrown as `SandboxProviderUnreachableError` (`./unreachable.ts`), so the tools can tell it
 * apart. Internal providers are not: their failures (the device relay's Redis, the machine's
 * connection) are the kernel's own and have their own errors.
 */
@Injectable()
export class SandboxProviders {
  private readonly internal = new Map<string, SandboxProviderEntry>();

  constructor(
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
  ) {}

  /** Registers a kernel-internal provider (an `@…` name); a later registration replaces it. */
  register(entry: SandboxProviderEntry): void {
    if (!isInternalProvider(entry.plugin)) {
      throw new Error(`an internal sandbox provider name starts with @: ${entry.plugin}`);
    }
    this.internal.set(entry.plugin, entry);
  }

  /** The cloud provider (the loaded `sandbox@2` extension); undefined without one. */
  cloud(): SandboxProviderEntry | undefined {
    const e = this.registry.list("sandbox").find((x) => x.capability === SANDBOX_EXTENSION_POINT);
    return e
      ? {
          plugin: e.plugin,
          version: e.version,
          impl: guardProviderConnection(e.impl as SandboxProvider),
        }
      : undefined;
  }

  /**
   * A provider by name: a registered internal provider, else a still-loaded `sandbox@2` extension
   * of that plugin name (to destroy an earlier provider's resources).
   */
  forName(name: string): SandboxProviderEntry | undefined {
    const own = this.internal.get(name);
    if (own) return own;
    const e = this.registry
      .list("sandbox")
      .find((x) => x.capability === SANDBOX_EXTENSION_POINT && x.plugin === name);
    return e
      ? {
          plugin: e.plugin,
          version: e.version,
          impl: guardProviderConnection(e.impl as SandboxProvider),
        }
      : undefined;
  }
}

/**
 * The provider a device works with, from its `devices.provider`: an internal one
 * (`@local`) by that name only, never falling back to the cloud provider; any other device
 * is a cloud device and uses the current cloud provider (files kept by another provider are
 * refused by the sandbox service, `device.unavailable`).
 */
export function providerForDevice(
  providers: Pick<SandboxProviders, "cloud" | "forName">,
  provider: string | null,
): SandboxProviderEntry | undefined {
  if (provider !== null && isInternalProvider(provider)) return providers.forName(provider);
  return providers.cloud();
}
