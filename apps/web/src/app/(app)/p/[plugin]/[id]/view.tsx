"use client";

import { DetailPage, PageLevelContext, Text } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { PageCrumbsProvider } from "../../../../../components/client-ext/host-api";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { ExtensionSlot } from "../../../../../components/extension-ui/ExtensionSlot";
import { NoAccess } from "../../../../../components/NoAccess";
import { pluginPageHref } from "../../../../../components/shell/nav";
import { usePagePath } from "../../../../../components/shell/path";
import { retryOnMountOf } from "../../../../../lib/query/client";
import { contributionsQuery } from "../../../../../lib/query/conversation";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { uiArrangementQuery } from "../../../../../lib/query/ui";
import { useWorkspace } from "../../../../../lib/query/workspace";
import {
  type UiArrangementListSlot,
  type UiContributionItem,
  uiLocale,
} from "../../../../../lib/ui";
import NotFound from "../../../not-found";

/**
 * `/p/[plugin]/[id]`: an extension's org page (slot `org.page`, the sidebar's extension pages),
 * DetailPage without an inspector; the body is the slot's (`ExtensionSlot`). A schema view comes
 * from the query cache (the layout prefetched the contributions, then the view, on a first load; a
 * view the extension failed is its own error state), and the org UI stream refreshes it after
 * first paint. An embed opens the extension's own page in a sandboxed iframe (its token request is
 * the embed handshake, in the browser), which refreshes itself. An unknown contribution says so.
 * A component page with `frame: "page"` draws its whole page itself (plugin full pages spec §2):
 * no DetailPage around it, the host's crumbs (the org, the extension pages' label) reach its
 * forwarded template, and it must render exactly one (the slot's template guard). `params`: the
 * address's query string, the component's `params` (spec §5).
 */
export default function PluginPageView({
  plugin,
  id,
  params,
}: {
  plugin: string;
  id: string;
  params: Record<string, string>;
}) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <PluginPageData orgId={ws.orgId} plugin={plugin} id={id} params={params} />;
}

type PageProps = { orgId: string; plugin: string; id: string; params: Record<string, string> };

function PluginPageData({ orgId, plugin, id, params }: PageProps) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const read = usePageQuery(contributionsQuery(orgId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return <DetailPage header={{ path: scope, title: "" }} loading={{ blocks: 1 }} />;
  }
  const listed = read.data.find((c) => c.plugin === plugin && c.id === id && c.slot === "org.page");
  return <PluginPageHidden orgId={orgId} plugin={plugin} id={id} params={params} listed={listed} />;
}

/**
 * A page the contributions list leaves out may be one an arrangement hides: hidden means not
 * listed, so the direct URL still renders it (the arrangement listing names it with its hidden
 * flag, for whoever the slot admits). Read only then.
 */
function PluginPageHidden({
  orgId,
  plugin,
  id,
  params,
  listed,
}: PageProps & { listed: UiContributionItem | undefined }) {
  const q = uiArrangementQuery(orgId);
  const arrangement = useQuery({
    ...q,
    enabled: listed === undefined,
    retryOnMount: retryOnMountOf(q.queryKey),
  });
  // A 404 is final (a guest's slot gate answers it): the designed not-found, no further read.
  if (listed === undefined && arrangement.error?.status === 404) return <NotFound />;
  if (listed === undefined && arrangement.data === undefined && arrangement.error === null) {
    return null;
  }
  const hidden = listed
    ? undefined
    : arrangement.data
        ?.find((s): s is UiArrangementListSlot => s.slot === "org.page" && "items" in s)
        ?.items.find((c) => c.plugin === plugin && c.id === id && c.hidden);
  return (
    <PluginPage
      orgId={orgId}
      plugin={plugin}
      id={id}
      params={params}
      contribution={listed ?? hidden}
      direct={hidden !== undefined}
    />
  );
}

function PluginPage({
  orgId,
  plugin,
  id,
  params,
  contribution,
  direct,
}: PageProps & {
  /** Undefined when the org has no such page. */
  contribution: UiContributionItem | undefined;
  /** The page is hidden from the lists: the slot gets it as `args.direct`. */
  direct: boolean;
}) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const locale = uiLocale(useLocale());
  const title = contribution?.title[locale] ?? id;
  // The page's own name leads its path (the nav's name for it, such as Projects or Memory), linking to the page
  // without params. The nav opens it without params: a first-level page, no path row; with params
  // (an item opened inside it) it is deeper, and its path row shows (spec §4.2 path rule).
  const crumbs = [...scope, { label: title, href: pluginPageHref(plugin, id) }];
  const level = Object.keys(params).length === 0 ? "first" : "deeper";
  const hostPage = (body: ReactNode) => (
    <DetailPage header={{ path: crumbs, title }}>{body}</DetailPage>
  );
  // a full page (`frame: "page"`) draws its page; the host's DetailPage is only around its other
  // states (loading, failed, off, crashed), and its template gets the host's crumbs
  const full = contribution?.kind === "component" && contribution.frame === "page";
  const slot = contribution ? (
    <ExtensionSlot
      slot="org.page"
      args={{ orgId, params, ...(direct ? { direct: contribution } : {}) }}
      select={{ plugin, id }}
      {...(full && { host: { page: hostPage } })}
    />
  ) : (
    <Text tone="muted">{t("errors.ui.not_found")}</Text>
  );
  return (
    <PageLevelContext.Provider value={level}>
      {full ? <PageCrumbsProvider value={crumbs}>{slot}</PageCrumbsProvider> : hostPage(slot)}
    </PageLevelContext.Provider>
  );
}
