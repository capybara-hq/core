"use client";

import {
  Button,
  type Column,
  DataTable,
  Field,
  ListPage,
  RadioGroup,
  Select,
  Stack,
  StatusMark,
  Text,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatTime } from "../../../../components/ApprovalCard";
import { OrgGate } from "../../../../components/OrgGate";
import { useRouter } from "../../../../i18n/navigation";
import { listAgents } from "../../../../lib/agents";
import {
  listTrajectories,
  RUN_STATUSES,
  type RunStatus,
  runStatusMark,
  type TrajectoryListItem,
} from "../../../../lib/trajectories";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useLoad } from "../../../../lib/use-load";

/** 每页条数。 */
const PAGE = 50;

/**
 * `/[locale]/trajectories`：运行记录（轨迹查看器的列表，ListPage）。组织管理员看全部对话，agent 负责人只看
 * 自己负责的 agent（由内核判定）。Rail 按 agent 与最近一次运行的状态筛选；`?agentId=` 预选 agent
 * （agent 详情页的「运行记录」入口）。列表只有元数据，不写审计；打开一行进详情。
 */
export default function TrajectoriesPage() {
  return <OrgGate>{(orgId) => <Trajectories key={orgId} orgId={orgId} />}</OrgGate>;
}

/** 查询串只在浏览器里读（会话加载前不渲染本组件，所以不涉及服务端渲染）。 */
const initialAgent = (): string => {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("agentId") ?? "";
};

function Trajectories({ orgId }: { orgId: string }) {
  const t = useTranslations("trajectories");
  const [agentId, setAgentId] = useState(initialAgent);
  const [status, setStatus] = useState<RunStatus | "">("");
  const agents = useLoad(() => listAgents(orgId).then((r) => r.agents), [orgId]);
  const agentOptions = [
    { value: "", label: t("filters.allAgents") },
    ...(agents.state.kind === "ready" ? agents.state.data : []).map((a) => ({
      value: a.id,
      label: a.definition.name || a.id,
    })),
  ];
  // 预选的 agent 不在列表里（如已删除）时也保留一项，筛选值与下拉框一致
  if (agentId !== "" && !agentOptions.some((o) => o.value === agentId)) {
    agentOptions.push({ value: agentId, label: agentId });
  }
  return (
    <ListPage
      header={{ title: t("title") }}
      rail={
        <Stack gap={16}>
          <Field label={t("filters.agent")}>
            <Select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              options={agentOptions}
            />
          </Field>
          <RadioGroup
            label={t("filters.status")}
            value={status}
            onChange={(v) => setStatus(v as RunStatus | "")}
            options={[
              { value: "", label: t("filters.allStatuses") },
              ...RUN_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
            ]}
          />
        </Stack>
      }
    >
      <TrajectoryTable
        key={`${agentId}\n${status}`}
        orgId={orgId}
        agentId={agentId}
        status={status}
        onClear={() => {
          setAgentId("");
          setStatus("");
        }}
      />
    </ListPage>
  );
}

/** 一组筛选条件下的列表；「加载更多」按 `next` 往后翻页（筛选变了整个组件重建）。 */
function TrajectoryTable({
  orgId,
  agentId,
  status,
  onClear,
}: {
  orgId: string;
  agentId: string;
  status: RunStatus | "";
  onClear(): void;
}) {
  const t = useTranslations("trajectories");
  const locale = useLocale();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const filters = {
    ...(agentId !== "" && { agentId }),
    ...(status !== "" && { status }),
  };
  const first = useLoad(
    () => listTrajectories(orgId, { limit: PAGE, ...filters }),
    [orgId, agentId, status],
  );
  const [more, setMore] = useState<{ items: TrajectoryListItem[]; next: string | null } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const firstPage = first.state.kind === "ready" ? first.state.data : null;
  const rows = [...(firstPage?.items ?? []), ...(more?.items ?? [])];
  const next = more !== null ? more.next : (firstPage?.next ?? null);
  const filtered = agentId !== "" || status !== "";

  const loadMore = async () => {
    if (next === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listTrajectories(orgId, { limit: PAGE, ...filters, before: next });
      setMore((m) => ({ items: [...(m?.items ?? []), ...page.items], next: page.next }));
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
      cell: (r) => formatTime(r.updatedAt, locale),
    },
  ];

  return (
    <Stack gap={12}>
      <DataTable<TrajectoryListItem>
        label={t("title")}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.conversationId}
        rowLabel={(r) => r.title ?? t("untitled")}
        state={
          first.state.kind === "loading"
            ? "loading"
            : first.state.kind === "error"
              ? "error"
              : "ready"
        }
        {...(first.state.kind === "error" && {
          error: { code: first.state.code, onRetry: first.reload },
        })}
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
