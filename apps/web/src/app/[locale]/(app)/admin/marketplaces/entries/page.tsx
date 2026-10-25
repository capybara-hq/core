"use client";

import {
  Badge,
  Card,
  type Column,
  DataTable,
  Field,
  Input,
  ListPage,
  RadioGroup,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { AdminGate } from "../../../../../../components/AdminGate";
import { FormError } from "../../../../../../components/form-error";
import { useRouter } from "../../../../../../i18n/navigation";
import { issueLines } from "../../../../../../lib/api";
import {
  importMarketplaceEntry,
  importPageHref,
  listMarketplaceEntries,
  listMarketplaces,
  type MarketplaceEntry,
  marketplaceSourceText,
} from "../../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

/**
 * `/[locale]/admin/marketplaces/entries`: browse marketplace entries (enterprise admins, ListPage).
 * One entry is one version of a plugin. Columns: name (and its source), marketplace, summary,
 * permission summary, version (incompatible ones marked), status (imported / new version / needs
 * git marketplaces); the Rail filters by marketplace and keyword. Row menu "Import <version>":
 * downloads, verifies and stages the plugin, then opens the import review
 * (`/admin/catalog/import?staging=<id>`, which shows the marketplace's permission mismatch too). `path` / `git` entries are listed but not importable
 * ("needs git marketplaces", phase A). Errors such as `marketplace.integrity_mismatch` use a
 * prominent danger card; a hint to narrow the filter when the entries are truncated.
 */
export default function MarketplaceEntriesPage() {
  return (
    <AdminGate>
      <Catalog />
    </AdminGate>
  );
}

/** 搜索框的防抖时长（浏览器里的计时，不涉及服务端状态）。 */
const SEARCH_DEBOUNCE_MS = 300;

type Notice = { message: string; extra: string[] };

/** One entry's row key: an entry is one version of a plugin in one marketplace. */
const keyOf = (e: MarketplaceEntry) => `${e.sourceId}/${e.name}/${e.version ?? ""}`;

function Catalog() {
  const t = useTranslations("catalog.admin.entries");
  const ta = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [sourceId, setSourceId] = useState("");
  const [q, setQ] = useState("");
  // Debounced search: request again 300 ms after typing stops
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);
  const sources = useLoad(listMarketplaces, []);
  const { state, reload } = useLoad(
    () =>
      listMarketplaceEntries({
        ...(sourceId !== "" && { sourceId }),
        ...(query !== "" && { q: query }),
      }),
    [sourceId, query],
  );
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState<string>();
  const rows = state.kind === "ready" ? state.data.items : [];
  const truncated = state.kind === "ready" && state.data.truncated === true;
  const sourceList = sources.state.kind === "ready" ? sources.state.data.items : [];

  const doImport = async (e: MarketplaceEntry) => {
    setBusy(keyOf(e));
    setNotice(undefined);
    try {
      const p = await importMarketplaceEntry(e, e.version);
      router.push(importPageHref(p.stagingId));
    } catch (err) {
      setNotice({ message: errorMessage(err), extra: issueLines(err) });
    } finally {
      setBusy(undefined);
    }
  };

  const summaryOf = (e: MarketplaceEntry) =>
    locale === "zh" && e.summary.zh !== undefined ? e.summary.zh : e.summary.en;
  const imported = (e: MarketplaceEntry) =>
    e.version !== null && (e.adopted?.versions.includes(e.version) ?? false);

  const columns: Column<MarketplaceEntry>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (e) => (
        <Stack gap={0}>
          <Text>{e.name}</Text>
          <Text variant="small" tone="muted">
            {marketplaceSourceText(e.source)}
          </Text>
        </Stack>
      ),
    },
    { key: "source", header: t("columns.source"), tone: "muted", cell: (e) => e.sourceName },
    { key: "summary", header: t("columns.summary"), cell: (e) => summaryOf(e) },
    {
      key: "permissions",
      header: t("columns.permissions"),
      cell: (e) =>
        e.permissions === null ? (
          <Text tone="muted">{t("permissionsNone")}</Text>
        ) : (
          <Stack gap={0}>
            <Text>{t("permissionsCount", { n: e.permissions.keys.length })}</Text>
            {e.permissions.sensitive.length > 0 && (
              <Text variant="small" tone="warn">
                {t("permissionsSensitive", { n: e.permissions.sensitive.length })}
              </Text>
            )}
          </Stack>
        ),
    },
    {
      key: "version",
      header: t("columns.version"),
      cell: (e) =>
        e.compatible ? (
          <Text variant="small">{e.version ?? t("noVersion")}</Text>
        ) : (
          <Text variant="small" tone="faint">
            {t("incompatible", { version: e.version ?? t("noVersion") })}
          </Text>
        ),
    },
    {
      key: "status",
      header: t("columns.status"),
      cell: (e) =>
        !e.importable ? (
          <Text tone="muted">{t("needsGitMarketplaces")}</Text>
        ) : e.adopted === null ? (
          <Text tone="muted">{t("notAdopted")}</Text>
        ) : (
          <Stack direction="row" gap={8} align="center">
            <Text>{t("adopted", { version: e.adopted.versions[0] ?? "" })}</Text>
            {e.newerAvailable && <Badge tone="accent">{td("newer")}</Badge>}
          </Stack>
        ),
    },
  ];

  return (
    <ListPage
      header={{
        parent: { label: ta("title"), href: "/admin/catalog" },
        title: t("title"),
        ...(state.kind === "ready" && { count: `${rows.length}${truncated ? "+" : ""}` }),
      }}
      rail={
        <Stack gap={16}>
          <Field label={t("search")}>
            <Input
              value={q}
              placeholder={t("searchPlaceholder")}
              onChange={(e) => setQ(e.target.value)}
            />
          </Field>
          <RadioGroup
            label={ta("filters.source")}
            value={sourceId}
            onChange={setSourceId}
            options={[
              { value: "", label: ta("filters.allSources") },
              ...sourceList.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </Stack>
      }
    >
      <Stack gap={12}>
        <Text tone="muted">{t("hint")}</Text>
        {truncated && <Text tone="warn">{t("truncated")}</Text>}
        {notice !== undefined && (
          <Card tone="danger">
            <FormError message={notice.message} extra={notice.extra} />
          </Card>
        )}
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={keyOf}
          rowLabel={(e) => (e.version === null ? e.name : `${e.name} ${e.version}`)}
          state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
          error={{ code: state.kind === "error" ? state.code : "unknown", onRetry: reload }}
          empty={{ title: sourceId === "" && query === "" ? t("empty") : t("noResults") }}
          rowMenu={(e) => [
            !e.importable
              ? { label: t("needsGitMarketplaces"), disabled: true, onSelect: () => {} }
              : !e.compatible
                ? { label: t("noCompatible"), disabled: true, onSelect: () => {} }
                : {
                    label:
                      e.version === null ? t("import") : t("importVersion", { version: e.version }),
                    disabled: busy === keyOf(e) || imported(e),
                    onSelect: () => void doImport(e),
                  },
          ]}
        />
      </Stack>
    </ListPage>
  );
}
