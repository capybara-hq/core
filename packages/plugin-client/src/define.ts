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

export interface ClientComponent<S extends ComponentSlotId = ComponentSlotId> {
  readonly slot: S;
  readonly render: ComponentType<ComponentProps<S>>;
}

/** Binds a component to the slot it is written for; the host checks it against the manifest. */
export function defineComponent<S extends ComponentSlotId>(
  slot: S,
  render: ComponentType<ComponentProps<S>>,
): ClientComponent<S> {
  return { slot, render };
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
  /** CLIENT_API_VERSION at build time. */
  readonly apiVersion: number;
}

/** The entry module's default export. */
export function defineClientExtension(def: ClientExtensionDefinition): ClientExtension {
  return { ...def, apiVersion: CLIENT_API_VERSION };
}
