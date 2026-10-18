import {
  Button,
  type Column,
  DataTable,
  Input,
  Stack,
  StatusMark,
  Text,
} from "@capybara-hq/design";
import { useState } from "react";
import {
  RUN_MENU,
  RUNS_TOTAL,
  TABLE_CHECKED,
  TABLE_DISABLED_KEY,
  TABLE_EXPANDED_KEY,
  TABLE_RUNS,
  TABLE_SELECTED_KEY,
  type TableRun,
  TRACE_LINES,
} from "./fixtures";
import { CatalogPage, Section } from "./frame";

const noop = () => {};

const COLUMNS: Column<TableRun>[] = [
  { key: "note", header: "标注", tone: "muted", cell: (r) => r.note },
  { key: "at", header: "时间", tone: "muted", sortable: true, cell: (r) => r.at },
  { key: "id", header: "RUN", tone: "muted", cell: (r) => r.id },
  { key: "agent", header: "AGENT", sortable: true, cell: (r) => r.agent },
  { key: "status", header: "状态", cell: (r) => <StatusMark status={r.status} /> },
  { key: "duration", header: "耗时", align: "right", cell: (r) => r.duration },
  { key: "tokens", header: "TOKENS", align: "right", cell: (r) => r.tokens },
];

const PLAIN_COLUMNS = COLUMNS.filter((c) => c.key !== "note");

/** 链路摘要的各行（不含容器）：展开行里每行由 DataTable 加 └ 引导。 */
export function TraceLines() {
  return (
    <>
      {TRACE_LINES.map((l) => (
        <Stack key={l.at} direction="row" gap={12} align="center">
          <Text variant="small" tone="muted">
            {l.at}
          </Text>
          <StatusMark status={l.status} label={l.kind} />
          <Text variant="small">{l.text}</Text>
          {l.ms ? (
            <Text variant="small" tone="muted">
              {l.ms}
            </Text>
          ) : (
            <Button size={24} variant="ghost">
              去审批 →
            </Button>
          )}
        </Stack>
      ))}
    </>
  );
}

/** 链路摘要（卡片内用）：各行纵向排列。 */
export function TraceSummary() {
  return (
    <Stack gap={4}>
      <TraceLines />
    </Stack>
  );
}

/** `/dev/ui/table`：spec §6.6 行状态、批量栏、行内菜单、展开、排序、分页与四种空状态。 */
export function TableCatalog() {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set(TABLE_CHECKED));
  const [active, setActive] = useState(TABLE_SELECTED_KEY);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({
    key: "at",
    dir: "desc",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  return (
    <CatalogPage
      title="表格 DataTable"
      subtitle="行状态 · 批量操作 · 行内菜单 · 展开 · 加载 / 空 / 错误 · 分页"
    >
      <Section
        title="行状态"
        note="左侧「标注」列不属于组件；勾选后工具栏原位替换为批量操作栏，仍属表格外框的一部分"
      >
        <DataTable<TableRun>
          label="运行记录（行状态）"
          columns={COLUMNS}
          rows={TABLE_RUNS}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.id}
          selection={{ selected: checked, onChange: setChecked }}
          bulkActions={() => (
            <>
              <Button size={24}>↻ 重新运行</Button>
              <Button size={24}>导出</Button>
              <Button size={24} variant="danger">
                终止
              </Button>
            </>
          )}
          activeKey={active}
          onOpen={(r) => setActive(r.id)}
          rowMenu={() => RUN_MENU}
          expand={(r) => (r.id === TABLE_EXPANDED_KEY ? <TraceLines /> : null)}
          isDisabled={(r) => r.id === TABLE_DISABLED_KEY}
          sort={{ ...sort, onChange: (key, dir) => setSort({ key, dir }) }}
          pagination={{
            page,
            pageSize,
            total: RUNS_TOTAL,
            pageSizes: [20, 50, 100],
            onPage: setPage,
            onPageSize: setPageSize,
          }}
        />
      </Section>
      <Section title="工具栏与紧凑行" note="搜索、已应用筛选、清除全部、排序；行高 28">
        <DataTable<TableRun>
          label="运行记录（工具栏）"
          density="compact"
          columns={PLAIN_COLUMNS}
          rows={TABLE_RUNS.slice(0, 4)}
          rowKey={(r) => r.id}
          rowMenu={() => RUN_MENU}
          toolbar={
            <Stack direction="row" gap={8} align="center">
              <Input aria-label="搜索运行" placeholder="搜索 run / agent" prefix="⌕" suffix="/" />
              <Button size={24}>状态: 失败 ✕</Button>
              <Button size={24} variant="ghost">
                清除全部
              </Button>
              <Button size={24} variant="ghost">
                排序 时间 ▾
              </Button>
            </Stack>
          }
        />
      </Section>
      <Section title="加载中" note="骨架行，不用转圈">
        <DataTable<TableRun>
          label="运行记录（加载中）"
          state="loading"
          columns={PLAIN_COLUMNS}
          rows={[]}
          rowKey={(r) => r.id}
        />
      </Section>
      <Section title="空" note="首次使用，给出下一步">
        <DataTable<TableRun>
          label="运行记录（空）"
          columns={PLAIN_COLUMNS}
          rows={[]}
          rowKey={(r) => r.id}
          empty={{
            title: "还没有运行记录",
            hint: "创建一个 Agent 并触发第一次运行",
            action: <Button variant="primary">+ 新建 Agent</Button>,
          }}
        />
      </Section>
      <Section title="无结果" note="由筛选导致">
        <DataTable<TableRun>
          label="运行记录（无结果）"
          columns={PLAIN_COLUMNS}
          rows={[]}
          rowKey={(r) => r.id}
          noResults={{ description: "没有匹配「kb-ingest · 失败」的记录", onClear: noop }}
        />
      </Section>
      <Section title="错误" note="说明原因，可重试">
        <DataTable<TableRun>
          label="运行记录（错误）"
          state="error"
          error={{ code: "E_UPSTREAM_TIMEOUT", requestId: "req_7f3a91", onRetry: noop }}
          columns={PLAIN_COLUMNS}
          rows={[]}
          rowKey={(r) => r.id}
        />
      </Section>
    </CatalogPage>
  );
}
