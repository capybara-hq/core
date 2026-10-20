"use client";

import { Button, DetailPage, Skeleton, Stack, Text } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  PluginViewTab,
  usePluginViews,
  useUiAction,
} from "../../../../../../components/chat-panel/PluginViewTab";
import { FormError } from "../../../../../../components/form-error";
import { OrgGate } from "../../../../../../components/OrgGate";
import { ApiClientError } from "../../../../../../lib/api";
import { listUiContributions, openUiStream, uiKey, uiLocale } from "../../../../../../lib/ui";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

/** `/[locale]/p/[plugin]/[id]`：插件的组织页面（顶栏「扩展」菜单），DetailPage、不带 Inspector。 */
export default function PluginPage() {
  const { plugin, id } = useParams<{ plugin: string; id: string }>();
  return (
    <OrgGate>
      {(orgId) => <PluginPageInOrg key={orgId} orgId={orgId} plugin={plugin} id={id} />}
    </OrgGate>
  );
}

function PluginPageInOrg({ orgId, plugin, id }: { orgId: string; plugin: string; id: string }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const locale = uiLocale(useLocale());
  const contributions = useLoad(() => listUiContributions(orgId), [orgId]);
  const contribution =
    contributions.state.kind === "ready"
      ? contributions.state.data.items.find(
          (c) => c.plugin === plugin && c.id === id && c.place === "page",
        )
      : undefined;
  // embed 贡献：T26 用 EmbedFrame 渲染（coming in T26）；在那之前按「不可用」处理
  const isView = contribution?.kind === "view";
  const targets = useMemo(() => (isView ? [{ plugin, id }] : []), [isView, plugin, id]);

  // 组织级刷新流：本页面的贡献变了就重取；断线重连后也重取一次（期间可能漏掉刷新）
  const [versions, setVersions] = useState<Record<string, number>>({});
  const bump = useCallback((key: string) => {
    setVersions((v) => ({ ...v, [key]: (v[key] ?? 0) + 1 }));
  }, []);
  // 组织流终止（会话吊销、浏览器放弃重连）：内容照常显示，提示实时刷新已断开
  const [liveLost, setLiveLost] = useState(false);
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

  const views = usePluginViews(orgId, targets, { locale, versions });
  const runAction = useUiAction(orgId, { locale, onView: views.setView });
  const key = uiKey(plugin, id);
  const title = contribution?.title[locale] ?? id;

  let body: ReactNode;
  if (contributions.state.kind === "loading") body = <Skeleton rows={4} />;
  else if (contributions.state.kind === "error") {
    body = (
      <Stack gap={8}>
        <FormError
          message={errorMessage(
            new ApiClientError(0, contributions.state.code, contributions.state.code),
          )}
        />
        <Stack direction="row" gap={8}>
          <Button onClick={contributions.reload}>{t("common.retry")}</Button>
        </Stack>
      </Stack>
    );
  } else if (!isView) body = <Text tone="muted">{t("errors.ui.not_found")}</Text>;
  else {
    body = (
      <PluginViewTab
        state={views.states[key]}
        onRetry={() => views.retry(key)}
        onAction={runAction({ plugin, id })}
      />
    );
  }

  return (
    <DetailPage
      header={{ title }}
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
