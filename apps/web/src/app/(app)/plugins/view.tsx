"use client";

import { ListPage, ObjectRow, Stack, Text, versionLabel } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useCatalogErrorLines } from "../../../components/CatalogParts";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { rowActions, usePluginActions, usePluginState } from "../../../components/PluginSwitch";
import { useComponentsLabel } from "../../../components/PluginsHead";
import { usePagePath } from "../../../components/shell/path";
import { issueLines } from "../../../lib/api";
import {
  displayNameOf,
  type MarketplaceEntry,
  type OrgCatalogItem,
  requestMarketplaceEntry,
} from "../../../lib/catalog";
import { canUpdateOrg } from "../../../lib/org-settings";
import { orgCatalogQuery, orgMarketplaceEntriesQuery } from "../../../lib/query/catalog";
import { orgExtensionsQuery } from "../../../lib/query/channels";
import { retryOnMountOf } from "../../../lib/query/client";
import { useAppMutation } from "../../../lib/query/mutation";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import type { Me } from "../../../lib/session";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/plugins`: the org's 插件 page (spec §9; members up, read-only for members). The plugins the
 * enterprise offers this org, as object rows: name, chips (内置, Claude Code), components, scope,
 * the state in the org (已启用 / 未启用 / 需要配置 / 已启用 · 企业统一 / 未开放，可申请 / 已申请，
 * 等待处理) and the actions of {@link usePluginActions}. Org admins also get the 市场 tab (spec
 * §5.1): the marketplaces' entries, read-only, with 申请引入; it is left out while the entries
 * cannot be read (the deployment turned `orgMarketplaceBrowse` off: a 404). From the query cache
 * (the layout prefetched the catalog, and for org admins the extensions and the entries, on a
 * first load).
 */
export default function PluginsView() {
  const ws = useWorkspace({ min: "member", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Plugins orgId={ws.orgId} me={ws.me} />;
}

function Plugins({ orgId, me }: { orgId: string; me: Me }) {
  const scope = usePagePath("org");
  const t = useTranslations("plugins");
  const tc = useTranslations("catalog");
  const locale = useLocale();
  const admin = canUpdateOrg(me);
  const stateOf = usePluginState();
  const componentsLabel = useComponentsLabel();
  const [tab, setTab] = useState<"plugins" | "market">("plugins");
  const list = usePageQuery(orgCatalogQuery(orgId));
  // Org admins: the extensions (a row's 组织配置, whether 启用 asks for input) and the entries
  // (the 市场 tab), both sections
  const eq = orgExtensionsQuery(orgId);
  const extensions = useQuery({
    ...eq,
    enabled: admin,
    retryOnMount: retryOnMountOf(eq.queryKey),
  }).data?.extensions;
  const mq = orgMarketplaceEntriesQuery(orgId, "", "");
  const market = useQuery({
    ...mq,
    enabled: admin,
    retry: false,
    retryOnMount: retryOnMountOf(mq.queryKey),
  });
  const { actionsOf, dialog, error } = usePluginActions({ orgId, admin, extensions });
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const items = list.kind === "ready" ? list.data.items : [];
  const entries = market.data?.items;
  const showMarket = admin && entries !== undefined;
  const active = showMarket && tab === "market" ? "market" : "plugins";

  const header = {
    path: [...scope, { label: "plugins" }],
    title: t("title"),
    description: t("description"),
    ...(showMarket
      ? {
          tabs: [
            {
              id: "plugins",
              label: t("tabs.plugins"),
              count: items.length,
              onSelect: () => setTab("plugins"),
            },
            {
              id: "market",
              label: t("tabs.market"),
              count: entries.length,
              onSelect: () => setTab("market"),
            },
          ],
          activeTab: active,
        }
      : {}),
  };
  if (list.kind === "loading") return <ListPage header={header} variant="objects" loading />;
  if (active === "market") {
    return <Market orgId={orgId} header={header} entries={entries ?? []} />;
  }
  const callout =
    error !== undefined
      ? {
          tone: "fail" as const,
          children: (
            <Stack gap={4}>
              <Text tone="fail">{error.message}</Text>
              {error.extra.map((m) => (
                <Text key={m} variant="small" tone="fail">
                  {m}
                </Text>
              ))}
            </Stack>
          ),
        }
      : undefined;
  const scopeText = (i: OrgCatalogItem) =>
    i.builtin ? tc("scope.all") : t("meta.enterprise", { scope: tc(`scope.${i.scope}`) });
  return (
    <>
      <ListPage
        header={header}
        variant="objects"
        listLabel={t("title")}
        {...(callout ? { callout } : {})}
        {...(items.length === 0 ? { empty: { text: t("empty") } } : {})}
      >
        {items.map((i) => {
          const name = displayNameOf(i, locale);
          const upgrade = admin ? (i.installed?.upgradeAvailable ?? null) : null;
          return (
            <ObjectRow
              key={i.id}
              mark={{ text: name }}
              name={name}
              href={`/plugins/${encodeURIComponent(i.id)}`}
              chips={[
                ...(i.builtin ? [{ label: tc("admin.chips.builtin") }] : []),
                ...(i.sourceFormat === "claude-code"
                  ? [{ label: tc("admin.chips.claudeCode") }]
                  : []),
                ...(upgrade !== null
                  ? [{ label: t("chips.upgrade", { version: versionLabel(upgrade) }) }]
                  : []),
              ]}
              description={i.description}
              meta={[componentsLabel(i.componentCounts), scopeText(i)]}
              state={stateOf(i)}
              {...rowActions(actionsOf(i))}
            />
          );
        })}
      </ListPage>
      {dialog}
    </>
  );
}

/** One entry's key: an entry is one version of a plugin in one marketplace. */
const keyOf = (e: MarketplaceEntry) => `${e.sourceId}/${e.name}/${e.version ?? ""}`;

/**
 * The 市场 tab (org admins, spec §5.1 rule 3): the marketplaces' entries, read-only; 申请引入
 * asks the enterprise admin to bring an entry in (approving runs the import review with this org
 * as the scope). An entry asked for in this visit reads 已申请，等待处理; one the deployment has
 * imported reads 已引入.
 */
function Market({
  orgId,
  header,
  entries,
}: {
  orgId: string;
  header: Parameters<typeof ListPage>[0]["header"];
  entries: MarketplaceEntry[];
}) {
  const t = useTranslations("plugins");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const [asked, setAsked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const ask = useAppMutation({
    fn: (e: MarketplaceEntry) =>
      requestMarketplaceEntry(
        orgId,
        { marketplaceId: e.sourceId, name: e.name, version: e.version ?? "" },
        "",
      ),
    invalidates: () => [],
  });
  const request = async (e: MarketplaceEntry) => {
    if (busy !== undefined) return;
    setBusy(keyOf(e));
    setError(undefined);
    try {
      await ask.mutateAsync(e);
      setAsked((s) => new Set(s).add(keyOf(e)));
    } catch (err) {
      setError({ message: errorMessage(err), extra: [...issueLines(err), ...catalogLines(err)] });
    } finally {
      setBusy(undefined);
    }
  };
  const summaryOf = (e: MarketplaceEntry) =>
    locale === "zh" && e.summary.zh !== undefined ? e.summary.zh : e.summary.en;
  const stateOf = (e: MarketplaceEntry) =>
    asked.has(keyOf(e))
      ? { label: t("state.requested"), tone: "muted" as const }
      : e.adopted !== null
        ? { label: t("market.adopted"), tone: "ok" as const }
        : !e.compatible || !e.importable
          ? { label: t("market.unavailable"), tone: "muted" as const }
          : undefined;
  const requestable = (e: MarketplaceEntry) =>
    !asked.has(keyOf(e)) &&
    e.adopted === null &&
    e.compatible &&
    e.importable &&
    e.version !== null;
  return (
    <ListPage
      header={header}
      variant="objects"
      listLabel={t("market.title")}
      {...(error !== undefined
        ? {
            callout: {
              tone: "fail" as const,
              children: (
                <Stack gap={4}>
                  <Text tone="fail">{error.message}</Text>
                  {error.extra.map((m) => (
                    <Text key={m} variant="small" tone="fail">
                      {m}
                    </Text>
                  ))}
                </Stack>
              ),
            },
          }
        : {})}
      {...(entries.length === 0 ? { empty: { text: t("market.empty") } } : {})}
    >
      {entries.map((e) => {
        const state = stateOf(e);
        return (
          <ObjectRow
            key={keyOf(e)}
            mark={{ text: e.name }}
            name={e.name}
            mono
            description={summaryOf(e)}
            meta={[e.sourceName, ...(e.version !== null ? [versionLabel(e.version)] : [])]}
            {...(state !== undefined ? { state } : {})}
            {...(requestable(e)
              ? {
                  action: {
                    label: t("action.requestImport"),
                    onSelect: () => void request(e),
                  },
                }
              : {})}
          />
        );
      })}
    </ListPage>
  );
}
