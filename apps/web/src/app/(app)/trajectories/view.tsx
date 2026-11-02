"use client";

import {
  Button,
  type Column,
  DataTable,
  DateTime,
  EmptyState,
  Field,
  ListPage,
  Select,
  Stack,
  StatusMark,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { usePagePath } from "../../../components/shell/path";
import { useRouter } from "../../../i18n/navigation";
import type { Agent } from "../../../lib/agents";
import { evalsTabs } from "../../../lib/evals-tabs";
import {
  listTrajectories,
  RUN_STATUSES,
  type RunStatus,
  runStatusMark,
  TRAJECTORY_PAGE,
  type TrajectoryListItem,
} from "../../../lib/trajectories";
import { useErrorMessage } from "../../../lib/use-error-message";

/** Rows per page. */

type Page = { items: TrajectoryListItem[]; next: string | null };
type Filters = { agentId: string; status: RunStatus | "" };

/** The list's URL for a set of filters (the server reads it). */
function hrefOf(f: Filters): string {
  const q = new URLSearchParams();
  if (f.agentId !== "") q.set("agentId", f.agentId);
  if (f.status !== "") q.set("status", f.status);
  const s = q.toString();
  return s === "" ? "/trajectories" : `/trajectories?${s}`;
}

/**
 * `/trajectories`: the runs (the trajectory viewer's list, ListPage). Org admins see every
 * conversation, an agent owner only their agents' (the kernel decides). The header tabs link to the
 * eval sets; above the table, filters by agent and by the latest run's status. The filters live in
 * the query (`?agentId=` presets the agent: the agent page's "Runs" link), so changing one is a
 * navigation and the server reads the new first page; "Load more" reads later pages in the
 * browser. The list is metadata only (no audit); a row opens the trajectory.
 *
 * `admin`: org admins see both views of evals and runs (eval sets are evals.manage); a member who
 * owns agents sees only their runs, titled "Runs", with no tabs (R1). `agents` is null when the
 * server could not read them.
 */
export default function Trajectories({
  orgId,
  admin,
  filters,
  initial,
}: {
  orgId: string;
  admin: boolean;
  filters: Filters;
  initial: { agents: Agent[] | null; page: Page };
}) {
  const scope = usePagePath("org");
  const t = useTranslations("trajectories");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { agentId, status } = filters;
  const navigate = (f: Filters) => startTransition(() => router.replace(hrefOf(f)));
  const agentOptions = [
    { value: "", label: t("filters.allAgents") },
    ...(initial.agents ?? []).map((a) => ({ value: a.id, label: a.definition.name || a.id })),
  ];
  // A preset agent missing from the list (deleted, or the agents could not be read) keeps an
  // option, so the filter and the select agree
  if (agentId !== "" && !agentOptions.some((o) => o.value === agentId)) {
    agentOptions.push({ value: agentId, label: agentId });
  }
  return (
    <ListPage
      header={{
        path: [...scope, { label: "trajectories" }],
        ...(admin
          ? { title: t("title"), tabs: evalsTabs(t), activeTab: "runs" }
          : { title: t("tabs.runs") }),
      }}
    >
      <Stack gap={12}>
        <Stack direction="row" gap={12} align="end">
          <Field label={t("filters.agent")}>
            <Select
              value={agentId}
              onChange={(e) => navigate({ agentId: e.target.value, status })}
              options={agentOptions}
            />
          </Field>
          <Field label={t("filters.status")}>
            <Select
              value={status}
              onChange={(e) => navigate({ agentId, status: e.target.value as RunStatus | "" })}
              options={[
                { value: "", label: t("filters.allStatuses") },
                ...RUN_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
              ]}
            />
          </Field>
        </Stack>
        <TrajectoryTable
          orgId={orgId}
          filters={filters}
          first={initial.page}
          onClear={() => navigate({ agentId: "", status: "" })}
        />
      </Stack>
    </ListPage>
  );
}

/** The list under one set of filters: the server's first page, then "Load more" by `next`. */
function TrajectoryTable({
  orgId,
  filters,
  first,
  onClear,
}: {
  orgId: string;
  filters: Filters;
  first: Page;
  onClear(): void;
}) {
  const t = useTranslations("trajectories");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const { agentId, status } = filters;
  // Later pages belong to the first page they continue (a new server page starts over)
  const [more, setMore] = useState<{ source: Page; page: Page } | null>(null);
  const extra = more !== null && more.source === first ? more.page : null;
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const rows = [...first.items, ...(extra?.items ?? [])];
  const next = extra !== null ? extra.next : first.next;
  const filtered = agentId !== "" || status !== "";

  const loadMore = async () => {
    if (next === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listTrajectories(orgId, {
        limit: TRAJECTORY_PAGE,
        ...(agentId !== "" && { agentId }),
        ...(status !== "" && { status }),
        before: next,
      });
      setMore({
        source: first,
        page: { items: [...(extra?.items ?? []), ...page.items], next: page.next },
      });
    } catch (e) {
      setMoreError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const columns: Column<TrajectoryListItem>[] = [
    {
      key: "title",
      header: t("columns.title"),
      cell: (r) => (
        <Text truncate tone={r.title === null ? "muted" : "ink"}>
          {r.title ?? t("untitled")}
        </Text>
      ),
    },
    { key: "agent", header: t("columns.agent"), cell: (r) => r.agentName || r.agentId },
    {
      key: "status",
      header: t("columns.status"),
      cell: (r) =>
        r.lastRun === null ? (
          <Text tone="muted">{t("noRun")}</Text>
        ) : (
          <StatusMark
            status={runStatusMark(r.lastRun.status)}
            label={t(`status.${r.lastRun.status}`)}
          />
        ),
    },
    {
      key: "updated",
      header: t("columns.updated"),
      tone: "muted",
      cell: (r) => <DateTime value={r.updatedAt} />,
    },
  ];

  if (rows.length === 0 && !filtered) return <EmptyState text={t("empty")} />;
  return (
    <Stack gap={12}>
      <DataTable<TrajectoryListItem>
        label={t("title")}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.conversationId}
        rowLabel={(r) => r.title ?? t("untitled")}
        state="ready"
        empty={{ title: t("empty"), hint: t("emptyHint") }}
        {...(filtered && { noResults: { description: t("noMatch"), onClear } })}
        onOpen={(r) => router.push(`/trajectories/${encodeURIComponent(r.conversationId)}`)}
      />
      {next !== null ? (
        <Stack direction="row" gap={8} align="center">
          <Button variant="default" onClick={() => void loadMore()} loading={loadingMore}>
            {t("loadMore")}
          </Button>
          {moreError !== null ? <Text tone="fail">{moreError}</Text> : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
