import type { ComponentType } from "react";
import type { ComponentSlotId } from "./slots.generated.js";
import type {
  BaseComponentProps,
  CapybaraEventOf,
  CapybaraEventType,
  ClientApi,
  SlotComponentProps,
} from "./types.js";

/** Bumped only on an incompatible change of the client API. */
export const CLIENT_API_VERSION = 1;

export type ComponentProps<S extends ComponentSlotId> = BaseComponentProps & SlotComponentProps[S];

/**
 * A component bound to one slot: `render` takes that slot's props. Without a type argument (or
 * with a union of slots) it is the union of the single-slot bindings, so a `components` map may
 * hold components of different slots while each keeps its own slot's props.
 */
export type ClientComponent<S extends ComponentSlotId = ComponentSlotId> = {
  [K in S]: { readonly slot: K; readonly render: ComponentType<ComponentProps<K>> };
}[S];

/** Binds a component to the slot it is written for; the host checks it against the manifest. */
export function defineComponent<S extends ComponentSlotId>(
  slot: S,
  render: ComponentType<ComponentProps<S>>,
): ClientComponent<S> {
  return { slot, render } as ClientComponent<S>;
}

export interface ClientExtensionDefinition {
  /** Equals the plugin (and extension) name. */
  name: string;
  /** Keyed by the `component` contribution id of the extension manifest. */
  components?: Record<string, ClientComponent>;
  /** Listeners alive while the extension is loaded. */
  events?: Partial<{
    [K in CapybaraEventType]: (e: CapybaraEventOf<K>, api: ClientApi) => void;
  }>;
}

export interface ClientExtension extends ClientExtensionDefinition {
  /**
   * The client API version, stamped by `defineClientExtension`. In a browser that call resolves to
   * the host's own implementation (the import map points `@capybara-hq/plugin-client` at the host),
   * so this is the host's version, not the one the bundle was built against. The real gate is the
   * kernel's: it records the build's version from the package and delivers only builds of the
   * version it supports. The host's comparison is defence in depth.
   */
  readonly apiVersion: number;
}

/** The entry module's default export. */
export function defineClientExtension(def: ClientExtensionDefinition): ClientExtension {
  return { ...def, apiVersion: CLIENT_API_VERSION };
}
