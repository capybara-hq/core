"use client";

import {
  Button,
  type Column,
  DataTable,
  DateTime,
  Field,
  ListPage,
  Select,
  Stack,
  StatusMark,
  Text,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { adminItemTabs } from "../../../../components/admin-item-tabs";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import {
  type AdminConnectorFilter,
  type AdminConnectorRow,
  type AdminConnectorsPage,
  connectorStatusOf,
} from "../../../../lib/admin-items";
import { adminOrgsQuery } from "../../../../lib/query/admin";
import { adminConnectorsQuery } from "../../../../lib/query/admin-items";
import { retryOnMountOf } from "../../../../lib/query/client";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/** The search box debounce (a browser timer; no server state involved). */
const SEARCH_DEBOUNCE_MS = 300;

type Filter = { orgId: string; status: "active" | "disabled" | ""; q: string };

/** The list's address for a filter. */
function hrefOf(f: Filter): string {
  const q = new URLSearchParams();
  if (f.orgId !== "") q.set("orgId", f.orgId);
  if (f.status !== "") q.set("status", f.status);
  if (f.q !== "") q.set("q", f.q);
  const s = q.toString();
  return s === "" ? "/admin/connectors" : `/admin/connectors?${s}`;
}

/**
 * `/admin/connectors` (super admins; spec 2026-11-10-admin-agents-connectors §3.4): every org's
 * live connectors, under the header tabs 连接器 / 模板. Columns: the name, the org, the kind (its
 * connector extension), the template it came from, the status, the tool count, the last tool sync
 * and who created it. The org and status filters and the name search live in the address
 * (`?orgId=&status=&q=`), so changing one is a navigation and each filter is its own cache entry
 * (the layout prefetched the address's first page and the orgs on a first load); "Load more" reads
 * later pages in the browser. A row opens the connector's detail.
 */
export default function AdminConnectorsView({ filter }: { filter: Filter }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminConnectors filter={filter} />;
}

type T = ReturnType<typeof useTranslations<"adminItems.connectors">>;

/** The table's columns (the loading table draws the same header). */
const connectorColumns = (t: T): Column<AdminConnectorRow>[] => [
  { key: "name", header: t("columns.name"), cell: (c) => <Text truncate>{c.name}</Text> },
  { key: "org", header: t("columns.org"), cell: (c) => c.orgName },
  { key: "kind", header: t("columns.kind"), tone: "muted", cell: (c) => c.connector },
  {
    key: "from",
    header: t("columns.from"),
    tone: "muted",
    cell: (c) =>
      c.platformTemplateId !== null
        ? (c.templateName ?? t("fromPlatform"))
        : c.catalogItemId !== null
          ? t("fromCatalog")
          : "—",
  },
  {
    key: "status",
    header: t("columns.status"),
    fit: true,
    cell: (c) => (
      <StatusMark
        status={c.status === "active" ? "success" : "cancelled"}
        label={t(`status.${c.status}`)}
      />
    ),
  },
  { key: "tools", header: t("columns.tools"), tone: "muted", fit: true, cell: (c) => c.toolCount },
  {
    key: "synced",
    header: t("columns.synced"),
    tone: "muted",
    fit: true,
    cell: (c) => (c.toolsSyncedAt === null ? t("never") : <DateTime value={c.toolsSyncedAt} />),
  },
  { key: "createdBy", header: t("columns.createdBy"), tone: "muted", cell: (c) => c.createdByName },
];

function AdminConnectors({ filter }: { filter: Filter }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminItems.connectors");
  const ti = useTranslations("adminItems.tabs");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const navigate = (f: Filter) => startTransition(() => router.replace(hrefOf(f)));
  // The search box: typed here, written to the address 300 ms after typing stops (a timer per
  // keystroke, so only typing navigates: Back to another search keeps that address)
  const [text, setText] = useState(filter.q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onSearch = (v: string) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const q = v.trim();
      if (q !== filter.q) navigate({ ...filter, q });
    }, SEARCH_DEBOUNCE_MS);
  };
  const oq = adminOrgsQuery();
  const orgs = useQuery({ ...oq, retryOnMount: retryOnMountOf(oq.queryKey) }).data?.orgs ?? [];
  const first = usePageQuery(adminConnectorsQuery(filter));
  if (first.kind === "notFound") return <NotFound />;
  if (first.kind === "error") return <ErrorFrame reset={first.retry} />;

  const orgOptions = [
    { value: "", label: t("filters.allOrgs") },
    ...orgs.map((o) => ({ value: o.id, label: o.name })),
  ];
  // An org in the address missing from the list keeps an option, so the filter and the select agree
  if (filter.orgId !== "" && !orgOptions.some((o) => o.value === filter.orgId)) {
    orgOptions.push({ value: filter.orgId, label: filter.orgId });
  }
  const filtered = filter.orgId !== "" || filter.status !== "" || filter.q !== "";
  const header = {
    path: [...scope, { label: "connectors" }],
    title: t("title"),
    description: t("description"),
    ...adminItemTabs("connectors", "items", {
      items: ti("connectors"),
      templates: ti("templates"),
    }),
    search: { label: t("search"), value: text, onChange: onSearch },
  };
  const filters = (
    <Stack direction="row" gap={12}>
      <Field label={t("filters.org")}>
        <Select
          value={filter.orgId}
          onChange={(e) => navigate({ ...filter, orgId: e.target.value })}
          options={orgOptions}
        />
      </Field>
      <Field label={t("filters.status")}>
        <Select
          value={filter.status}
          onChange={(e) => navigate({ ...filter, status: connectorStatusOf(e.target.value) })}
          options={[
            { value: "", label: t("filters.allStatuses") },
            { value: "active", label: t("status.active") },
            { value: "disabled", label: t("status.disabled") },
          ]}
        />
      </Field>
    </Stack>
  );
  if (first.kind === "loading") {
    return (
      <ListPage
        header={header}
        filters={filters}
        loading={{ table: { label: t("listLabel"), columns: connectorColumns(t) } }}
      />
    );
  }
  const nothingYet = !filtered && first.data.connectors.length === 0;
  return (
    <ListPage
      header={header}
      filters={filters}
      {...(nothingYet ? { empty: { text: t("empty") } } : {})}
    >
      {!nothingYet && (
        <ConnectorTable
          // A new filter starts over (its own pages)
          key={hrefOf(filter)}
          filter={filter}
          first={first.data}
          filtered={filtered}
          onClear={() => {
            clearTimeout(timer.current);
            setText("");
            navigate({ orgId: "", status: "", q: "" });
          }}
        />
      )}
    </ListPage>
  );
}

/** The list under one filter: its first page, then "Load more" by `next`. */
function ConnectorTable({
  filter,
  first,
  filtered,
  onClear,
}: {
  filter: AdminConnectorFilter;
  first: AdminConnectorsPage;
  filtered: boolean;
  onClear(): void;
}) {
  const t = useTranslations("adminItems.connectors");
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  // Later pages belong to the first page they continue: a newer answer for the first page (a
  // refetch after an invalidation, even an equal one) starts over, so a deleted row on a later page
  // never stays
  const firstAt = useQuery(adminConnectorsQuery(filter)).dataUpdatedAt;
  const [more, setMore] = useState<{ source: number; pages: AdminConnectorsPage[] }>({
    source: firstAt,
    pages: [],
  });
  const pages = more.source === firstAt ? more.pages : [];
  const rows = [...first.connectors, ...pages.flatMap((p) => p.connectors)];
  const next = pages.length > 0 ? (pages.at(-1) as AdminConnectorsPage).next : first.next;
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const loadMore = async (after: string) => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await qc.fetchQuery(adminConnectorsQuery(filter, after));
      setMore({ source: firstAt, pages: [...pages, page] });
    } catch (e) {
      setMoreError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Stack gap={12}>
      <DataTable<AdminConnectorRow>
        label={t("listLabel")}
        columns={connectorColumns(t)}
        rows={rows}
        rowKey={(c) => c.id}
        rowLabel={(c) => c.name}
        state="ready"
        empty={{ title: t("empty"), hint: t("emptyHint") }}
        {...(filtered && { noResults: { description: t("noMatch"), onClear } })}
        onOpen={(c) => router.push(`/admin/connectors/${encodeURIComponent(c.id)}`)}
      />
      {next !== null && (
        <Stack direction="row" gap={8} align="center">
          <Button loading={loadingMore} onClick={() => void loadMore(next)}>
            {t("loadMore")}
          </Button>
          {moreError !== null && <Text tone="fail">{moreError}</Text>}
        </Stack>
      )}
    </Stack>
  );
}
