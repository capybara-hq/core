"use client";

import {
  type IconName,
  InlineCard,
  LoadFailed,
  PropertySection,
  RightPanel,
  type RightPanelSwitcher,
} from "@capybara-hq/design";
import { useLocale } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError } from "../../lib/api";
import { type UiContributionItem, type UiIcon, type UiOpen, uiKey, uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import { EmbedTab } from "../extension-ui/EmbedTab";
import {
  useExtensionViews,
  useUiAction,
  type ViewState,
  type ViewTarget,
} from "../extension-ui/ExtensionViewTab";
import { UiViewRenderer } from "../ui-view/UiViewRenderer";
import { BlockBoundary } from "./BlockBoundary";

/** A contribution's icon (SDK `UI_ICONS`) as a design icon. */
export const ICON_OF: Record<UiIcon, IconName> = {
  "list-checks": "list-checks",
  "layout-grid": "extension",
  file: "file",
  chart: "trending-up",
  calendar: "extension",
  users: "user",
  bot: "agent",
  book: "skills",
  "message-square": "channel",
  puzzle: "extension",
};

/** The common inputs of an extension block on the conversation page. */
export type BlockContext = {
  orgId: string;
  conversationId: string;
  /** Refresh counters (`event: ui`; `*` after a reconnect). */
  versions: Readonly<Record<string, number>>;
  /** Opens an open target: `contribution` is a panel of the same extension. */
  onOpen(plugin: string, target: UiOpen): void;
};

/**
 * Loads one view (its own request, 10 s timeout, aborted on unmount; never blocks the thread).
 * `target` null: not yet (an inline card that has not been in view).
 */
function useOneView(ctx: BlockContext, target: ViewTarget | null) {
  const locale = uiLocale(useLocale());
  const targets = useMemo(() => (target === null ? [] : [target]), [target]);
  const views = useExtensionViews(ctx.orgId, targets, {
    conversationId: ctx.conversationId,
    locale,
    versions: ctx.versions,
  });
  const runAction = useUiAction(ctx.orgId, {
    conversationId: ctx.conversationId,
    locale,
    onView: views.setView,
  });
  const key = target === null ? "" : (target.key ?? uiKey(target.plugin, target.id));
  return {
    state: target === null ? undefined : (views.states[key] as ViewState | undefined),
    retry: () => views.retry(key),
    onAction: target === null ? async () => {} : runAction(target),
  };
}

/**
 * Whether an element is in (or near) the viewport; always true where IntersectionObserver is
 * missing. Inline cards load and refresh only while seen (final review I4).
 */
function useInView(el: Element | null): boolean {
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.target === el) setInView(e.isIntersecting);
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return inView;
}

const blockState = (s: ViewState | undefined) =>
  s === undefined || s.kind === "loading" ? "loading" : s.kind === "error" ? "failed" : "ready";

function useReason(s: ViewState | undefined): string | undefined {
  const errorMessage = useErrorMessage();
  return s?.kind === "error" ? errorMessage(new ApiClientError(0, s.code, s.code)) : undefined;
}

// ── Inline card ────────────────────────────────────────────────────────────

function InlineCardBody({
  ctx,
  contribution,
  callId,
  cardKey,
  hasPanel,
  visible,
}: {
  ctx: BlockContext;
  contribution: UiContributionItem;
  callId: string;
  cardKey?: string;
  hasPanel: UiContributionItem | undefined;
  visible: boolean;
}) {
  const locale = uiLocale(useLocale());
  const target = useMemo<ViewTarget>(
    () => ({
      plugin: contribution.plugin,
      id: contribution.id,
      key: `${uiKey(contribution.plugin, contribution.id)}#${callId}`,
      card: { callId, ...(cardKey !== undefined ? { key: cardKey } : {}) },
    }),
    [contribution.plugin, contribution.id, callId, cardKey],
  );
  const source = contribution.title[locale];
  if (contribution.kind === "embed") {
    return (
      <InlineCard source={source} state="ready" embed live>
        <EmbedTab
          orgId={ctx.orgId}
          plugin={contribution.plugin}
          id={contribution.id}
          title={source}
          conversationId={ctx.conversationId}
          failed={({ message, onRetry }) => (
            <LoadFailed name={source} reason={message} onRetry={onRetry} />
          )}
        />
      </InlineCard>
    );
  }
  return <ViewCard ctx={ctx} target={target} source={source} panel={hasPanel} visible={visible} />;
}

/**
 * An inline view card. It loads when first in view and refetches on a refresh only while in view;
 * a refresh while out of view is fetched when the card is seen again (final review I4): a long
 * conversation's many cards cost a few GETs per change, not one each.
 */
function ViewCard({
  ctx,
  target,
  source,
  panel,
  visible,
}: {
  ctx: BlockContext;
  target: ViewTarget;
  source: string;
  panel: UiContributionItem | undefined;
  visible: boolean;
}) {
  const seen = useRef<Readonly<Record<string, number>> | null>(null);
  if (visible) seen.current = ctx.versions;
  const versions = seen.current;
  const v = useOneView(
    useMemo(() => ({ ...ctx, versions: versions ?? {} }), [ctx, versions]),
    versions === null ? null : target,
  );
  const reason = useReason(v.state);
  const view = v.state?.kind === "ready" ? v.state.view : undefined;
  const expand = view?.open ?? (panel ? { contribution: panel.id } : undefined);
  return (
    <InlineCard
      source={source}
      state={blockState(v.state)}
      {...(reason !== undefined ? { failure: { reason } } : {})}
      onRetry={v.retry}
      {...(view?.badge !== undefined ? { badge: view.badge } : {})}
      {...(expand ? { onExpand: () => ctx.onOpen(target.plugin, expand) } : {})}
    >
      {view ? (
        <UiViewRenderer
          view={view}
          onAction={v.onAction}
          onOpen={(o) => ctx.onOpen(target.plugin, o)}
        />
      ) : null}
    </InlineCard>
  );
}

/**
 * An inline card under a tool call (`tool_result.card`): shown only while its extension's `inline`
 * contribution is listed (enabled in the org).
 */
export function ExtensionCard({
  ctx,
  contributions,
  plugin,
  view,
  callId,
  cardKey,
}: {
  ctx: BlockContext;
  contributions: UiContributionItem[];
  plugin: string;
  view: string;
  callId: string;
  cardKey?: string;
}): ReactNode {
  const locale = uiLocale(useLocale());
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const visible = useInView(el);
  const c = contributions.find((x) => x.plugin === plugin && x.id === view && x.place === "inline");
  if (!c) return null;
  const panel = contributions.find((x) => x.plugin === plugin && x.place === "panel");
  return (
    <div data-extension-card={uiKey(plugin, view)} ref={setEl}>
      <BlockBoundary name={c.title[locale]}>
        <InlineCardBody
          ctx={ctx}
          contribution={c}
          callId={callId}
          {...(cardKey !== undefined ? { cardKey } : {})}
          hasPanel={panel}
          visible={visible}
        />
      </BlockBoundary>
    </div>
  );
}

// ── Properties section ─────────────────────────────────────────────────────

function SectionBody({ ctx, c }: { ctx: BlockContext; c: UiContributionItem }) {
  const locale = uiLocale(useLocale());
  const title = c.title[locale];
  const target = useMemo<ViewTarget>(() => ({ plugin: c.plugin, id: c.id }), [c.plugin, c.id]);
  const v = useOneView(ctx, target);
  const reason = useReason(v.state);
  const view = v.state?.kind === "ready" ? v.state.view : undefined;
  return (
    <PropertySection
      title={title}
      state={blockState(v.state)}
      {...(reason !== undefined ? { failure: { reason } } : {})}
      onRetry={v.retry}
      {...(view?.badge !== undefined ? { value: view.badge } : {})}
    >
      {view ? (
        <UiViewRenderer view={view} onAction={v.onAction} onOpen={(o) => ctx.onOpen(c.plugin, o)} />
      ) : null}
    </PropertySection>
  );
}

/** An extension's properties section (`place: "section"`), failing alone. */
export function ExtensionSection({ ctx, c }: { ctx: BlockContext; c: UiContributionItem }) {
  const locale = uiLocale(useLocale());
  if (c.kind === "embed") {
    return (
      <div data-extension-section={uiKey(c.plugin, c.id)}>
        <PropertySection title={c.title[locale]}>
          <EmbedTab
            orgId={ctx.orgId}
            plugin={c.plugin}
            id={c.id}
            title={c.title[locale]}
            conversationId={ctx.conversationId}
            failed={({ message, onRetry }) => (
              <LoadFailed name={c.title[locale]} reason={message} onRetry={onRetry} />
            )}
          />
        </PropertySection>
      </div>
    );
  }
  return (
    <div data-extension-section={uiKey(c.plugin, c.id)}>
      <BlockBoundary name={c.title[locale]}>
        <SectionBody ctx={ctx} c={c} />
      </BlockBoundary>
    </div>
  );
}

// ── Right panel ────────────────────────────────────────────────────────────

/** Scrolls the panel to `[data-ui-item="<item>"]` once it shows. */
function useScrollToItem(item: string | undefined, ready: boolean) {
  useEffect(() => {
    if (!ready || item === undefined) return;
    const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(item) : item;
    const el = document.querySelector(`[data-part="right-panel"] [data-ui-item="${esc}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === "function")
      (el as HTMLElement).scrollIntoView({ block: "center" });
  }, [item, ready]);
}

function ViewPanel({
  ctx,
  c,
  item,
  frame,
}: {
  ctx: BlockContext;
  c: UiContributionItem;
  item: string | undefined;
  frame: Omit<Parameters<typeof RightPanel>[0], "children">;
}) {
  const target = useMemo<ViewTarget>(
    () => ({
      plugin: c.plugin,
      id: c.id,
      ...(item !== undefined ? { item, key: `${uiKey(c.plugin, c.id)}/${item}` } : {}),
    }),
    [c.plugin, c.id, item],
  );
  const v = useOneView(ctx, target);
  const reason = useReason(v.state);
  const view = v.state?.kind === "ready" ? v.state.view : undefined;
  useScrollToItem(item, view !== undefined);
  return (
    <RightPanel
      {...frame}
      state={blockState(v.state)}
      {...(reason !== undefined ? { failure: { reason } } : {})}
      onRetry={v.retry}
      {...(view?.badge !== undefined ? { meta: view.badge } : {})}
    >
      {view ? (
        <UiViewRenderer view={view} onAction={v.onAction} onOpen={(o) => ctx.onOpen(c.plugin, o)} />
      ) : null}
    </RightPanel>
  );
}

/**
 * An extension's right panel (`place: "panel"`, the old `conversation` place too): a rendered view
 * (scrolled to the open target's item) or an embed page. Fails alone.
 */
export function ExtensionPanel({
  ctx,
  c,
  item,
  switcher,
  onClose,
  onFullscreen,
}: {
  ctx: BlockContext;
  c: UiContributionItem;
  item: string | undefined;
  switcher?: RightPanelSwitcher;
  onClose(): void;
  onFullscreen(): void;
}) {
  const locale = uiLocale(useLocale());
  const title = c.title[locale];
  const frame = {
    title,
    ...(switcher ? { switcher } : {}),
    onClose,
    onFullscreen,
    body: c.kind === "embed" ? ("flush" as const) : ("pad" as const),
  };
  // No wrapper: the panel fills the panel slot (height 100%).
  return c.kind === "embed" ? (
    <RightPanel {...frame}>
      <EmbedTab
        key={`${uiKey(c.plugin, c.id)}/${ctx.conversationId}`}
        orgId={ctx.orgId}
        plugin={c.plugin}
        id={c.id}
        title={title}
        conversationId={ctx.conversationId}
        failed={({ message, onRetry }) => (
          <LoadFailed name={title} reason={message} onRetry={onRetry} />
        )}
      />
    </RightPanel>
  ) : (
    <BlockBoundary name={title}>
      <ViewPanel ctx={ctx} c={c} item={item} frame={frame} />
    </BlockBoundary>
  );
}
