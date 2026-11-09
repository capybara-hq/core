"use client";

import {
  DecorationLayer,
  FormSection,
  InlineCard,
  PropertySection,
  RightPanel,
  type RightPanelSwitcher,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { EmbedFile } from "../../lib/embed-bridge";
import { retryOnMountOf } from "../../lib/query/client";
import { contributionsQuery } from "../../lib/query/conversation";
import { keys } from "../../lib/query/keys";
import { adminUiContributionsQuery, refreshUiViews } from "../../lib/query/ui";
import {
  openUiStream,
  type UiContributionItem,
  type UiOpen,
  type UiSlotId,
  uiKey,
  uiLocale,
} from "../../lib/ui";
import { UI_SLOT_SPECS } from "../../lib/ui-slots.generated";
import type { RunState } from "../client-ext/run-state";
import { BlockBoundary } from "../conversation/BlockBoundary";
import {
  ClientComponentBlock,
  useClientComponent,
  useReadyContributions,
  useSlotHasClientCode,
} from "./ClientComponentBlock";
import { EmbedTab } from "./EmbedTab";
import {
  type BlockContext,
  ExtensionCard,
  ExtensionPanel,
  ExtensionSection,
} from "./ExtensionBlocks";
import { ExtensionViewTab, useExtensionViews, useUiAction } from "./ExtensionViewTab";
import { ReplaceableSlot } from "./ReplaceableSlot";

/** What each slot's contributions are rendered with (the slot's scope args, UI slots spec §6). */
export type SlotArgs = {
  "conversation.panel": { orgId: string; conversationId: string; item?: string };
  "conversation.properties.section": { orgId: string; conversationId: string };
  "conversation.tool-result.card": {
    orgId: string;
    conversationId: string;
    card: { callId: string; key?: string };
  };
  /**
   * `direct`: the page's contribution when an arrangement hides it from the list (hidden means not
   * listed; the direct URL still renders, UI slots spec §5).
   */
  "org.page": { orgId: string; direct?: UiContributionItem };
  "file.preview": { orgId: string; conversationId: string; fileId: string };
  "agent.detail.section": { orgId: string; agentId: string };
  "org.settings.section": { orgId: string };
  /** `direct`: as for `org.page`, the page a platform arrangement hides from the list. */
  "platform.page": { direct?: UiContributionItem };
  /** The client-extension slots (client extensions spec §6.2): org scope, no args. */
  "shell.brand": { orgId: string };
  "shell.overlay": { orgId: string };
  "conversation.empty": { orgId: string };
  "conversation.composer.frame": { orgId: string };
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
  /** `builtin`: the brand row's default (the `Logo`); `collapsed`: the sidebar is the rail. */
  "shell.brand": { builtin: ReactNode; collapsed: boolean };
  "shell.overlay": Record<string, never>;
  /** `builtin`: the new conversation's hero (`Greeting`); `greeting`: its line ("" until picked). */
  "conversation.empty": { builtin: ReactNode; agentId: string | null; greeting: string };
  /**
   * `builtin`: the framed built-in composer; `children`: its inputs without the frame (`ComposerBox
   * frame={false}`), which a winner renders exactly once inside its own frame (the host checks
   * after commit that the composer's textarea is in the document).
   */
  "conversation.composer.frame": {
    builtin: ReactNode;
    children: ReactNode;
    conversationId: string | null;
    runState: RunState;
  };
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
 * again on mount) lists none; `pending` while the first read is on its way. `enabled` false: no
 * read, only what the cache holds (the shell slots read only when the document has client code
 * for them; the layout prefetches the winners then, spec §6.3).
 */
export function useSlotContributions(
  orgId: string,
  slot: UiSlotId,
  enabled = true,
): { items: UiContributionItem[]; pending: boolean } {
  const q = contributionsQuery(orgId);
  const r = useQuery({ ...q, enabled, retryOnMount: retryOnMountOf(q.queryKey) });
  const all = r.data;
  const items = useMemo(() => (all ? all.filter((c) => c.slot === slot) : NONE), [all, slot]);
  return { items, pending: enabled && all === undefined && r.error === null };
}

/** The anchor a contribution goes after: its own, else the slot's first. */
const anchorOf = (c: UiContributionItem): string | undefined =>
  c.after ?? UI_SLOT_SPECS[c.slot].anchors[0];

const matches = (c: UiContributionItem, select: { plugin: string; id: string } | undefined) =>
  select === undefined || (c.plugin === select.plugin && c.id === select.id);

/**
 * The only way to render extension UI (UI slots spec §7): the slot's contributions (`select`: that
 * one; `anchor`: those placed after it; else all), each view, embed or client component failing
 * alone in its own block. Draws nothing when nothing matches. A replaceable single slot
 * (`shell.brand`, `conversation.empty`, `conversation.composer.frame`) draws its winner or the
 * built-in `host.builtin` (client extensions spec §6).
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
    case "agent.detail.section":
      return p.select ? <AgentSectionSlot args={p.args} select={p.select} /> : null;
    case "platform.page":
      return p.select ? <PlatformPageSlot args={p.args} select={p.select} /> : null;
    case "shell.overlay":
      return <OverlaySlot args={p.args} />;
    case "shell.brand":
      return p.host ? (
        <ReplaceableSlot
          slot="shell.brand"
          args={p.args}
          builtin={p.host.builtin}
          extra={{ collapsed: p.host.collapsed }}
        />
      ) : null;
    case "conversation.empty":
      return p.host ? (
        <ReplaceableSlot
          slot="conversation.empty"
          args={p.args}
          builtin={p.host.builtin}
          extra={{ agentId: p.host.agentId, greeting: p.host.greeting }}
        />
      ) : null;
    case "conversation.composer.frame":
      return p.host ? (
        <ReplaceableSlot
          slot="conversation.composer.frame"
          args={p.args}
          builtin={p.host.builtin}
          extra={{
            children: p.host.children,
            conversationId: p.host.conversationId,
            runState: p.host.runState,
          }}
        />
      ) : null;
    default:
      return null;
  }
}

/**
 * The overlay's components (slot `shell.overlay`, at most 4 in arrangement order, client extensions
 * spec §7.4) in the decoration layer, drawn only when the slot lists one. A crashing overlay
 * component draws nothing. The caller renders the slot only on workspace pages (spec §9.6).
 */
function OverlaySlot({ args }: { args: SlotArgs["shell.overlay"] }) {
  const code = useSlotHasClientCode("shell.overlay");
  const { items } = useSlotContributions(args.orgId, "shell.overlay", code);
  // no layer until a component is ready (loading or broken overlays draw nothing)
  const shown = useReadyContributions(items.filter((c) => c.kind === "component").slice(0, 4));
  if (shown.length === 0) return null;
  return (
    <DecorationLayer>
      {shown.map((c) => (
        <ClientComponentBlock
          key={uiKey(c.plugin, c.id)}
          c={c}
          args={{ orgId: args.orgId }}
          hostProps={NO_PROPS}
          quiet
        />
      ))}
    </DecorationLayer>
  );
}

const NO_PROPS: Record<string, unknown> = {};

type Select = { plugin: string; id: string } | undefined;

/**
 * A component's right panel: the host always draws the panel (the manifest title, the switcher,
 * close), with the loading state while the module loads and the failure line when it is not
 * there (failed, off); the component, in its own block, once ready.
 */
function ComponentPanel({
  c,
  title,
  args,
  host,
}: {
  c: UiContributionItem;
  title: string;
  args: SlotArgs["conversation.panel"];
  host: SlotHost["conversation.panel"];
}) {
  const found = useClientComponent(c);
  return (
    <RightPanel
      title={title}
      {...(host.switcher ? { switcher: host.switcher } : {})}
      onClose={host.onClose}
      {...(found.status === "ready" ? { onFullscreen: host.onFullscreen } : {})}
      body="pad"
      {...(found.status === "loading"
        ? { state: "loading" as const }
        : found.status === "none"
          ? { state: "failed" as const }
          : {})}
    >
      {found.status === "ready" ? (
        <ClientComponentBlock
          c={c}
          args={{
            orgId: args.orgId,
            conversationId: args.conversationId,
            ...(args.item !== undefined && { item: args.item }),
          }}
          hostProps={{
            conversationId: args.conversationId,
            ...(args.item !== undefined && { item: args.item }),
            close: host.onClose,
          }}
        />
      ) : null}
    </RightPanel>
  );
}

function PanelSlot({
  args,
  select,
  host,
}: {
  args: SlotArgs["conversation.panel"];
  select: Select;
  host: SlotHost["conversation.panel"];
}) {
  const locale = useLocale();
  const { items } = useSlotContributions(args.orgId, "conversation.panel");
  const c = items.find((x) => matches(x, select));
  if (!c) return null;
  if (c.kind === "component") {
    return (
      <ComponentPanel
        key={`${uiKey(c.plugin, c.id)}/${args.item ?? ""}`}
        c={c}
        title={c.title[uiLocale(locale)]}
        args={args}
        host={host}
      />
    );
  }
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
  const locale = uiLocale(useLocale());
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
      {shown.map((c) =>
        c.kind === "component" ? (
          <ClientComponentBlock
            key={uiKey(c.plugin, c.id)}
            c={c}
            args={{ orgId: args.orgId, conversationId: args.conversationId }}
            hostProps={{ conversationId: args.conversationId }}
            frame={(block) => (
              <div data-extension-section={uiKey(c.plugin, c.id)}>
                <PropertySection title={c.title[locale]}>{block}</PropertySection>
              </div>
            )}
          />
        ) : (
          <ExtensionSection key={uiKey(c.plugin, c.id)} ctx={ctx} c={c} />
        ),
      )}
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
  const locale = uiLocale(useLocale());
  const c = cards.find((x) => matches(x, select));
  if (!c) return null;
  if (c.kind === "component") {
    const card = {
      callId: args.card.callId,
      ...(args.card.key !== undefined && { key: args.card.key }),
    };
    return (
      <ClientComponentBlock
        c={c}
        args={{ orgId: args.orgId, conversationId: args.conversationId, card }}
        hostProps={{ conversationId: args.conversationId, card }}
        frame={(block) => (
          <div data-extension-card={uiKey(c.plugin, c.id)}>
            <InlineCard source={c.title[locale]} state="ready">
              {block}
            </InlineCard>
          </div>
        )}
      />
    );
  }
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
  const c = items.find((x) => matches(x, select)) ?? args.direct;
  if (!c) return null;
  const key = uiKey(c.plugin, c.id);
  if (c.kind === "component")
    return (
      <ClientComponentBlock key={key} c={c} args={{ orgId: args.orgId }} hostProps={NO_PROPS} />
    );
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
 * The platform's page contributions (slot `platform.page`, super admins), in the kernel's order. A
 * failed read (not read again on mount) lists none; `pending` while the first read is on its way.
 */
export function usePlatformPages(enabled = true): {
  items: UiContributionItem[];
  pending: boolean;
} {
  const q = adminUiContributionsQuery();
  const r = useQuery({ ...q, enabled, retryOnMount: retryOnMountOf(q.queryKey) });
  const items = r.data ?? NONE;
  return { items, pending: enabled && r.data === undefined && r.error === null };
}

/**
 * A platform page's body (admin console): a schema view from the query cache refreshed by the
 * platform UI stream, or an embed; the same as an org page, on the org-less admin routes.
 */
function PlatformPageSlot({
  args,
  select,
}: {
  args: SlotArgs["platform.page"];
  select: { plugin: string; id: string };
}) {
  const locale = uiLocale(useLocale());
  const { items } = usePlatformPages();
  const c = items.find((x) => matches(x, select)) ?? args.direct;
  if (!c) return null;
  const key = uiKey(c.plugin, c.id);
  if (c.kind === "component")
    return <ClientComponentBlock key={key} c={c} args={{ orgId: null }} hostProps={NO_PROPS} />;
  return (
    <BlockBoundary name={c.title[locale]}>
      {c.kind === "embed" ? (
        <OrgPageEmbed key={key} orgId={null} c={c} />
      ) : (
        <OrgPageView key={key} orgId={null} c={c} />
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
  if (c.kind === "component") {
    return (
      <ClientComponentBlock
        c={c}
        args={{ orgId }}
        hostProps={NO_PROPS}
        frame={(block) => (
          <FormSection id={`ext-${c.plugin}-${c.id}`} title={title} flush>
            <div data-extension-section={uiKey(c.plugin, c.id)}>{block}</div>
          </FormSection>
        )}
      />
    );
  }
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

/**
 * An agent page's extension section: the section card (titled by the contribution's title) holding
 * the view or the embed, scoped to the agent (the kernel serves it to whoever may read the agent,
 * read-only viewers included). No save bar: the extension's own actions run through `onAction`.
 * The view is read when the section opens, not live.
 */
function AgentSectionSlot({
  args,
  select,
}: {
  args: SlotArgs["agent.detail.section"];
  select: { plugin: string; id: string };
}) {
  const locale = uiLocale(useLocale());
  const { items } = useSlotContributions(args.orgId, "agent.detail.section");
  const c = items.find((x) => matches(x, select));
  if (!c) return null;
  const title = c.title[locale];
  const key = uiKey(c.plugin, c.id);
  if (c.kind === "component") {
    return (
      <ClientComponentBlock
        key={`${key}/${args.agentId}`}
        c={c}
        args={{ orgId: args.orgId, agentId: args.agentId }}
        hostProps={{ agentId: args.agentId }}
        frame={(block) => (
          <FormSection id={`ext-${c.plugin}-${c.id}`} title={title} flush>
            <div data-extension-section={key}>{block}</div>
          </FormSection>
        )}
      />
    );
  }
  return (
    <FormSection id={`ext-${c.plugin}-${c.id}`} title={title} flush>
      <div data-extension-section={key}>
        <BlockBoundary name={title}>
          {c.kind === "embed" ? (
            <EmbedTab
              key={`${key}/${args.agentId}`}
              orgId={args.orgId}
              plugin={c.plugin}
              id={c.id}
              title={title}
              agentId={args.agentId}
            />
          ) : (
            <AgentSectionView key={`${key}/${args.agentId}`} args={args} c={c} />
          )}
        </BlockBoundary>
      </div>
    </FormSection>
  );
}

function AgentSectionView({
  args,
  c,
}: {
  args: SlotArgs["agent.detail.section"];
  c: UiContributionItem;
}) {
  const locale = uiLocale(useLocale());
  const { plugin, id } = c;
  const targets = useMemo(() => [{ plugin, id }], [plugin, id]);
  const views = useExtensionViews(args.orgId, targets, { agentId: args.agentId, locale });
  const runAction = useUiAction(args.orgId, {
    agentId: args.agentId,
    locale,
    onView: views.setView,
  });
  const key = uiKey(plugin, id);
  return (
    <ExtensionViewTab
      state={views.states[key]}
      onRetry={() => views.retry(key)}
      onAction={runAction({ plugin, id })}
    />
  );
}

function OrgPageEmbed({ orgId, c }: { orgId: string | null; c: UiContributionItem }) {
  const locale = uiLocale(useLocale());
  return <EmbedTab orgId={orgId} plugin={c.plugin} id={c.id} title={c.title[locale]} />;
}

/**
 * An org view's state: read through the query cache, refreshed by the org UI stream (read again
 * when this contribution changes, and once after a reconnect: refreshes may have been missed
 * meanwhile).
 */
function useOrgView(orgId: string | null, c: UiContributionItem) {
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
    // `orgId` null: the platform stream and the deployment scope's views
    const viewsOf = (p?: string, i?: string) =>
      orgId === null ? keys.deployment().uiViews(p, i) : keys.org(orgId).uiViews("org", p, i);
    return openUiStream(orgId, {
      onUi: (r) => {
        if (r.plugin === plugin && r.contribution === id) refreshUiViews(qc, viewsOf(plugin, id));
      },
      onReconnect: () => refreshUiViews(qc, viewsOf()),
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

function OrgPageView({ orgId, c }: { orgId: string | null; c: UiContributionItem }) {
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
