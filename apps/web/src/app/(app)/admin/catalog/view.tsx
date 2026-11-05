"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useSourceLabel } from "../../../../components/CatalogParts";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { catalogTabs } from "../../../../lib/admin-tabs";
import { type CatalogItem, displayNameOf } from "../../../../lib/catalog";
import { catalogItemsQuery, marketplacesQuery } from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

const POLICY_TONE = { allow: "ok", needs_approval: "warn", disabled: "muted" } as const;

/**
 * `/admin/catalog`: the catalog (enterprise admins, ListPage). Every item is a plugin, shown as
 * an object row: name, version chips (marked "new version" when the marketplace has a newer
 * compatible version and "content changed" at the same version), source and number of orgs that
 * installed it, the policy as the state label. The tabs Plugins / Deployment requests link the two
 * routes; the search narrows by name. "Import" goes to the plugin import review (upload a file
 * or an npm package name); the menu holds the marketplace links. From the query cache (the layout
 * prefetched both reads on a first load); the marketplaces are a section: while they load or when
 * they failed only the source labels are left out.
 */
export default function AdminDirectoryView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminDirectoryRead />;
}

/** The head's actions (the same while loading). */
const useActions = () => {
  const t = useTranslations("catalog.admin");
  return [
    { label: t("actions.import"), variant: "primary" as const, href: "/admin/catalog/import" },
    // Browsing the marketplaces is one link; their sources are the sidebar's 市场 (no menu of
    // two ways to one page, spec §6.7).
    {
      label: t("actions.entries"),
      variant: "default" as const,
      href: "/admin/marketplaces/entries",
    },
  ];
};

function AdminDirectoryRead() {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin");
  const actions = useActions();
  const read = usePageQuery(catalogItemsQuery());
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    // The tabs stay with their counts pending; the search appears with a non-empty catalog.
    return (
      <ListPage
        header={{
          path: [...scope, { label: "catalog" }],
          title: t("title"),
          tabs: catalogTabs(t, { plugins: 0 }),
          activeTab: "plugins",
          actions,
        }}
        variant="objects"
        loading
      />
    );
  }
  return <AdminDirectory all={read.data.items} />;
}

function AdminDirectory({ all }: { all: CatalogItem[] }) {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const actions = useActions();
  const mq = marketplacesQuery();
  const marketplaces = useQuery({ ...mq, retryOnMount: retryOnMountOf(mq.queryKey) }).data?.items;
  const sourceLabel = useSourceLabel(marketplaces ?? []);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const rows = all.filter(
    (i) =>
      needle === "" ||
      i.name.toLowerCase().includes(needle) ||
      displayNameOf(i, locale).toLowerCase().includes(needle),
  );

  const header = {
    path: [...scope, { label: "catalog" }],
    title: t("title"),
    tabs: catalogTabs(t, { plugins: all.length }),
    activeTab: "plugins",
    // An empty catalog has nothing to search.
    ...(all.length > 0 ? { search: { label: t("search"), value: q, onChange: setQ } } : {}),
    actions,
  };
  const empty =
    all.length === 0
      ? {
          text: t("empty"),
          action: {
            label: t("actions.import"),
            variant: "primary" as const,
            href: "/admin/catalog/import",
          },
        }
      : rows.length === 0
        ? { text: t("noResults") }
        : undefined;

  return (
    <ListPage header={header} variant="objects" {...(empty ? { empty } : {})}>
      {rows.map((i) => {
        const name = displayNameOf(i, locale);
        return (
          <ObjectRow
            key={i.id}
            mark={{ text: name }}
            name={name}
            href={`/admin/catalog/${encodeURIComponent(i.id)}`}
            chips={[
              ...(i.newerInMarketplace ? [{ label: td("newer"), tone: "warn" as const }] : []),
              ...(i.contentChanged ? [{ label: td("contentChanged"), tone: "warn" as const }] : []),
            ]}
            description={i.description}
            meta={[
              `v${i.latestVersion}`,
              i.name,
              sourceLabel(i),
              `${t("columns.installs")} ${i.installs}`,
            ].join(" · ")}
            state={{ label: td(`policy.${i.policy}`), tone: POLICY_TONE[i.policy] }}
          />
        );
      })}
    </ListPage>
  );
}
