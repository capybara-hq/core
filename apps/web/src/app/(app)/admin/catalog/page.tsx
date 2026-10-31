"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../components/AdminGate";
import { useSourceLabel } from "../../../../components/CatalogParts";
import { usePagePath } from "../../../../components/shell/path";
import { catalogTabs } from "../../../../lib/admin-tabs";
import { displayNameOf, listCatalogItems, listMarketplaces } from "../../../../lib/catalog";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/admin/catalog`: the catalog (enterprise admins, ListPage). Every item is a plugin, shown as
 * an object row: name, version chips (marked "new version" when the marketplace has a newer
 * compatible version and "content changed" at the same version), source and number of orgs that
 * installed it, the policy as the state label. The tabs Plugins / Deployment requests link the two
 * routes; the search narrows by name. "Import" goes to the plugin import review (upload a file
 * or an npm package name); the menu holds the marketplace links.
 */
export default function AdminCatalogPage() {
  return (
    <AdminGate>
      <AdminDirectory />
    </AdminGate>
  );
}

const POLICY_TONE = { allow: "ok", needs_approval: "warn", disabled: "muted" } as const;

function AdminDirectory() {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const { state, reload } = useLoad(listCatalogItems, []);
  const sources = useLoad(
    () => listMarketplaces().catch(() => ({ items: [], offline: false })),
    [],
  );
  const sourceLabel = useSourceLabel(
    sources.state.kind === "ready" ? sources.state.data.items : [],
  );
  const [q, setQ] = useState("");
  const all = state.kind === "ready" ? state.data.items : [];
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
    ...(all.length > 0 ? { search: { label: t("search"), value: q, onChange: setQ } } : {}),
    actions: [
      { label: t("actions.import"), variant: "primary" as const, href: "/admin/catalog/import" },
      {
        label: t("actions.more"),
        menu: [
          { label: t("actions.entries"), href: "/admin/marketplaces/entries" },
          { label: t("actions.marketplaces"), href: "/admin/marketplaces" },
        ],
      },
    ],
  };
  const empty =
    state.kind === "error"
      ? {
          icon: "circle-alert" as const,
          text: t("loadFailed"),
          action: { label: t("retry"), variant: "default" as const, onSelect: reload },
        }
      : state.kind === "ready" && all.length === 0
        ? {
            text: t("empty"),
            action: {
              label: t("actions.import"),
              variant: "primary" as const,
              href: "/admin/catalog/import",
            },
          }
        : state.kind === "ready" && rows.length === 0
          ? { icon: "search" as const, text: t("noResults") }
          : undefined;

  return (
    <ListPage
      header={header}
      variant="objects"
      loading={state.kind === "loading"}
      {...(empty ? { empty } : {})}
    >
      {rows.map((i) => {
        const name = displayNameOf(i, locale);
        return (
          <ObjectRow
            key={i.id}
            mark={{ text: Array.from(name)[0] ?? "?" }}
            name={name}
            href={`/admin/catalog/${encodeURIComponent(i.id)}`}
            chips={[
              { label: `v${i.latestVersion}` },
              ...(i.newerInMarketplace ? [{ label: td("newer"), tone: "warn" as const }] : []),
              ...(i.contentChanged ? [{ label: td("contentChanged"), tone: "warn" as const }] : []),
            ]}
            description={i.description}
            meta={[i.name, sourceLabel(i), `${t("columns.installs")} ${i.installs}`].join(" · ")}
            state={{ label: td(`policy.${i.policy}`), tone: POLICY_TONE[i.policy] }}
          />
        );
      })}
    </ListPage>
  );
}
