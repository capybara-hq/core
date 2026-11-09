"use client";

// The registry of loaded client extensions (client extensions spec §9.4, §11): what each entry
// module of the document's set became, and the checks an entry passes before it is activated.
import type { ComponentType, ReactNode } from "react";
import { createContext, useContext } from "react";
import type { ClientExtensionItem, ClientReportKind } from "../../lib/client-extensions";
import type { CapybaraEvent } from "./events";

/** `ClientComponent` of `@capybara-hq/plugin-client` (the web does not import the package). */
export interface ClientComponent {
  readonly slot: string;
  readonly render: ComponentType<Record<string, unknown>>;
}

/** `ClientApi` of `@capybara-hq/plugin-client`: what `events` listeners get. */
export interface ClientApi {
  locale: "zh" | "en";
  reducedMotion: boolean;
  storage: {
    get(key: string, scope?: "local" | "session"): string | null;
    set(key: string, value: string | null, scope?: "local" | "session"): void;
  };
  assetUrl(path: string): string;
}

/** `ClientExtension` of `@capybara-hq/plugin-client`: an entry module's default export. */
export interface ClientExtension {
  name: string;
  /**
   * Stamped by the host's own `defineClientExtension` (the import map resolves the plugin's call to
   * it), so it is the host's version: see {@link validateEntry}.
   */
  readonly apiVersion: number;
  components?: Record<string, ClientComponent>;
  events?: Partial<Record<CapybaraEvent["type"], (e: CapybaraEvent, api: ClientApi) => void>>;
}

export type RegistryStatus = "loading" | "ready" | "failed" | "disabled";

export interface RegistryEntry {
  status: RegistryStatus;
  /** Set when `ready`: the definition with only the components the host activated. */
  definition?: ClientExtension;
}

/** `plugin → entry`, for the plugins of the document's set. */
export type ClientRegistry = Record<string, RegistryEntry>;

const RegistryContext = createContext<ClientRegistry>({});
export const ClientRegistryProvider = RegistryContext.Provider;

/** The client extensions of this document and their state (empty in safe mode or without code). */
export function useClientRegistry(): ClientRegistry {
  return useContext(RegistryContext);
}

const ShellBannerContext = createContext<ReactNode>(null);
export const ShellBannerProvider = ShellBannerContext.Provider;

/**
 * The shell-wide banner the host asks the frame to draw (safe mode's, spec §10.1), or null: the
 * frame passes it to the App Shell, which draws it as its first row (never above the shell).
 */
export function useShellBanner(): ReactNode {
  return useContext(ShellBannerContext);
}

/** What the host offers the blocks that render client components (Task 18's boundaries). */
export interface ClientHostControls {
  /** The set's item of a plugin (its build: asset URLs, reports). */
  item(plugin: string): ClientExtensionItem | undefined;
  /**
   * A plugin's error (a boundary catch: `render`; a listener throw: `event`): reported once per
   * (plugin, build, contribution, kind) and counted by the crash budget.
   */
  reportError(
    plugin: string,
    contribution: string | null,
    kind: Exclude<ClientReportKind, "budget">,
    error: unknown,
  ): void;
  /**
   * Subscribes a component of the plugin to client events: delivered only while the plugin is
   * active (listed, loaded, within its budget); a throwing handler counts as an `event` error.
   * Returns the unsubscribe function.
   */
  subscribe(
    plugin: string,
    contribution: string | null,
    handler: (e: CapybaraEvent) => void,
  ): () => void;
}

const ControlsContext = createContext<ClientHostControls>({
  item: () => undefined,
  reportError: () => {},
  subscribe: () => () => {},
});
export const ClientHostControlsProvider = ControlsContext.Provider;

export function useClientHostControls(): ClientHostControls {
  return useContext(ControlsContext);
}

/** Why an entry or one of its components is not activated. */
export interface EntryProblem {
  kind: "load" | "api";
  contribution: string | null;
  message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Checks an entry module against the set's item (spec §9.4): the default export must be a
 * `ClientExtension` named as the plugin, stamped with `apiVersion`; each component must be a
 * contribution the item lists for the viewer, bound to the same slot. A component the item does not
 * list (another role's, or none) is left out silently; one bound to another slot is left out and
 * reported. A bad entry activates nothing.
 */
export function validateEntry(
  mod: unknown,
  item: ClientExtensionItem,
  apiVersion: number,
): { definition: ClientExtension | null; problems: EntryProblem[] } {
  const def = isObject(mod) ? mod.default : undefined;
  if (!isObject(def) || typeof def.name !== "string") {
    return {
      definition: null,
      problems: [
        {
          kind: "load",
          contribution: null,
          message: "the entry's default export is not a client extension (defineClientExtension)",
        },
      ],
    };
  }
  if (def.name !== item.plugin) {
    return {
      definition: null,
      problems: [
        {
          kind: "load",
          contribution: null,
          message: `the entry is named "${def.name.slice(0, 100)}", not "${item.plugin}"`,
        },
      ],
    };
  }
  // Defence in depth: a real bundle's `defineClientExtension` resolves to the host's, which stamps
  // the host's version, so only a hand-made default export can differ here. The gate that holds is
  // the kernel's (it delivers only builds of the client API version it supports, spec §4.2).
  if (def.apiVersion !== apiVersion) {
    return {
      definition: null,
      problems: [
        {
          kind: "api",
          contribution: null,
          message: `the entry was built for client API ${String(def.apiVersion).slice(0, 20)}; the host supports ${apiVersion}`,
        },
      ],
    };
  }
  const problems: EntryProblem[] = [];
  const components: Record<string, ClientComponent> = {};
  const listed = new Map(item.components.map((c) => [c.id, c.slot]));
  if (isObject(def.components)) {
    for (const [id, c] of Object.entries(def.components)) {
      const slot = listed.get(id);
      if (slot === undefined) continue;
      if (!isObject(c) || (typeof c.render !== "function" && !isObject(c.render))) {
        problems.push({ kind: "api", contribution: id, message: "the component has no render" });
      } else if (c.slot !== slot) {
        problems.push({
          kind: "api",
          contribution: id,
          message: `the component is bound to ${String(c.slot).slice(0, 100)}, the manifest to ${slot}`,
        });
      } else {
        components[id] = c as unknown as ClientComponent;
      }
    }
  }
  const events = isObject(def.events) ? (def.events as ClientExtension["events"]) : undefined;
  const definition: ClientExtension = {
    name: def.name,
    apiVersion,
    components,
    ...(events !== undefined && { events }),
  };
  return { definition, problems };
}
