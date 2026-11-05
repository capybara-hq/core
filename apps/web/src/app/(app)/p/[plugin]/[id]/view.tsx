"use client";

import { DetailPage, Stack, Text } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { EmbedTab } from "../../../../../components/extension-ui/EmbedTab";
import {
  ExtensionViewTab,
  useExtensionViews,
  useUiAction,
} from "../../../../../components/extension-ui/ExtensionViewTab";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { contributionsQuery } from "../../../../../lib/query/conversation";
import { keys } from "../../../../../lib/query/keys";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { refreshUiViews } from "../../../../../lib/query/ui";
import { useWorkspace } from "../../../../../lib/query/workspace";
import { openUiStream, type UiContributionItem, uiKey, uiLocale } from "../../../../../lib/ui";
import NotFound from "../../../not-found";

/**
 * `/p/[plugin]/[id]`: an extension's org page (the sidebar's extension pages), DetailPage without an
 * inspector. A schema view (kind view) is drawn by our components; it comes from the query cache
 * (the layout prefetched the contributions, then the view, on a first load; a view the extension
 * failed is its own error state), and the org UI stream refreshes it after first paint. An embed
 * (kind embed) opens the extension's own page in a sandboxed iframe (`EmbedTab`: its token request
 * is the embed handshake, in the browser), which refreshes itself. An unknown contribution says so.
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
    (c) => c.plugin === plugin && c.id === id && c.place === "page",
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
  const isView = contribution?.kind === "view";
  const isEmbed = contribution?.kind === "embed";
  const targets = useMemo(() => (isView ? [{ plugin, id }] : []), [isView, plugin, id]);

  // The org UI stream: read again when this page's contribution changes, and once after a
  // reconnect (refreshes may have been missed meanwhile)
  const qc = useQueryClient();
  // 组织流终止（会话吊销、浏览器放弃重连）：内容照常显示，提示实时刷新已断开
  const [liveLost, setLiveLost] = useState(false);
  // ssr-exempt: live updates after first paint (the UI stream)
  useEffect(() => {
    if (!isView) return;
    setLiveLost(false);
    return openUiStream(orgId, {
      onUi: (r) => {
        if (r.plugin === plugin && r.contribution === id)
          refreshUiViews(qc, keys.org(orgId).uiViews("org", plugin, id));
      },
      onReconnect: () => refreshUiViews(qc, keys.org(orgId).uiViews("org")),
      onError: () => setLiveLost(true),
    });
  }, [orgId, plugin, id, isView, qc]);

  const key = uiKey(plugin, id);
  const views = useExtensionViews(orgId, targets, { locale });
  const runAction = useUiAction(orgId, { locale, onView: views.setView });
  const title = contribution?.title[locale] ?? id;

  let body: ReactNode;
  if (isEmbed) {
    body = <EmbedTab key={key} orgId={orgId} plugin={plugin} id={id} title={title} />;
  } else if (!isView) body = <Text tone="muted">{t("errors.ui.not_found")}</Text>;
  else {
    body = (
      <ExtensionViewTab
        state={views.states[key]}
        onRetry={() => views.retry(key)}
        onAction={runAction({ plugin, id })}
      />
    );
  }

  return (
    <DetailPage
      header={{ path: [...scope, { label: t("pluginPage.pathLabel") }, { label: title }], title }}
      tabs={{ label: title, items: [{ id: "view", label: title }], value: "view" }}
    >
      <Stack gap={12}>
        {liveLost && (
          <Text variant="small" tone="warn">
            {t("pluginPage.liveLost")}
          </Text>
        )}
        {body}
      </Stack>
    </DetailPage>
  );
}
