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
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { AdminGate } from "../../../../../../components/AdminGate";
import { useKindLabel } from "../../../../../../components/CatalogParts";
import { FormError } from "../../../../../../components/form-error";
import { useRouter } from "../../../../../../i18n/navigation";
import { issueLines } from "../../../../../../lib/api";
import {
  importMarketplaceEntry,
  listMarketplaceEntries,
  listMarketplaces,
  type MarketplaceEntry,
  PACKAGE_KINDS,
  type PackageKind,
} from "../../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

/**
 * `/[locale]/admin/marketplaces/entries`: browse marketplace entries (enterprise admins, ListPage).
 * Columns: name, kind, marketplace, publisher, summary, permission summary, versions (incompatible
 * ones greyed out), status (imported / new version); the Rail filters by marketplace, kind and
 * keyword. Row menu "Import <version>": extensions / connector templates / skills are imported
 * directly, plugins go to the review page. Errors such as `marketplace.integrity_mismatch` use a
 * prominent danger card; a warning when the marketplace's permission summary differs from the
 * downloaded package; a hint to narrow the filter when the entries are truncated.
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

type Notice =
  | { tone: "error"; message: string; extra: string[] }
  | { tone: "warn"; message: string };

function Catalog() {
  const t = useTranslations("catalog.admin.entries");
  const ta = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const kindLabel = useKindLabel();
  const [sourceId, setSourceId] = useState("");
  const [kind, setKind] = useState<PackageKind | "">("");
  const [q, setQ] = useState("");
  // 搜索词防抖：停止输入 300 ms 后才重新请求
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
        ...(kind !== "" && { kind }),
        ...(query !== "" && { q: query }),
      }),
    [sourceId, kind, query],
  );
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState<string>();
  const rows = state.kind === "ready" ? state.data.items : [];
  const truncated = state.kind === "ready" && state.data.truncated === true;
  const sourceList = sources.state.kind === "ready" ? sources.state.data.items : [];

  const doImport = async (e: MarketplaceEntry, version: string) => {
    if (e.kind === "app") {
      const qs = new URLSearchParams({ catalog: e.sourceId, name: e.name, version });
      router.push(`/admin/catalog/plugins/review?${qs.toString()}`);
      return;
    }
    setBusy(`${e.sourceId}/${e.kind}/${e.name}`);
    setNotice(undefined);
    try {
      const r = await importMarketplaceEntry(e, version);
      toast.success(t("imported", { name: e.name, version }));
      if (r.permissionsMismatch !== null) {
        setNotice({ tone: "warn", message: t("mismatch", { name: e.name }) });
      }
      reload();
    } catch (err) {
      setNotice({ tone: "error", message: errorMessage(err), extra: issueLines(err) });
    } finally {
      setBusy(undefined);
    }
  };

  const summaryOf = (e: MarketplaceEntry) =>
    locale === "zh" && e.summary.zh !== undefined ? e.summary.zh : e.summary.en;

  const columns: Column<MarketplaceEntry>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (e) => (
        <Stack gap={0}>
          <Text>{e.name}</Text>
          <Text variant="small" tone="muted">
            {e.npm}
          </Text>
        </Stack>
      ),
    },
    { key: "kind", header: t("columns.kind"), cell: (e) => kindLabel(e.kind) },
    { key: "source", header: t("columns.source"), tone: "muted", cell: (e) => e.sourceName },
    { key: "publisher", header: t("columns.publisher"), tone: "muted", cell: (e) => e.publisher },
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
      key: "versions",
      header: t("columns.versions"),
      cell: (e) => (
        <Stack gap={0}>
          {e.versions.slice(0, 5).map((v) =>
            v.compatible ? (
              <Text key={v.version} variant="small">
                {v.version}
              </Text>
            ) : (
              <Text key={v.version} variant="small" tone="faint">
                {t("incompatible", { version: v.version })}
              </Text>
            ),
          )}
        </Stack>
      ),
    },
    {
      key: "status",
      header: t("columns.status"),
      cell: (e) =>
        e.adopted === null ? (
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
          <RadioGroup
            label={ta("filters.kind")}
            value={kind}
            onChange={(v) => setKind(v as PackageKind | "")}
            options={[
              { value: "", label: ta("filters.allKinds") },
              ...PACKAGE_KINDS.map((k) => ({ value: k, label: kindLabel(k) })),
            ]}
          />
        </Stack>
      }
    >
      <Stack gap={12}>
        <Text tone="muted">{t("hint")}</Text>
        {truncated && <Text tone="warn">{t("truncated")}</Text>}
        {notice?.tone === "error" && (
          <Card tone="danger">
            <FormError message={notice.message} extra={notice.extra} />
          </Card>
        )}
        {notice?.tone === "warn" && (
          <Card tone="accent">
            <Text tone="warn">{notice.message}</Text>
          </Card>
        )}
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(e) => `${e.sourceId}/${e.kind}/${e.name}`}
          rowLabel={(e) => e.name}
          state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
          error={{ code: state.kind === "error" ? state.code : "unknown", onRetry: reload }}
          empty={{
            title: sourceId === "" && kind === "" && query === "" ? t("empty") : t("noResults"),
          }}
          rowMenu={(e) => {
            const compatible = e.versions.filter((v) => v.compatible);
            const pending = busy === `${e.sourceId}/${e.kind}/${e.name}`;
            return compatible.length === 0
              ? [{ label: t("noCompatible"), disabled: true, onSelect: () => {} }]
              : compatible.slice(0, 5).map((v) => ({
                  label: t("importVersion", { version: v.version }),
                  disabled: pending || (e.adopted?.versions.includes(v.version) ?? false),
                  onSelect: () => void doImport(e, v.version),
                }));
          }}
        />
      </Stack>
    </ListPage>
  );
}
