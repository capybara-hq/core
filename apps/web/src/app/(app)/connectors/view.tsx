"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { type ConnectorSummary, canManageConnectors } from "../../../lib/connectors";

/**
 * `/connectors`: the connectors installed in the org as object rows; a name opens the detail. Read
 * on the server (`page.tsx`).
 */
export default function ConnectorsView({ initial }: { initial: ConnectorSummary[] }) {
  const scope = usePagePath("org");
  const t = useTranslations("connectors");
  const { me } = useSession();
  const manage = canManageConnectors(me);
  const [tab, setTab] = useState<"all" | "disabled">("all");
  const all = initial;
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
