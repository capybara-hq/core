import {
  act,
  type ComponentType,
  createElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createPrefixedStorage,
  type HostApi,
  HostContext,
  type HostContextValue,
  type NavigateTarget,
  type QueryState,
} from "../context.js";
import type { ClientExtension } from "../define.js";
import {
  clientHost,
  DESIGN_NAMES,
  type SelectProps,
  type SwitchProps,
  setClientHost,
} from "../design.js";
import type { ComponentSlotId } from "../slots.generated.js";
import type {
  CapybaraEvent,
  ClientApi,
  ClientRole,
  JsonValue,
  RunState,
  SizeClass,
  UiView,
  ViewportSegment,
} from "../types.js";

const EMPTY_PARAMS: Record<string, string> = {};

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
  /** What `useSizeClass()` returns; default null. */
  sizeClass?: SizeClass | null;
  /** What `useViewportSegments()` returns; default null. */
  viewportSegments?: ViewportSegment[] | null;
  /**
   * The in-memory query table behind `usePluginQuery`: query id to a function of the params. A
   * query missing from the table, or one that throws, reads as `status: "error"`.
   */
  queries?: Record<string, (params: JsonValue) => unknown>;
  /** What `usePageParams()` returns; default `{}`. */
  params?: Record<string, string>;
}

export interface FakeHost {
  /** Refetches the named queries, like an action result's `invalidate`. */
  invalidate(queries: string[]): void;
  /** How many times the query function of `query` has run. */
  queryCalls(query: string): number;
  /** The targets `useNavigate()` passed to the host, in order. */
  navigations: NavigateTarget[];
  emit(e: CapybaraEvent): void;
  setRunState(s: RunState): void;
  rerender(): void;
  unmount(): void;
}

/**
 * Plain stand-ins for the host's design components: `<span data-fake-design="Name">`. `Select` is
 * a native select over its options and `Switch` a `role="switch"` button, so a test picks a value
 * or flips the switch the way a person would.
 */
function fakeDesign(): Record<string, ComponentType<never>> {
  const out: Record<string, ComponentType<never>> = {};
  for (const name of DESIGN_NAMES) {
    const Stub = ({ children }: { children?: ReactNode }) =>
      createElement("span", { "data-fake-design": name }, children);
    out[name] = Stub as ComponentType<never>;
  }
  const FakeSelect = (props: SelectProps) =>
    createElement(
      "select",
      {
        value: props.value ?? "",
        disabled: props.disabled,
        "aria-label": props["aria-label"],
        "aria-labelledby": props["aria-labelledby"],
        "data-fake-design": "Select",
        onChange: (e: { target: { value: string } }) =>
          props.onChange?.({ target: { value: e.target.value } }),
      },
      props.placeholder === undefined
        ? null
        : createElement("option", { key: "__placeholder", value: "" }, props.placeholder),
      ...props.options.map((o) =>
        createElement("option", { key: o.value, value: o.value, disabled: o.disabled }, o.label),
      ),
    );
  out.Select = FakeSelect as ComponentType<never>;
  const FakeSwitch = (props: SwitchProps) =>
    createElement("button", {
      type: "button",
      role: "switch",
      id: props.id,
      disabled: props.disabled,
      "aria-checked": props.checked,
      "aria-label": props.label,
      "aria-describedby": props["aria-describedby"],
      "data-fake-design": "Switch",
      onClick: () => props.onChange(!props.checked),
    });
  out.Switch = FakeSwitch as ComponentType<never>;
  return out;
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

  const calls = new Map<string, number>();
  const navigations: NavigateTarget[] = [];
  const queryListeners = new Set<(names: string[]) => void>();
  const runQuery = (query: string, params: JsonValue): unknown => {
    const fn = options.queries?.[query];
    if (!fn) throw new Error(`no fake query "${query}"`);
    calls.set(query, (calls.get(query) ?? 0) + 1);
    return fn(params);
  };
  // A hook the fake host's `api.query` runs inside the component calling `usePluginQuery`.
  function useFakeQuery<T>(query: string, params: JsonValue): QueryState<T> {
    const key = JSON.stringify([query, params]);
    const [version, setVersion] = useState(0);
    const [state, setState] = useState<Omit<QueryState<T>, "refetch">>({
      data: undefined,
      status: "loading",
    });
    useEffect(() => {
      const listener = (names: string[]) => {
        if (names.includes(query)) setVersion((v) => v + 1);
      };
      queryListeners.add(listener);
      return () => void queryListeners.delete(listener);
    }, [query]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for query and params
    useEffect(() => {
      let live = true;
      Promise.resolve()
        .then(() => runQuery(query, params))
        .then(
          (data) => live && setState({ data: data as T, status: "ready" }),
          (e: unknown) =>
            live &&
            setState({
              data: undefined,
              status: "error",
              error: e instanceof Error ? e.message : String(e),
            }),
        );
      return () => {
        live = false;
      };
    }, [key, version]);
    return { ...state, refetch: () => setVersion((v) => v + 1) };
  }

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
      sizeClass: options.sizeClass ?? null,
      viewportSegments: options.viewportSegments ?? null,
      subscribe,
      query: useFakeQuery,
      pageParams: options.params ?? EMPTY_PARAMS,
      navigate: (to) => void navigations.push(to),
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
    invalidate(names) {
      act(() => {
        for (const l of [...queryListeners]) l(names);
      });
    },
    queryCalls: (query) => calls.get(query) ?? 0,
    navigations,
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
