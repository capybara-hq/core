"use client";

import { useToast } from "@capybara-hq/design";
import { useLocale } from "next-intl";
import {
  Component,
  type ComponentType,
  createElement,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormAnswer } from "../../lib/conversations";
import { useAppMutation } from "../../lib/query/mutation";
import { postUiAction, type UiContributionItem, type UiView, uiKey, uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import {
  type ActionFn,
  type HostApi,
  HostContext,
  type HostContextValue,
  useHostServices,
  type ViewState,
} from "../client-ext/host-api";
import { useClientHostControls, useClientRegistry } from "../client-ext/registry";
import { BlockBoundary } from "../conversation/BlockBoundary";
import { targetKey, useExtensionViews, type ViewTarget } from "./ExtensionViewTab";

/**
 * The slot args a component is rendered with (its slot's scope args, client extensions spec §5.2):
 * what its server view and actions are read with. `orgId` null: a platform page.
 */
export interface ComponentArgs {
  orgId: string | null;
  conversationId?: string;
  agentId?: string;
  item?: string;
  card?: { callId: string; key?: string };
}

type Render = ComponentType<Record<string, unknown>>;

/** A contribution's client component in the document's registry: its render, or why there is none. */
export type ComponentLookup =
  | { status: "ready"; render: Render }
  | { status: "loading" }
  /** Not delivered, failed to load, off (safe mode, kill switch, crash budget) or not built. */
  | { status: "none" };

const LOADING: ComponentLookup = { status: "loading" };
const NONE: ComponentLookup = { status: "none" };

/**
 * Looks a `component` contribution up in the client registry (spec §11): `ready` once its plugin's
 * entry loaded and activated a component of that id bound to the same slot; `loading` while the
 * entry loads; `none` otherwise (safe mode and the kill switch leave the registry empty; a failed
 * or session-disabled plugin is `failed` / `disabled`).
 */
export function useClientComponent(
  c: Pick<UiContributionItem, "plugin" | "id" | "slot" | "kind"> | undefined,
): ComponentLookup {
  const registry = useClientRegistry();
  if (c === undefined || c.kind !== "component") return NONE;
  const entry = registry[c.plugin];
  if (entry?.status === "loading") return LOADING;
  if (entry?.status !== "ready") return NONE;
  const comp = entry.definition?.components?.[c.id];
  return comp !== undefined && comp.slot === c.slot
    ? { status: "ready", render: comp.render }
    : NONE;
}

/**
 * Whether the document's client set has a plugin, not failed or off, with a component for `slot`
 * (the viewer's components of the set, spec §9.2). The shell slots read the contributions only
 * then: a document without client code for them makes no read and draws the built-in.
 */
export function useSlotHasClientCode(slot: string): boolean {
  const registry = useClientRegistry();
  const controls = useClientHostControls();
  return Object.entries(registry).some(
    ([plugin, e]) =>
      (e.status === "loading" || e.status === "ready") &&
      (controls.item(plugin)?.components.some((c) => c.slot === slot) ?? false),
  );
}

/**
 * Renders one client component inside its host context (the plugin, contribution, slot, args and
 * the host api the plugin-client hooks read). The component gets its slot's props plus `plugin`,
 * `contribution` and `slot`. The server view is read only once the component asks for it
 * (`useView`): a component's server side is optional.
 */
export function ComponentHost({
  c,
  args,
  render,
  hostProps,
}: {
  c: UiContributionItem;
  args: ComponentArgs;
  render: Render;
  hostProps: Record<string, unknown>;
}) {
  const { plugin, id, slot } = c;
  const services = useHostServices(plugin, id);
  const locale = uiLocale(useLocale());
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { orgId, conversationId, agentId, item, card } = args;
  const callId = card?.callId;
  const cardKey = card?.key;
  const target = useMemo<ViewTarget>(
    () => ({
      plugin,
      id,
      ...(item !== undefined && { item, key: `${uiKey(plugin, id)}/${item}` }),
      ...(callId !== undefined && {
        card: { callId, ...(cardKey !== undefined && { key: cardKey }) },
        key: `${uiKey(plugin, id)}#${callId}`,
      }),
    }),
    [plugin, id, item, callId, cardKey],
  );
  const key = targetKey(target);

  // The view is read once the component reads `useView()` (a getter below), not before.
  const [wanted, setWanted] = useState(false);
  const asked = useRef(false);
  const targets = useMemo(() => (wanted ? [target] : []), [wanted, target]);
  const views = useExtensionViews(orgId, targets, {
    ...(conversationId !== undefined && { conversationId }),
    ...(agentId !== undefined && { agentId }),
    locale,
  });
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const state = views.states[key];
  const retry = useCallback(() => viewsRef.current.retry(key), [key]);
  const view = useMemo<ViewState>(
    () =>
      state?.kind === "ready"
        ? { view: state.view, status: "ready", retry }
        : { view: null, status: state?.kind === "error" ? "failed" : "loading", retry },
    [state, retry],
  );

  // The answer is a new view (it replaces the component's) or a toast: nothing to invalidate.
  const { mutateAsync } = useAppMutation({
    fn: (req: { actionId: string; payload?: unknown; answer?: FormAnswer }) =>
      postUiAction(orgId, plugin, id, {
        ...req,
        ...(conversationId !== undefined && { conversationId }),
        ...(agentId !== undefined && { agentId }),
        locale,
      }),
    invalidates: () => [],
  });
  const latest = useRef({ mutateAsync, toast, errorMessage });
  latest.current = { mutateAsync, toast, errorMessage };
  const action = useCallback<ActionFn>(
    async (actionId, input) => {
      const { mutateAsync: run, toast: show, errorMessage: messageOf } = latest.current;
      let r: Awaited<ReturnType<typeof postUiAction>>;
      try {
        r = await run({
          actionId,
          ...(input?.payload !== undefined && { payload: input.payload }),
          ...(input?.answer !== undefined && { answer: input.answer as FormAnswer }),
        });
      } catch (e) {
        throw new Error(messageOf(e));
      }
      if (r !== undefined && "view" in r) {
        viewsRef.current.setView(key, r.view);
        return { view: r.view as UiView };
      }
      if (r?.toast) {
        // shown by the host, as for a view's action; the component gets the text too
        show.success(r.toast[locale]);
        return { toast: r.toast[locale] };
      }
      return {};
    },
    [key, locale],
  );

  const api = useMemo<HostApi>(() => {
    const value = { ...services, action } as HostApi;
    Object.defineProperty(value, "view", {
      enumerable: true,
      get: () => {
        if (!asked.current) {
          asked.current = true;
          // after this render: a state update is never made while rendering
          queueMicrotask(() => setWanted(true));
        }
        return view;
      },
    });
    return value;
  }, [services, action, view]);

  const scopeArgs = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (conversationId !== undefined) out.conversationId = conversationId;
    if (agentId !== undefined) out.agentId = agentId;
    if (item !== undefined) out.item = item;
    if (callId !== undefined) out.card = { callId, ...(cardKey !== undefined && { key: cardKey }) };
    return out;
  }, [conversationId, agentId, item, callId, cardKey]);
  const ctx = useMemo<HostContextValue>(
    () => ({ plugin, contribution: id, slot, args: scopeArgs, api }),
    [plugin, id, slot, scopeArgs, api],
  );
  return (
    <HostContext.Provider value={ctx}>
      {createElement(render, { ...hostProps, plugin, contribution: id, slot })}
    </HostContext.Provider>
  );
}

/**
 * The error boundary of a client component that has a fallback instead of a failure line (a
 * replaceable slot: the built-in; the overlay: nothing; spec §10.3). Once it caught, it stays on
 * the fallback for this mount (no retry on re-render, so one crash is reported once); `onError`
 * hears the catch.
 */
export class ClientBoundary extends Component<
  { fallback: ReactNode; onError(error: unknown): void; children?: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * A `component` contribution in a list slot (client extensions spec §11): nothing until its module
 * is registered (nothing on the server or the first client render, so hydration never mismatches),
 * then the component inside its own `BlockBoundary` (a crash shows the block's failure line and is
 * reported to the host, which counts it against the plugin's crash budget). `frame` draws the
 * slot's frame around the block (the section, panel, card or form section the views get), only
 * once the component is there; `quiet` (the overlay) draws nothing instead of the failure line.
 */
export function ClientComponentBlock({
  c,
  args,
  hostProps,
  frame,
  quiet,
}: {
  c: UiContributionItem;
  args: ComponentArgs;
  hostProps: Record<string, unknown>;
  frame?: (body: ReactNode) => ReactNode;
  quiet?: boolean;
}): ReactNode {
  const found = useClientComponent(c);
  const controls = useClientHostControls();
  const locale = uiLocale(useLocale());
  const onError = useCallback(
    (error: unknown) => controls.reportError(c.plugin, c.id, "render", error),
    [controls, c.plugin, c.id],
  );
  if (found.status !== "ready") return null;
  const body = <ComponentHost c={c} args={args} render={found.render} hostProps={hostProps} />;
  const block = quiet ? (
    <ClientBoundary fallback={null} onError={onError}>
      {body}
    </ClientBoundary>
  ) : (
    <BlockBoundary name={c.title[locale]} onError={onError}>
      {body}
    </BlockBoundary>
  );
  return frame ? frame(block) : block;
}
