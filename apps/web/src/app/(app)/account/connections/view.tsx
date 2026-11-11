"use client";

import { CardGrid, ObjectCard, SettingsPage } from "@capybara-hq/design";
import { useQueries } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { connectionAnchor, usePersonalConnections } from "../../../../components/ConnectionActions";
import { useMemberGuides } from "../../../../components/ConnectorGuides";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { ACCOUNT_HOME, useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import type { ApiClientError } from "../../../../lib/api";
import { canManageConnectors, personalConnectors } from "../../../../lib/connectors";
import { retryOnMountOf } from "../../../../lib/query/client";
import { connectorQuery, connectorsQuery } from "../../../../lib/query/conversation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/account/connections`: the viewer's personal connections (SettingsPage): one card per
 * connector that needs each person's own credential, in a `CardGrid` on the page ground (maintainer
 * decision 2026-11-09), the same cards as `/connectors`: the connector's plugin icon, its name (the
 * link to its page), 已连接 / 未连接, its auth type and slug, one primary and the rest in ⋯
 * (`usePersonalConnections`): OAuth 连接, once connected 权限 (⋯ 重新连接, 断开连接); a credential
 * 填写凭据 / 更新凭据 in a sheet (⋯ 权限, 清除凭据); 如何连接 in ⋯ when the template's guide has a
 * member section. Each card carries the anchor `connector-<connectorId>` (a conversation's 连接
 * links here): the page scrolls to it and a credential connector's sheet opens.
 * From the query cache (the layout prefetched it on a first load): the list, then each personal
 * connector's detail (with this person's credential status); one the kernel no longer lets the
 * person see is left out. A change invalidates that connector, which is read again.
 */
export default function ConnectionsView() {
  const ws = useWorkspace({ setup: "step" });
  if (ws.kind !== "ok") return null;
  return <Connections orgId={ws.orgId} admin={canManageConnectors(ws.me)} />;
}

function Connections({ orgId, admin }: { orgId: string; admin: boolean }) {
  const scope = usePagePath("home");
  const t = useTranslations("connections");
  const tc = useTranslations("connectors");
  const nav = useAccountNav();
  const list = usePageQuery(connectorsQuery(orgId));
  const personal = list.kind === "ready" ? personalConnectors(list.data.connectors) : [];
  const details = useQueries({
    queries: personal.map((a) => {
      const q = connectorQuery(orgId, a.id);
      return { ...q, retryOnMount: retryOnMountOf(q.queryKey) };
    }),
  });
  // A detail the kernel refuses (403 / 404: the person may no longer see it) is left out, even
  // when an older answer is cached; any other failure without data is the page's error state.
  const refused = (e: ApiClientError | null) => e?.status === 403 || e?.status === 404;
  const shown = details.flatMap((d) => (d.data === undefined || refused(d.error) ? [] : [d.data]));
  // the connectors whose template's guide has a member section: 如何连接 opens it in a sheet
  const memberGuides = useMemberGuides(orgId, personal);
  const connection = usePersonalConnections({
    orgId,
    admin,
    page: "account",
    connectors: shown,
    guides: memberGuides,
    anchor: true,
  });
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const header = {
    path: [...scope, { label: "account", href: ACCOUNT_HOME }, { label: "connections" }],
    title: t("nav.connections"),
  };
  // Until the list and every personal connector's detail answered: skeleton cards, one per
  // personal connector once the list is known.
  if (list.kind === "loading" || details.some((d) => d.data === undefined && d.error === null)) {
    return (
      <SettingsPage header={header} nav={nav} activeNav="connections">
        <CardGrid
          label={t("nav.connections")}
          loading={list.kind === "loading" ? 3 : Math.max(1, personal.length)}
        />
      </SettingsPage>
    );
  }
  const failed = details.filter(
    (d) => d.data === undefined && d.error !== null && !refused(d.error),
  );
  if (failed.length > 0) {
    return <ErrorFrame reset={() => failed.forEach((d) => void d.refetch())} />;
  }
  const cards = shown.flatMap((app) => {
    const parts = connection.parts(app);
    return parts === null ? [] : [{ app, parts }];
  });
  return (
    <SettingsPage header={header} nav={nav} activeNav="connections">
      <CardGrid
        label={t("nav.connections")}
        // The settings content area has nothing to show: the page empty state (spec §6.18)
        {...(cards.length === 0 ? { empty: { text: t("empty"), hint: t("emptyHint") } } : {})}
      >
        {cards.map(({ app, parts }) => (
          <ObjectCard
            key={app.id}
            id={connectionAnchor(app.id)}
            avatar={{ image: app.icon ?? null }}
            title={app.name}
            href={`/connectors/${encodeURIComponent(app.id)}`}
            meta={[tc(`auth.${app.auth.type}`), app.slug]}
            {...parts}
          />
        ))}
      </CardGrid>
      {connection.overlays}
    </SettingsPage>
  );
}
