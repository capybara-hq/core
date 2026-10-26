import {
  Badge,
  BarChart,
  Button,
  Card,
  type Column,
  DataTable,
  DetailPage,
  KeyValue,
  Segmented,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
} from "@capybara-hq/design";
import { useState } from "react";
import {
  DETAIL_KPIS,
  DETAIL_PROPS,
  DETAIL_TABS,
  DETAIL_TAGS,
  RECENT_RUNS,
  type RecentRun,
  RUN_TREND,
  SEGMENTS,
  TREND_AXIS,
} from "../fixtures";
import { FixtureShell } from "../frame";

const noop = () => {};

const RUN_COLUMNS: Column<RecentRun>[] = [
  { key: "at", header: "时间", tone: "muted", cell: (r) => r.at },
  { key: "id", header: "RUN", tone: "muted", cell: (r) => r.id },
  { key: "status", header: "状态", cell: (r) => <StatusMark status={r.status} /> },
  { key: "trigger", header: "触发", cell: (r) => r.trigger },
  { key: "duration", header: "耗时", align: "right", cell: (r) => r.duration },
  { key: "tokens", header: "TOKENS", align: "right", cell: (r) => r.tokens },
];

/** Inspector：分组属性，组标题 small muted（spec §5.2）。 */
export function DetailInspector() {
  return (
    <Stack gap={16}>
      {DETAIL_PROPS.map((g) => (
        <Stack key={g.title} gap={4}>
          <Text variant="small" tone="muted">
            {g.title}
          </Text>
          <KeyValue rows={g.rows.map(([k, v]) => ({ k, v }))} />
        </Stack>
      ))}
      <Stack gap={4}>
        <Text variant="small" tone="muted">
          标签
        </Text>
        <Stack direction="row" gap={4}>
          {DETAIL_TAGS.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </Stack>
      </Stack>
    </Stack>
  );
}

function DetailBody() {
  useStatusBar("· v12 由 张琳 发布于 2 小时前");
  const [tab, setTab] = useState("summary");
  const [range, setRange] = useState("24h");
  const [inspector, setInspector] = useState(true);
  return (
    <DetailPage
      header={{
        parent: { label: "Agents", href: "/dev/ui/templates/list" },
        title: "support-triage",
        count: "v12",
        status: <StatusMark status="success" label="已发布" />,
        metrics: DETAIL_KPIS,
        actions: [
          { label: "编辑", variant: "default", href: "/dev/ui/templates/form" },
          { label: "试运行", variant: "secondary", href: "/dev/ui/templates/playground" },
          {
            label: "更多操作",
            menu: [
              { label: "复制", onSelect: noop },
              { label: "导出 YAML", onSelect: noop },
              { label: "停用", danger: true, onSelect: noop },
            ],
          },
        ],
      }}
      tabs={{ label: "Agent 页内导航", items: DETAIL_TABS, value: tab, onChange: setTab }}
      inspector={inspector ? <DetailInspector /> : undefined}
      inspectorTitle="属性"
      onInspectorClose={() => setInspector(false)}
    >
      <Stack gap={16}>
        <Card
          title="运行趋势"
          actions={
            <Segmented
              label="时间范围"
              options={SEGMENTS.slice(0, 3)}
              value={range}
              onChange={setRange}
            />
          }
        >
          <Stack gap={8}>
            <BarChart label="24 小时运行趋势" series={RUN_TREND} current={RUN_TREND.length - 1} />
            <Stack direction="row" justify="between">
              {TREND_AXIS.map((t) => (
                <Text key={t} variant="small" tone="faint">
                  {t}
                </Text>
              ))}
            </Stack>
          </Stack>
        </Card>
        <Card
          title="最近运行"
          actions={
            <Button density="dense" variant="ghost">
              查看全部 412 →
            </Button>
          }
        >
          <DataTable<RecentRun>
            label="最近运行"
            framed={false}
            columns={RUN_COLUMNS}
            rows={RECENT_RUNS}
            rowKey={(r) => r.id}
          />
        </Card>
      </Stack>
    </DetailPage>
  );
}

/** T3 详情：support-triage（e-detail）。 */
export function DetailTemplate() {
  return (
    <FixtureShell nav="agents" context="agents/support-triage">
      <DetailBody />
    </FixtureShell>
  );
}
