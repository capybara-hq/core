"use client";

import {
  Avatar,
  Badge,
  Button,
  type Column,
  DataTable,
  DateTime,
  Field,
  ListPage,
  Select,
  Stack,
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
  type AdminAgentFilter,
  type AdminAgentRow,
  type AdminAgentsPage,
  adminAvatarValue,
} from "../../../../lib/admin-items";
import { adminOrgsQuery } from "../../../../lib/query/admin";
import { adminAgentsQuery } from "../../../../lib/query/admin-items";
import { retryOnMountOf } from "../../../../lib/query/client";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/** The search box debounce (a browser timer; no server state involved). */
const SEARCH_DEBOUNCE_MS = 300;

type Filter = { orgId: string; q: string };

/** The list's address for a filter. */
function hrefOf(f: Filter): string {
  const q = new URLSearchParams();
  if (f.orgId !== "") q.set("orgId", f.orgId);
  if (f.q !== "") q.set("q", f.q);
  const s = q.toString();
  return s === "" ? "/admin/agents" : `/admin/agents?${s}`;
}

/**
 * `/admin/agents` (super admins; spec 2026-11-10-admin-agents-connectors §3.2): every org's live
 * agents, under the header tabs 智能体 / 模板. Columns: the avatar and name, the org, the owner (a
 * 待重新指派 chip while the agent waits for a new owner), the visibility, the template it was
 * created from, the update time. The org filter and the name search live in the address
 * (`?orgId=&q=`), so changing one is a navigation and each filter is its own cache entry (the
 * layout prefetched the address's first page and the orgs on a first load); "Load more" reads
 * later pages in the browser. A row opens the agent's detail.
 */
export default function AdminAgentsView({ filter }: { filter: Filter }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminAgents filter={filter} />;
}

type T = ReturnType<typeof useTranslations<"adminItems.agents">>;

/** The table's columns (the loading table draws the same header). */
const agentColumns = (t: T): Column<AdminAgentRow>[] => [
  {
    key: "name",
    header: t("columns.name"),
    cell: (a) => (
      <Stack direction="row" gap={8} align="center">
        <Avatar value={adminAvatarValue(a.avatar)} name={a.name} size={24} />
        <Text truncate>{a.name}</Text>
      </Stack>
    ),
  },
  { key: "org", header: t("columns.org"), cell: (a) => a.orgName },
  {
    key: "owner",
    header: t("columns.owner"),
    cell: (a) => (
      <Stack direction="row" gap={8} align="center">
        <Text truncate>{a.ownerName}</Text>
        {a.needsReassignment && <Badge tone="warn">{t("needsReassignment")}</Badge>}
      </Stack>
    ),
  },
  {
    key: "visibility",
    header: t("columns.visibility"),
    tone: "muted",
    cell: (a) => t(`visibility.${a.visibility}`),
  },
  {
    key: "from",
    header: t("columns.from"),
    tone: "muted",
    cell: (a) => a.createdFrom?.name ?? "—",
  },
  {
    key: "updated",
    header: t("columns.updated"),
    tone: "muted",
    fit: true,
    cell: (a) => <DateTime value={a.updatedAt} />,
  },
];

function AdminAgents({ filter }: { filter: Filter }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminItems.agents");
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
      if (q !== filter.q) navigate({ orgId: filter.orgId, q });
    }, SEARCH_DEBOUNCE_MS);
  };
  const oq = adminOrgsQuery();
  const orgs = useQuery({ ...oq, retryOnMount: retryOnMountOf(oq.queryKey) }).data?.orgs ?? [];
  const first = usePageQuery(adminAgentsQuery(filter));
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
  const filtered = filter.orgId !== "" || filter.q !== "";
  const header = {
    path: [...scope, { label: "agents" }],
    title: t("title"),
    description: t("description"),
    ...adminItemTabs("agents", "items", { items: ti("agents"), templates: ti("templates") }),
    search: { label: t("search"), value: text, onChange: onSearch },
  };
  const filters = (
    <Field label={t("filters.org")}>
      <Select
        value={filter.orgId}
        onChange={(e) => navigate({ orgId: e.target.value, q: filter.q })}
        options={orgOptions}
      />
    </Field>
  );
  if (first.kind === "loading") {
    return (
      <ListPage
        header={header}
        filters={filters}
        loading={{ table: { label: t("listLabel"), columns: agentColumns(t) } }}
      />
    );
  }
  const nothingYet = !filtered && first.data.agents.length === 0;
  return (
    <ListPage
      header={header}
      filters={filters}
      {...(nothingYet ? { empty: { text: t("empty") } } : {})}
    >
      {!nothingYet && (
        <AgentTable
          // A new filter starts over (its own pages)
          key={hrefOf(filter)}
          filter={filter}
          first={first.data}
          filtered={filtered}
          onClear={() => {
            clearTimeout(timer.current);
            setText("");
            navigate({ orgId: "", q: "" });
          }}
        />
      )}
    </ListPage>
  );
}

/** The list under one filter: its first page, then "Load more" by `next`. */
function AgentTable({
  filter,
  first,
  filtered,
  onClear,
}: {
  filter: AdminAgentFilter;
  first: AdminAgentsPage;
  filtered: boolean;
  onClear(): void;
}) {
  const t = useTranslations("adminItems.agents");
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  // Later pages belong to the first page they continue: a newer answer for the first page (a
  // refetch after an invalidation, even an equal one) starts over, so a deleted row on a later page
  // never stays
  const firstAt = useQuery(adminAgentsQuery(filter)).dataUpdatedAt;
  const [more, setMore] = useState<{ source: number; pages: AdminAgentsPage[] }>({
    source: firstAt,
    pages: [],
  });
  const pages = more.source === firstAt ? more.pages : [];
  const rows = [...first.agents, ...pages.flatMap((p) => p.agents)];
  const next = pages.length > 0 ? (pages.at(-1) as AdminAgentsPage).next : first.next;
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const loadMore = async (after: string) => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await qc.fetchQuery(adminAgentsQuery(filter, after));
      setMore({ source: firstAt, pages: [...pages, page] });
    } catch (e) {
      setMoreError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Stack gap={12}>
      <DataTable<AdminAgentRow>
        label={t("listLabel")}
        columns={agentColumns(t)}
        rows={rows}
        rowKey={(a) => a.id}
        rowLabel={(a) => a.name}
        state="ready"
        empty={{ title: t("empty"), hint: t("emptyHint") }}
        {...(filtered && { noResults: { description: t("noMatch"), onClear } })}
        onOpen={(a) => router.push(`/admin/agents/${encodeURIComponent(a.id)}`)}
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
