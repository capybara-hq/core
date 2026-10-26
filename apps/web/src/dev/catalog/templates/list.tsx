import {
  Button,
  Checkbox,
  type Column,
  DataTable,
  Icon,
  Input,
  ListPage,
  Sparkline,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
} from "@capybara-hq/design";
import { useState } from "react";
import { AGENT_MENU, AGENTS, type AgentRow, LIST_FACETS, LIST_KPIS, rateTone } from "../fixtures";
import { FixtureShell } from "../frame";

const COLUMNS: Column<AgentRow>[] = [
  {
    key: "name",
    header: "名称",
    cell: (a) => (
      <Stack direction="row" gap={8} align="baseline">
        <Text>{a.name}</Text>
        <Text variant="small" tone="faint">
          {a.ver}
        </Text>
      </Stack>
    ),
  },
  { key: "status", header: "状态", cell: () => <StatusMark status="success" label="已发布" /> },
  { key: "model", header: "模型", tone: "muted", cell: (a) => a.model },
  {
    key: "runs",
    header: "24H 运行",
    cell: (a) => (
      <Stack direction="row" gap={8} align="center">
        <Sparkline label={`${a.name} 24 小时运行趋势`} values={a.spark} />
        <Text>{a.runs}</Text>
      </Stack>
    ),
  },
  {
    key: "rate",
    header: "成功率",
    align: "right",
    cell: (a) => <Text tone={rateTone(a.rate)}>{a.rate}</Text>,
  },
  { key: "owner", header: "负责人", cell: (a) => a.owner },
  { key: "updated", header: "更新", tone: "muted", sortable: true, cell: (a) => a.updated },
];

/** 分面筛选：组标题 muted + 复选项 + 计数 faint（spec §5.1）。 */
export function Facets() {
  const [on, setOn] = useState<Set<string>>(
    () =>
      new Set(
        LIST_FACETS.flatMap((g) => g.items.filter((i) => i.on).map((i) => `${g.name}:${i.label}`)),
      ),
  );
  const toggle = (k: string) =>
    setOn((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  return (
    <Stack gap={16}>
      {LIST_FACETS.map((g) => (
        <Stack key={g.name} gap={4}>
          <Text variant="small" tone="muted">
            {g.name}
          </Text>
          {g.items.map((i) => {
            const k = `${g.name}:${i.label}`;
            return (
              <Stack key={k} direction="row" justify="between" align="center">
                <Checkbox checked={on.has(k)} onChange={() => toggle(k)} label={i.label} />
                <Text variant="small" tone="faint">
                  {i.count}
                </Text>
              </Stack>
            );
          })}
        </Stack>
      ))}
    </Stack>
  );
}

function ListBody() {
  useStatusBar("已筛选 18 / 24");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({
    key: "updated",
    dir: "desc",
  });
  return (
    <ListPage
      header={{
        title: "Agents",
        count: "24",
        metrics: LIST_KPIS,
        actions: [
          { label: "导入", variant: "default" },
          { label: "导出", variant: "default" },
          { label: "新建 Agent", variant: "primary", icon: "plus", href: "/dev/ui/templates/form" },
        ],
      }}
      rail={<Facets />}
    >
      <DataTable<AgentRow>
        label="Agents"
        columns={COLUMNS}
        rows={AGENTS}
        rowKey={(a) => a.name}
        rowLabel={(a) => a.name}
        selection={{ selected, onChange: setSelected }}
        bulkActions={() => <Button density="dense">停用</Button>}
        rowMenu={() => AGENT_MENU}
        sort={{ ...sort, onChange: (key, dir) => setSort({ key, dir }) }}
        toolbar={
          <Stack direction="row" gap={8} align="center">
            <Input
              aria-label="搜索 Agent"
              placeholder="搜索"
              prefix={<Icon name="search" size={14} />}
              suffix="/"
            />
            <Button density="dense">
              状态: 已发布
              <Icon name="x" size={14} />
            </Button>
            <Button density="dense" variant="ghost">
              清除全部
            </Button>
            <Button density="dense" variant="ghost">
              排序 最近更新
              <Icon name="chevron-down" size={14} />
            </Button>
          </Stack>
        }
        pagination={{
          page,
          pageSize,
          total: 18,
          pageSizes: [12, 24, 48],
          onPage: setPage,
          onPageSize: setPageSize,
        }}
      />
    </ListPage>
  );
}

/** T2 列表：Agents（e-list）。 */
export function ListTemplate() {
  return (
    <FixtureShell nav="agents" context="agents">
      <ListBody />
    </FixtureShell>
  );
}
