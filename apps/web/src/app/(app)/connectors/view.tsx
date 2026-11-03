"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { canManageConnectors } from "../../../lib/connectors";
import { connectorsQuery } from "../../../lib/query/conversation";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import type { Me } from "../../../lib/session";
import NotFound from "../not-found";

/**
 * `/connectors`: the connectors installed in the org as object rows; a name opens the detail. From
 * the query cache (the layout prefetched it on a first load).
 */
export default function ConnectorsView() {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Connectors orgId={ws.orgId} me={ws.me} />;
}

function Connectors({ orgId, me }: { orgId: string; me: Me }) {
  const scope = usePagePath("org");
  const t = useTranslations("connectors");
  const manage = canManageConnectors(me);
  const [tab, setTab] = useState<"all" | "disabled">("all");
  const list = usePageQuery(connectorsQuery(orgId));
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const all = list.kind === "ready" ? list.data.connectors : [];
  const disabled = all.filter((c) => c.status === "disabled");
  // A tab only when it holds something different from "all".
  const active = tab === "disabled" && disabled.length > 0 ? "disabled" : "all";
  const rows = active === "disabled" ? disabled : all;
  const header = {
    path: [...scope, { label: "connectors" }],
    title: t("title"),
    actions: [
      ...(manage
        ? [{ label: t("new"), variant: "primary" as const, href: "/connectors/install" }]
        : []),
      { label: t("myConnections"), variant: "default" as const, href: "/account/connections" },
    ],
    ...(disabled.length > 0
      ? {
          tabs: [
            { id: "all", label: t("tabs.all"), count: all.length, onSelect: () => setTab("all") },
            {
              id: "disabled",
              label: t("tabs.disabled"),
              count: disabled.length,
              onSelect: () => setTab("disabled"),
            },
          ],
          activeTab: active,
        }
      : {}),
  };
  const empty =
    all.length === 0
      ? {
          text: t("empty"),
          ...(manage
            ? {
                action: {
                  label: t("new"),
                  variant: "primary" as const,
                  href: "/connectors/install",
                },
              }
            : {}),
        }
      : undefined;
  if (list.kind === "loading") return <ListPage header={header} variant="objects" loading />;
  return (
    <ListPage header={header} variant="objects" {...(empty ? { empty } : {})}>
      {rows.map((c) => (
        <ObjectRow
          key={c.id}
          mark={{ text: c.name }}
          name={c.name}
          href={`/connectors/${encodeURIComponent(c.id)}`}
          chips={[{ label: t(`auth.${c.auth.type}`) }]}
          meta={[c.slug, c.endpoint.url].filter(Boolean).join(" · ")}
          state={
            c.status === "active"
              ? { label: t("status.active"), tone: "ok" }
              : { label: t("status.disabled"), tone: "muted" }
          }
        />
      ))}
    </ListPage>
  );
}
