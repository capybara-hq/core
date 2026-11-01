"use client";

import { DetailPage, Stack, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { EmbedTab } from "../../../../../components/extension-ui/EmbedTab";
import {
  ExtensionViewTab,
  useExtensionViews,
  useUiAction,
  type ViewState,
} from "../../../../../components/extension-ui/ExtensionViewTab";
import { usePagePath } from "../../../../../components/shell/path";
import { openUiStream, type UiContributionItem, uiKey, uiLocale } from "../../../../../lib/ui";

/**
 * `/p/[plugin]/[id]`: an extension's org page (the sidebar's extension pages), DetailPage without an
 * inspector. A schema view (kind view) is drawn by our components; the server read it, and the org
 * UI stream refreshes it after first paint. An embed (kind embed) opens the extension's own page in
 * a sandboxed iframe (`EmbedTab`: its token request is the embed handshake, in the browser), which
 * refreshes itself. `contribution` is undefined when the org has no such page; `view` is the
 * server's read of a view (its own error state when the extension failed it).
 */
export default function PluginPageView({
  orgId,
  plugin,
  id,
  contribution,
  view,
}: {
  orgId: string;
  plugin: string;
  id: string;
  contribution: UiContributionItem | undefined;
  view: ViewState | undefined;
}) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const locale = uiLocale(useLocale());
  const isView = contribution?.kind === "view";
  const isEmbed = contribution?.kind === "embed";
  const targets = useMemo(() => (isView ? [{ plugin, id }] : []), [isView, plugin, id]);

  // The org UI stream: fetch again when this page's contribution changes, and once after a
  // reconnect (refreshes may have been missed meanwhile)
  const [versions, setVersions] = useState<Record<string, number>>({});
  const bump = useCallback((key: string) => {
    setVersions((v) => ({ ...v, [key]: (v[key] ?? 0) + 1 }));
  }, []);
  // 组织流终止（会话吊销、浏览器放弃重连）：内容照常显示，提示实时刷新已断开
  const [liveLost, setLiveLost] = useState(false);
  // ssr-exempt: live updates after first paint (the UI stream)
  useEffect(() => {
    if (!isView) return;
    setLiveLost(false);
    return openUiStream(orgId, {
      onUi: (r) => {
        if (r.plugin === plugin && r.contribution === id) bump(uiKey(plugin, id));
      },
      onReconnect: () => bump("*"),
      onError: () => setLiveLost(true),
    });
  }, [orgId, plugin, id, isView, bump]);

  const key = uiKey(plugin, id);
  const initialViews = useMemo(() => (view === undefined ? {} : { [key]: view }), [key, view]);
  const views = useExtensionViews(orgId, targets, { locale, versions, initial: initialViews });
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
