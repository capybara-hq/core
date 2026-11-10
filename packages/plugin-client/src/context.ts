import { createContext } from "react";
import type { ComponentSlotId } from "./slots.generated.js";
import type {
  CapybaraEvent,
  ClientRole,
  ClientStorage,
  JsonValue,
  RunState,
  SignIn,
  UiView,
} from "./types.js";

/** Thrown by a hook used outside a component the host rendered. */
export class PluginClientContextError extends Error {
  constructor(hook: string) {
    super(
      `${hook}() can only be used inside a component the Capybara host rendered ` +
        "(a component registered with defineComponent); there is no host context here.",
    );
    this.name = "PluginClientContextError";
  }
}

export interface ViewState {
  view: UiView | null;
  status: "loading" | "ready" | "failed";
  retry(): void;
}

export type ActionFn = (
  actionId: string,
  input?: { payload?: JsonValue; answer?: Record<string, unknown> },
) => Promise<{ view?: UiView; toast?: string }>;

/**
 * What the host implements per rendered component; the hooks read it, nothing else. The host keeps
 * the functions (`action`, `assetUrl`, `subscribe`) and `storage` referentially stable across
 * renders: `useCapybaraEvents` resubscribes whenever `subscribe` changes.
 */
export interface HostApi {
  view: ViewState;
  action: ActionFn;
  orgId: string | null;
  role: ClientRole;
  locale: "zh" | "en";
  runState: RunState;
  conversationId: string | null;
  reducedMotion: boolean;
  theme: { key: string | null; scheme: "dark" | "light" };
  storage: ClientStorage;
  assetUrl(path: string): string;
  signIn: SignIn;
  /** Subscribes to client events; returns the unsubscribe function. */
  subscribe(handler: (e: CapybaraEvent) => void): () => void;
}

export interface HostContextValue {
  plugin: string;
  contribution: string;
  slot: ComponentSlotId;
  args: Record<string, unknown>;
  api: HostApi;
}

export const HostContext = createContext<HostContextValue | null>(null);

/** `localStorage` / `sessionStorage` under `cap-ext:<plugin>:`; a blocked store reads as empty. */
export function createPrefixedStorage(plugin: string): ClientStorage {
  const prefix = `cap-ext:${plugin}:`;
  const store = (scope: "local" | "session"): Storage | null => {
    try {
      return scope === "session" ? globalThis.sessionStorage : globalThis.localStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key, scope = "local") {
      try {
        return store(scope)?.getItem(prefix + key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value, scope = "local") {
      try {
        const s = store(scope);
        if (!s) return;
        if (value === null) s.removeItem(prefix + key);
        else s.setItem(prefix + key, value);
      } catch {
        // a blocked or full store: ignore
      }
    },
  };
}
