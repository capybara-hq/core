"use client";

import { DetailPage, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { ExtensionSlot } from "../../../../../components/extension-ui/ExtensionSlot";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { contributionsQuery } from "../../../../../lib/query/conversation";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useWorkspace } from "../../../../../lib/query/workspace";
import { type UiContributionItem, uiLocale } from "../../../../../lib/ui";
import NotFound from "../../../not-found";

/**
 * `/p/[plugin]/[id]`: an extension's org page (slot `org.page`, the sidebar's extension pages),
 * DetailPage without an inspector; the body is the slot's (`ExtensionSlot`). A schema view comes
 * from the query cache (the layout prefetched the contributions, then the view, on a first load; a
 * view the extension failed is its own error state), and the org UI stream refreshes it after
 * first paint. An embed opens the extension's own page in a sandboxed iframe (its token request is
 * the embed handshake, in the browser), which refreshes itself. An unknown contribution says so.
 */
export default function PluginPageView({ plugin, id }: { plugin: string; id: string }) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <PluginPageData orgId={ws.orgId} plugin={plugin} id={id} />;
}

function PluginPageData({ orgId, plugin, id }: { orgId: string; plugin: string; id: string }) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const read = usePageQuery(contributionsQuery(orgId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{ path: [...scope, { label: t("pluginPage.pathLabel") }], title: "" }}
        tabs={{ label: id, items: [{ id: "view", label: id }], value: "view" }}
        loading={{ blocks: 1 }}
      />
    );
  }
  const contribution = read.data.find(
    (c) => c.plugin === plugin && c.id === id && c.slot === "org.page",
  );
  return <PluginPage orgId={orgId} plugin={plugin} id={id} contribution={contribution} />;
}

function PluginPage({
  orgId,
  plugin,
  id,
  contribution,
}: {
  orgId: string;
  plugin: string;
  id: string;
  /** Undefined when the org has no such page. */
  contribution: UiContributionItem | undefined;
}) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const locale = uiLocale(useLocale());
  const title = contribution?.title[locale] ?? id;
  return (
    <DetailPage
      header={{ path: [...scope, { label: t("pluginPage.pathLabel") }, { label: title }], title }}
      tabs={{ label: title, items: [{ id: "view", label: title }], value: "view" }}
    >
      {contribution ? (
        <ExtensionSlot slot="org.page" args={{ orgId }} select={{ plugin, id }} />
      ) : (
        <Text tone="muted">{t("errors.ui.not_found")}</Text>
      )}
    </DetailPage>
  );
}
