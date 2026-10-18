import {
  Card,
  type Column,
  DataTable,
  Grid,
  StatusMark,
  Text,
  Textarea,
  TracePage,
  useStatusBar,
} from "@capybara-hq/design";
import { useState } from "react";
import { FixtureShell } from "../frame";

type Span = {
  id: string;
  at: string;
  kind: string;
  name: string;
  status: "success" | "waiting" | "running";
  ms: string;
};

const SPANS: Span[] = [
  {
    id: "s1",
    at: "14:02:11.2",
    kind: "run",
    name: "support-triage v12",
    status: "running",
    ms: "18.0s",
  },
  {
    id: "s2",
    at: "14:02:11.8",
    kind: "plan",
    name: "分类 → 检索政策 → 起草回复",
    status: "success",
    ms: "676ms",
  },
  {
    id: "s3",
    at: "14:02:12.4",
    kind: "tool",
    name: 'kb.search("退款政策")',
    status: "success",
    ms: "312ms",
  },
  {
    id: "s4",
    at: "14:02:12.9",
    kind: "tool",
    name: "crm.get_order(A1043)",
    status: "success",
    ms: "204ms",
  },
  {
    id: "s5",
    at: "14:02:13.3",
    kind: "model",
    name: "claude-opus-5-5 · 9,214 tokens",
    status: "success",
    ms: "1.8s",
  },
  {
    id: "s6",
    at: "14:02:15.1",
    kind: "guard",
    name: "金额 > ¥500，需人工确认",
    status: "waiting",
    ms: "—",
  },
];

const COLUMNS: Column<Span>[] = [
  { key: "at", header: "时间", tone: "muted", cell: (s) => s.at },
  { key: "kind", header: "类型", cell: (s) => <StatusMark status={s.status} label={s.kind} /> },
  { key: "name", header: "Span", cell: (s) => s.name },
  { key: "ms", header: "耗时", align: "right", cell: (s) => s.ms },
];

function TraceBody() {
  useStatusBar("● 自动刷新 15s");
  const [active, setActive] = useState("s3");
  return (
    <TracePage
      header={{
        parent: { label: "运行记录", href: "/dev/ui/table" },
        title: "run_8f2k1x",
        status: <StatusMark status="running" />,
        metrics: [
          { label: "耗时", value: "18.0s" },
          { label: "TOKENS", value: "12,408" },
          { label: "SPANS", value: "6" },
        ],
      }}
      waterfall={
        <DataTable<Span>
          label="Span 瀑布"
          density="compact"
          columns={COLUMNS}
          rows={SPANS}
          rowKey={(s) => s.id}
          rowLabel={(s) => s.name}
          activeKey={active}
          onOpen={(s) => setActive(s.id)}
        />
      }
      detail={
        <Card title='tool · kb.search("退款政策")'>
          <Grid columns={2} gap={16}>
            <Textarea
              code
              aria-label="输入"
              readOnly
              rows={3}
              value={'{\n  "query": "退款政策",\n  "top_k": 5\n}'}
            />
            <Textarea
              code
              aria-label="输出"
              readOnly
              rows={3}
              value={'{\n  "hits": 3,\n  "best": "policy/refund.md#L12"\n}'}
            />
          </Grid>
          <Text variant="small" tone="muted">
            312ms · 10-18 14:02:12
          </Text>
        </Card>
      }
    />
  );
}

/** T8 链路查看器：单次运行。 */
export function TraceTemplate() {
  return (
    <FixtureShell nav="runs" context="runs/run_8f2k1x">
      <TraceBody />
    </FixtureShell>
  );
}
