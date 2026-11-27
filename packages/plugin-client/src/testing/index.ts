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
  type BoardCard,
  type BoardProps,
  clientHost,
  type DataTableProps,
  DESIGN_NAMES,
  type DialogProps,
  type InputProps,
  type PrincipalPickerProps,
  type SelectProps,
  type SwitchProps,
  setClientHost,
  type TabsProps,
  type TextareaProps,
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
 * or flips the switch the way a person would. `DataTable` is a table of its rows (a click on a
 * row calls `onOpen`; `data-state` is its `state`, a loading or failed table lists no rows, an
 * empty ready one shows `noResults` with a Clear button, else `empty`), `Tabs` a row of
 * `role="tab"` buttons, `Dialog` a `role="dialog"` while open, `Input` / `Textarea` plain
 * controls, `PrincipalPicker` a button per option, and `Board` its cards with one "Move <card> to
 * <column>" button per column (they call `onMove` at index 0, unless `canMove` refuses).
 *
 * Where they differ from the host: templates draw no header, path or crumbs (only their
 * children) and the host's one-template rule of a page frame is not checked; links are not
 * normalized; DataTable has no sorting, pagination, row menus, toolbar or error state body;
 * every other component (Sheet, Popover, DangerConfirm, Menu among them) is the plain span with
 * its `children` only (a Menu's items, a trigger and props are not drawn); no styles, focus
 * handling or keyboard behaviour. Test those against the host itself.
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
  const FakeDataTable = (props: DataTableProps<unknown>) => {
    const state = props.state ?? "ready";
    // an empty ready table draws its `noResults` (a filter matched nothing) or `empty`, as the
    // host's table does; a loading or failed one draws no rows
    const placeholder =
      state === "ready" && props.rows.length === 0
        ? props.noResults
          ? createElement(
              "tr",
              { "data-fake-empty": "no-results" },
              createElement(
                "td",
                null,
                props.noResults.description,
                createElement(
                  "button",
                  { type: "button", onClick: () => props.noResults?.onClear() },
                  "Clear",
                ),
              ),
            )
          : props.empty
            ? createElement(
                "tr",
                { "data-fake-empty": "empty" },
                createElement("td", null, props.empty.title, props.empty.hint ?? null),
              )
            : null
        : null;
    return createElement(
      "table",
      { "data-fake-design": "DataTable", "aria-label": props.label, "data-state": state },
      createElement(
        "thead",
        null,
        createElement(
          "tr",
          null,
          ...props.columns.map((c) => createElement("th", { key: c.key }, c.header)),
        ),
      ),
      createElement(
        "tbody",
        null,
        placeholder,
        ...(state === "ready" ? props.rows : []).map((row) =>
          createElement(
            "tr",
            {
              key: props.rowKey(row),
              "data-row-key": props.rowKey(row),
              onClick: props.onOpen ? () => props.onOpen?.(row) : undefined,
            },
            ...props.columns.map((c) => createElement("td", { key: c.key }, c.cell(row))),
          ),
        ),
      ),
    );
  };
  out.DataTable = FakeDataTable as ComponentType<never>;
  const FakeTabs = (props: TabsProps) =>
    createElement(
      "div",
      { role: "tablist", "aria-label": props.label, "data-fake-design": "Tabs" },
      ...props.items.map((it) =>
        createElement(
          "button",
          {
            key: it.id,
            type: "button",
            role: "tab",
            disabled: it.disabled,
            "aria-selected": it.id === props.value,
            onClick: () => props.onChange?.(it.id),
          },
          it.label,
        ),
      ),
    );
  out.Tabs = FakeTabs as ComponentType<never>;
  const FakeDialog = (props: DialogProps) =>
    props.open
      ? createElement(
          "div",
          { role: "dialog", "aria-label": props.title, "data-fake-design": "Dialog" },
          createElement(
            "button",
            { type: "button", "aria-label": "Close", onClick: () => props.onOpenChange(false) },
            "x",
          ),
          props.children,
          props.footer,
        )
      : null;
  out.Dialog = FakeDialog as ComponentType<never>;
  const FakeInput = (props: InputProps) =>
    createElement("input", {
      type: props.type ?? "text",
      value: props.value,
      placeholder: props.placeholder,
      disabled: props.disabled,
      readOnly: props.readOnly,
      id: props.id,
      name: props.name,
      "aria-label": props["aria-label"],
      "aria-describedby": props["aria-describedby"],
      "aria-invalid": props.invalid ? true : undefined,
      "data-fake-design": "Input",
      onChange: (e: { target: { value: string } }) =>
        props.onChange?.({ target: { value: e.target.value } }),
    });
  out.Input = FakeInput as ComponentType<never>;
  const FakeTextarea = (props: TextareaProps) =>
    createElement("textarea", {
      value: props.value,
      placeholder: props.placeholder,
      disabled: props.disabled,
      readOnly: props.readOnly,
      rows: props.rows,
      id: props.id,
      name: props.name,
      "aria-label": props["aria-label"],
      "aria-describedby": props["aria-describedby"],
      "data-fake-design": "Textarea",
      onChange: (e: { target: { value: string } }) =>
        props.onChange?.({ target: { value: e.target.value } }),
    });
  out.Textarea = FakeTextarea as ComponentType<never>;
  const FakePrincipalPicker = (props: PrincipalPickerProps) =>
    createElement(
      "div",
      { role: "group", "aria-label": props["aria-label"], "data-fake-design": "PrincipalPicker" },
      ...props.options.map((o) =>
        createElement(
          "button",
          {
            key: o.id,
            type: "button",
            disabled: props.disabled || o.disabled,
            "aria-pressed": props.value.includes(o.id),
            onClick: () =>
              props.onChange(
                props.multiple
                  ? props.value.includes(o.id)
                    ? props.value.filter((id) => id !== o.id)
                    : [...props.value, o.id]
                  : [o.id],
              ),
          },
          o.name,
        ),
      ),
    );
  out.PrincipalPicker = FakePrincipalPicker as ComponentType<never>;
  const FakeBoard = (props: BoardProps<BoardCard>) =>
    props.cards.length === 0 && !props.loading && props.empty !== undefined
      ? createElement("div", { "data-fake-design": "Board" }, props.empty)
      : createElement(
          "div",
          { "data-fake-design": "Board" },
          ...props.columns.map((col) =>
            createElement(
              "section",
              { key: col.id, "data-column": col.id, "aria-label": col.title },
              createElement("h3", null, col.title),
              ...props.cards
                .filter((c) => c.columnId === col.id)
                .map((card) =>
                  createElement(
                    "div",
                    { key: card.id, "data-card": card.id },
                    createElement(
                      "button",
                      { type: "button", onClick: () => props.onOpen?.(card.id) },
                      props.renderCard(card),
                    ),
                    ...props.columns
                      .filter((to) => to.id !== card.columnId)
                      .map((to) =>
                        createElement(
                          "button",
                          {
                            key: to.id,
                            type: "button",
                            "aria-label": `Move ${card.id} to ${to.id}`,
                            disabled: props.canMove ? !props.canMove(card, to.id) : false,
                            onClick: () => void props.onMove(card.id, to.id, 0),
                          },
                          "move",
                        ),
                      ),
                  ),
                ),
            ),
          ),
        );
  out.Board = FakeBoard as ComponentType<never>;
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
