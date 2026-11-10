import {
  act,
  type ComponentType,
  createElement,
  type ReactElement,
  type ReactNode,
  useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createPrefixedStorage,
  type HostApi,
  HostContext,
  type HostContextValue,
} from "../context.js";
import type { ClientExtension } from "../define.js";
import { clientHost, DESIGN_NAMES, setClientHost } from "../design.js";
import type { ComponentSlotId } from "../slots.generated.js";
import type { CapybaraEvent, ClientApi, ClientRole, RunState, UiView } from "../types.js";

export interface FakeHostOptions {
  slot: ComponentSlotId;
  /** The slot's render args (`conversationId`, `agentId`, ...). */
  args?: Record<string, unknown>;
  plugin?: string;
  contribution?: string;
  role?: ClientRole;
  orgId?: string | null;
  locale?: "zh" | "en";
  runState?: RunState;
  /** The view `useView` returns. */
  view?: UiView;
  /** Answers `useAction()` calls; default resolves `{}`. */
  onAction?: HostApi["action"];
  /** Listeners of a client extension's `events`, called on `emit` like in the real host. */
  events?: ClientExtension["events"];
  reducedMotion?: boolean;
  /** The id `useSignIn()` and the listeners' `api.signIn` carry; default "test-sign-in". */
  signInId?: string;
}

export interface FakeHost {
  emit(e: CapybaraEvent): void;
  setRunState(s: RunState): void;
  rerender(): void;
  unmount(): void;
}

type DesignStub = ComponentType<{ children?: ReactNode }>;

/** Plain stand-ins for the host's design components: `<span data-fake-design="Name">`. */
function fakeDesign(): Record<string, ComponentType<never>> {
  const out: Record<string, DesignStub> = {};
  for (const name of DESIGN_NAMES) {
    out[name] = ({ children }) => createElement("span", { "data-fake-design": name }, children);
  }
  return out as Record<string, ComponentType<never>>;
}

/**
 * Renders `element` inside a fake host (what the real host provides per component): the slot, the
 * role, the locale, the run state, the sign-in, the view and the design stand-ins. Needs a DOM (jsdom).
 */
export function renderWithFakeHost(element: ReactElement, options: FakeHostOptions): FakeHost {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const plugin = options.plugin ?? "test-plugin";
  const subscribers = new Set<(e: CapybaraEvent) => void>();
  const storage = createPrefixedStorage(plugin);
  const locale = options.locale ?? "en";
  const assetUrl = (path: string) => `/api/v1/client/${plugin}/test-build/assets/${path}`;
  const signIn = { id: options.signInId ?? "test-sign-in" };
  const clientApi: ClientApi = {
    locale,
    reducedMotion: options.reducedMotion ?? false,
    storage,
    assetUrl,
    signIn,
  };
  const previousHost = clientHost();
  setClientHost({ design: fakeDesign() });

  // Stable across renders, like the real host's (useCapybaraEvents resubscribes on change).
  const subscribe: HostApi["subscribe"] = (handler) => {
    subscribers.add(handler);
    return () => subscribers.delete(handler);
  };

  let setRun: (s: RunState) => void = () => {};

  function Provider({ children }: { children: ReactNode }) {
    const [runState, setRunState] = useState<RunState>(options.runState ?? "idle");
    setRun = setRunState;
    const api: HostApi = {
      view: {
        view: options.view ?? null,
        status: options.view ? "ready" : "loading",
        retry: () => {},
      },
      action: options.onAction ?? (async () => ({})),
      orgId: options.orgId === undefined ? "org_test" : options.orgId,
      role: options.role ?? "member",
      locale,
      runState,
      conversationId:
        typeof options.args?.conversationId === "string" ? options.args.conversationId : null,
      reducedMotion: clientApi.reducedMotion,
      theme: { key: null, scheme: "dark" },
      storage,
      assetUrl,
      signIn,
      subscribe,
    };
    const value: HostContextValue = {
      plugin,
      contribution: options.contribution ?? "test",
      slot: options.slot,
      args: options.args ?? {},
      api,
    };
    return createElement(HostContext.Provider, { value }, children);
  }

  const draw = () =>
    act(() => {
      root.render(createElement(Provider, null, element));
    });
  draw();

  return {
    emit(e) {
      act(() => {
        for (const s of [...subscribers]) s(e);
      });
      const listener = options.events?.[e.type] as
        | ((e: CapybaraEvent, api: ClientApi) => void)
        | undefined;
      listener?.(e, clientApi);
    },
    setRunState(s) {
      act(() => setRun(s));
    },
    rerender() {
      draw();
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
      setClientHost(previousHost);
    },
  };
}
