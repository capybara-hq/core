"use client";

import {
  Badge,
  type Column,
  DataTable,
  ListPage,
  RadioGroup,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../../components/AdminGate";
import { useAdminParent } from "../../../../../components/admin-nav";
import { PolicyBadge, useSourceLabel } from "../../../../../components/CatalogParts";
import { useRouter } from "../../../../../i18n/navigation";
import {
  type CatalogItem,
  displayNameOf,
  listCatalogItems,
  listMarketplaces,
  sourceKeyOf,
} from "../../../../../lib/catalog";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/admin/catalog`: the catalog (enterprise admins, ListPage). Every item is a plugin.
 * Columns: name, version (marked "new version" when the marketplace has a newer compatible version,
 * from the kernel's newerInMarketplace), source (manual / official marketplace / enterprise
 * marketplace), policy, number of orgs that installed it; the Rail filters by source. The header's
 * "Import" goes to the plugin import review (upload a file or an npm package name), "Browse
 * marketplaces" to the marketplace entries, and the menu holds marketplaces and deployment requests.
 */
export default function AdminCatalogPage() {
  return (
    <AdminGate>
      <AdminDirectory />
    </AdminGate>
  );
}

function AdminDirectory() {
  const t = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const parent = useAdminParent();
  const router = useRouter();
  const { state, reload } = useLoad(listCatalogItems, []);
  const sources = useLoad(
    () => listMarketplaces().catch(() => ({ items: [], offline: false })),
    [],
  );
  const sourceList = sources.state.kind === "ready" ? sources.state.data.items : [];
  const sourceLabel = useSourceLabel(sourceList);
  const [source, setSource] = useState("");
  const all = state.kind === "ready" ? state.data.items : [];
  const rows = all.filter((i) => source === "" || sourceKeyOf(i) === source);
  const sourceOptions = [
    { value: "manual", label: td("source.manual") },
    ...sourceList.map((s) => ({
      value: `marketplace:${s.id}`,
      label: s.builtin ? td("source.official") : s.name,
    })),
  ];

  const columns: Column<CatalogItem>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (i) => (
        <Stack gap={0}>
          <Text>{displayNameOf(i, locale)}</Text>
          {i.displayName !== null && (
            <Text variant="small" tone="muted">
              {i.name}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: "version",
      header: t("columns.version"),
      cell: (i) => (
        <Stack direction="row" gap={8} align="center">
          <Text tone="muted">{i.latestVersion}</Text>
          {i.newerInMarketplace && <Badge tone="accent">{td("newer")}</Badge>}
        </Stack>
      ),
    },
    { key: "source", header: t("columns.source"), cell: (i) => sourceLabel(i) },
    { key: "policy", header: t("columns.policy"), cell: (i) => <PolicyBadge policy={i.policy} /> },
    {
      key: "installs",
      header: t("columns.installs"),
      tone: "muted",
      cell: (i) => String(i.installs),
    },
  ];

  return (
    <ListPage
      header={{
        parent,
        title: t("title"),
        count: String(all.length),
        actions: [
          { label: t("actions.import"), variant: "primary", href: "/admin/catalog/import" },
          { label: t("actions.entries"), variant: "default", href: "/admin/marketplaces/entries" },
          {
            label: t("actions.more"),
            menu: [
              { label: t("actions.marketplaces"), href: "/admin/marketplaces" },
              { label: t("actions.requests"), href: "/admin/catalog/requests" },
            ],
          },
        ],
      }}
      rail={
        <RadioGroup
          label={t("filters.source")}
          value={source}
          onChange={setSource}
          options={[{ value: "", label: t("filters.allSources") }, ...sourceOptions]}
        />
      }
    >
      <Stack gap={12}>
        <Text tone="muted">{t("hint")}</Text>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(i) => i.id}
          state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
          error={{ code: state.kind === "error" ? state.code : "unknown", onRetry: reload }}
          empty={{ title: t("empty") }}
          {...(all.length > 0 && {
            noResults: {
              description: t("noResults"),
              onClear: () => setSource(""),
            },
          })}
          onOpen={(i) => router.push(`/admin/catalog/${i.id}`)}
          rowLabel={(i) => i.name}
        />
      </Stack>
    </ListPage>
  );
}
