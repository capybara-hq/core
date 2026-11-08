"use client";

import { FormSection, type RightPanelSwitcher, Stack, Text } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { EmbedFile } from "../../lib/embed-bridge";
import { retryOnMountOf } from "../../lib/query/client";
import { contributionsQuery } from "../../lib/query/conversation";
import { keys } from "../../lib/query/keys";
import { refreshUiViews } from "../../lib/query/ui";
import {
  openUiStream,
  type UiContributionItem,
  type UiOpen,
  type UiSlotId,
  uiKey,
  uiLocale,
} from "../../lib/ui";
import { UI_SLOT_SPECS } from "../../lib/ui-slots.generated";
import { BlockBoundary } from "../conversation/BlockBoundary";
import { EmbedTab } from "./EmbedTab";
import {
  type BlockContext,
  ExtensionCard,
  ExtensionPanel,
  ExtensionSection,
} from "./ExtensionBlocks";
import { ExtensionViewTab, useExtensionViews, useUiAction } from "./ExtensionViewTab";

/** What each slot's contributions are rendered with (the slot's scope args, UI slots spec §6). */
export type SlotArgs = {
  "conversation.panel": { orgId: string; conversationId: string; item?: string };
  "conversation.properties.section": { orgId: string; conversationId: string };
  "conversation.tool-result.card": {
    orgId: string;
    conversationId: string;
    card: { callId: string; key?: string };
  };
  "org.page": { orgId: string };
  "file.preview": { orgId: string; conversationId: string; fileId: string };
  "agent.detail.section": { orgId: string; agentId: string };
  "org.settings.section": { orgId: string };
  "platform.page": Record<string, never>;
};

/** Opens an open target: `contribution` is a `conversation.panel` of the same extension. */
type OnOpenTarget = (plugin: string, target: UiOpen) => void;

/** The per-call-site props a slot's renderers take (the frame around them is the page's). */
export type SlotHost = {
  "conversation.panel": {
    switcher?: RightPanelSwitcher;
    onClose(): void;
    onFullscreen(): void;
    onOpenTarget: OnOpenTarget;
  };
  "conversation.properties.section": { onOpenTarget: OnOpenTarget };
  "conversation.tool-result.card": { onOpenTarget: OnOpenTarget };
  "org.page": Record<string, never>;
  /**
   * A file previewer comes from the file's previewer list (`file-preview@1`, ordered by the
   * previewer setting), not from the contributions list: the host names it and gives the file.
   */
  "file.preview": {
    title: string;
    maxBytes: number;
    read(): Promise<EmbedFile>;
    failed(o: { message: string; onRetry(): void }): ReactNode;
  };
  "agent.detail.section": Record<string, never>;
  "org.settings.section": Record<string, never>;
  "platform.page": Record<string, never>;
};

type SlotProps<S extends UiSlotId> = {
  slot: S;
  args: SlotArgs[S];
  /** Renders only this contribution (a panel, a page, a card, a file preview). */
  select?: { plugin: string; id: string };
  /** A slot with anchors: renders the contributions placed after this anchor. */
  anchor?: string;
} & (SlotHost[S] extends Record<string, never> ? { host?: SlotHost[S] } : { host: SlotHost[S] });

/** {@link SlotProps} as one union over the slots, so `slot` narrows `args` and `host`. */
type AnySlotProps = {
  [S in UiSlotId]: {
    slot: S;
    args: SlotArgs[S];
    select?: { plugin: string; id: string };
    anchor?: string;
    host?: SlotHost[S];
  };
}[UiSlotId];

const NONE: UiContributionItem[] = [];

/**
 * The org's contributions of one slot, in the kernel's (arranged) order. A failed read (not read
 * again on mount) lists none; `pending` while the first read is on its way.
 */
export function useSlotContributions(
  orgId: string,
  slot: UiSlotId,
): { items: UiContributionItem[]; pending: boolean } {
  const q = contributionsQuery(orgId);
  const r = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  const all = r.data;
  const items = useMemo(() => (all ? all.filter((c) => c.slot === slot) : NONE), [all, slot]);
  return { items, pending: all === undefined && r.error === null };
}

/** The anchor a contribution goes after: its own, else the slot's first. */
const anchorOf = (c: UiContributionItem): string | undefined =>
  c.after ?? UI_SLOT_SPECS[c.slot].anchors[0];

const matches = (c: UiContributionItem, select: { plugin: string; id: string } | undefined) =>
  select === undefined || (c.plugin === select.plugin && c.id === select.id);

/**
 * The only way to render extension UI (UI slots spec §7): the slot's contributions (`select`: that
 * one; `anchor`: those placed after it; else all), each view or embed failing alone in its own
 * block. Draws nothing when nothing matches.
 */
export function ExtensionSlot<S extends UiSlotId>(props: SlotProps<S>): ReactNode {
  const p = props as unknown as AnySlotProps;
  switch (p.slot) {
    case "conversation.panel":
      return p.host ? <PanelSlot args={p.args} select={p.select} host={p.host} /> : null;
    case "conversation.properties.section":
      return p.host ? (
        <SectionSlot args={p.args} select={p.select} anchor={p.anchor} host={p.host} />
      ) : null;
    case "conversation.tool-result.card":
      return p.host && p.select ? <CardSlot args={p.args} select={p.select} host={p.host} /> : null;
    case "org.page":
      return p.select ? <OrgPageSlot args={p.args} select={p.select} /> : null;
    case "file.preview":
      return p.host && p.select ? (
        <FilePreviewSlot args={p.args} select={p.select} host={p.host} />
      ) : null;
    case "org.settings.section":
      return <OrgSettingsSlot args={p.args} />;
    // agent.detail.section and platform.page: rendered from Tasks 13 and 14
    default:
      return null;
  }
}

type Select = { plugin: string; id: string } | undefined;

function PanelSlot({
  args,
  select,
  host,
}: {
  args: SlotArgs["conversation.panel"];
  select: Select;
  host: SlotHost["conversation.panel"];
}) {
  const { items } = useSlotContributions(args.orgId, "conversation.panel");
  const c = items.find((x) => matches(x, select));
  if (!c) return null;
  const ctx: BlockContext = {
    orgId: args.orgId,
    conversationId: args.conversationId,
    onOpen: host.onOpenTarget,
  };
  return (
    <ExtensionPanel
      key={`${uiKey(c.plugin, c.id)}/${args.item ?? ""}`}
      ctx={ctx}
      c={c}
      item={args.item}
      {...(host.switcher ? { switcher: host.switcher } : {})}
      onClose={host.onClose}
      onFullscreen={host.onFullscreen}
    />
  );
}

function SectionSlot({
  args,
  select,
  anchor,
  host,
}: {
  args: SlotArgs["conversation.properties.section"];
  select: Select;
  anchor: string | undefined;
  host: SlotHost["conversation.properties.section"];
}) {
  const { items } = useSlotContributions(args.orgId, "conversation.properties.section");
  const shown = items.filter(
    (c) => matches(c, select) && (anchor === undefined || anchorOf(c) === anchor),
  );
  if (shown.length === 0) return null;
  const ctx: BlockContext = {
    orgId: args.orgId,
    conversationId: args.conversationId,
    onOpen: host.onOpenTarget,
  };
  return (
    <>
      {shown.map((c) => (
        <ExtensionSection key={uiKey(c.plugin, c.id)} ctx={ctx} c={c} />
      ))}
    </>
  );
}

function CardSlot({
  args,
  select,
  host,
}: {
  args: SlotArgs["conversation.tool-result.card"];
  select: { plugin: string; id: string };
  host: SlotHost["conversation.tool-result.card"];
}) {
  const cards = useSlotContributions(args.orgId, "conversation.tool-result.card").items;
  const panels = useSlotContributions(args.orgId, "conversation.panel").items;
  const c = cards.find((x) => matches(x, select));
  if (!c) return null;
  const ctx: BlockContext = {
    orgId: args.orgId,
    conversationId: args.conversationId,
    onOpen: host.onOpenTarget,
  };
  return (
    <ExtensionCard
      ctx={ctx}
      c={c}
      panel={panels.find((x) => x.plugin === c.plugin)}
      callId={args.card.callId}
      {...(args.card.key !== undefined ? { cardKey: args.card.key } : {})}
    />
  );
}

/**
 * An org page's body: a schema view from the query cache (the layout prefetched it on a first
 * load), refreshed by the org UI stream after first paint, or an embed in its sandboxed iframe
 * (which refreshes itself).
 */
function OrgPageSlot({
  args,
  select,
}: {
  args: SlotArgs["org.page"];
  select: { plugin: string; id: string };
}) {
  const locale = uiLocale(useLocale());
  const { items } = useSlotContributions(args.orgId, "org.page");
  const c = items.find((x) => matches(x, select));
  if (!c) return null;
  const key = uiKey(c.plugin, c.id);
  return (
    <BlockBoundary name={c.title[locale]}>
      {c.kind === "embed" ? (
        <OrgPageEmbed key={key} orgId={args.orgId} c={c} />
      ) : (
        <OrgPageView key={key} orgId={args.orgId} c={c} />
      )}
    </BlockBoundary>
  );
}

/**
 * The extension sections of the org settings page: one `FormSection` per contribution, titled by
 * its title, whose body is the view or the embed (the kernel serves the slot to org admins and
 * owners only; the page does not render the slot for anyone else).
 */
function OrgSettingsSlot({ args }: { args: SlotArgs["org.settings.section"] }) {
  const { items } = useSlotContributions(args.orgId, "org.settings.section");
  return (
    <>
      {items.map((c) => (
        <OrgSettingsSection key={uiKey(c.plugin, c.id)} orgId={args.orgId} c={c} />
      ))}
    </>
  );
}

function OrgSettingsSection({ orgId, c }: { orgId: string; c: UiContributionItem }) {
  const locale = uiLocale(useLocale());
  const title = c.title[locale];
  // `flush`: a view may hold a table, which runs to the card's edges (spec §1, web-ui-box-in-box)
  return (
    <FormSection id={`ext-${c.plugin}-${c.id}`} title={title} flush>
      <div data-extension-section={uiKey(c.plugin, c.id)}>
        <BlockBoundary name={title}>
          {c.kind === "embed" ? (
            <OrgPageEmbed orgId={orgId} c={c} />
          ) : (
            <OrgPageView orgId={orgId} c={c} />
          )}
        </BlockBoundary>
      </div>
    </FormSection>
  );
}

function OrgPageEmbed({ orgId, c }: { orgId: string; c: UiContributionItem }) {
  const locale = uiLocale(useLocale());
  return <EmbedTab orgId={orgId} plugin={c.plugin} id={c.id} title={c.title[locale]} />;
}

/**
 * An org view's state: read through the query cache, refreshed by the org UI stream (read again
 * when this contribution changes, and once after a reconnect: refreshes may have been missed
 * meanwhile).
 */
function useOrgView(orgId: string, c: UiContributionItem) {
  const locale = uiLocale(useLocale());
  const { plugin, id } = c;
  const targets = useMemo(() => [{ plugin, id }], [plugin, id]);
  const qc = useQueryClient();
  // the org stream ended (session revoked, the browser gave up reconnecting): the content stays,
  // with a line saying live refresh stopped
  const [liveLost, setLiveLost] = useState(false);
  // ssr-exempt: live updates after first paint (the UI stream)
  useEffect(() => {
    setLiveLost(false);
    return openUiStream(orgId, {
      onUi: (r) => {
        if (r.plugin === plugin && r.contribution === id)
          refreshUiViews(qc, keys.org(orgId).uiViews("org", plugin, id));
      },
      onReconnect: () => refreshUiViews(qc, keys.org(orgId).uiViews("org")),
      onError: () => setLiveLost(true),
    });
  }, [orgId, plugin, id, qc]);
  const key = uiKey(plugin, id);
  const views = useExtensionViews(orgId, targets, { locale });
  const runAction = useUiAction(orgId, { locale, onView: views.setView });
  return {
    liveLost,
    state: views.states[key],
    retry: () => views.retry(key),
    onAction: runAction({ plugin, id }),
  };
}

function OrgViewBody({ live }: { live: ReturnType<typeof useOrgView> }) {
  const t = useTranslations();
  return (
    <Stack gap={12}>
      {live.liveLost && (
        <Text variant="small" tone="warn">
          {t("pluginPage.liveLost")}
        </Text>
      )}
      <ExtensionViewTab state={live.state} onRetry={live.retry} onAction={live.onAction} />
    </Stack>
  );
}

function OrgPageView({ orgId, c }: { orgId: string; c: UiContributionItem }) {
  return <OrgViewBody live={useOrgView(orgId, c)} />;
}

function FilePreviewSlot({
  args,
  select,
  host,
}: {
  args: SlotArgs["file.preview"];
  select: { plugin: string; id: string };
  host: SlotHost["file.preview"];
}) {
  return (
    <BlockBoundary name={host.title}>
      <EmbedTab
        key={`${uiKey(select.plugin, select.id)}/${args.fileId}`}
        orgId={args.orgId}
        plugin={select.plugin}
        id={select.id}
        title={host.title}
        conversationId={args.conversationId}
        file={{ id: args.fileId, maxBytes: host.maxBytes, read: host.read }}
        failed={host.failed}
      />
    </BlockBoundary>
  );
}
