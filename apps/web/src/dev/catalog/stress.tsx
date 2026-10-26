import {
  Card,
  type Column,
  DataTable,
  DetailPage,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
} from "@capybara-hq/design";
import { FixtureShell } from "./frame";

const RARE = "𪚥 龘 靐 齉 爩 鱻 麤 𠀋 𡃁 㐀 䶵";

const LONG_TITLE =
  "customer-support-triage-for-enterprise-refund-and-chargeback-escalations-across-all-regions-v2-experimental";

type Row = { name: string; owner: string; runs: string; note: string };

const ROWS: Row[] = [
  { name: LONG_TITLE, owner: "欧阳·龘靐", runs: "1,234,567", note: RARE },
  { name: "kb-ingest", owner: "司马·齉爩", runs: "9,999,999", note: "超长备注".repeat(30) },
  { name: "𪚥-agent", owner: "grant", runs: "0", note: "—" },
];

const COLUMNS: Column<Row>[] = [
  { key: "name", header: "名称", cell: (r) => r.name },
  { key: "owner", header: "负责人", cell: (r) => r.owner },
  { key: "runs", header: "24H 运行", align: "right", cell: (r) => r.runs },
  { key: "note", header: "备注", tone: "muted", cell: (r) => r.note },
];

function StressBody() {
  useStatusBar(`· 已筛选 1,234,567 / 9,999,999 · ${RARE}`);
  return (
    <DetailPage
      header={{
        parent: { label: "Agents", href: "/dev/ui/templates/list" },
        title: LONG_TITLE,
        count: "v1234567",
        status: <StatusMark status="running" label={`运行中 ${RARE}`} />,
        metrics: [
          { label: "24H 运行", value: "1,234,567" },
          { label: "成功率", value: "99.9999%" },
          { label: "P50", value: "1,234.5s" },
          { label: "本月成本", value: "¥9,876,543" },
          { label: "TOKENS", value: "8,888,888" },
        ],
        actions: [
          { label: "编辑这个名字特别特别长的 Agent", variant: "default" },
          { label: "试运行", variant: "primary" },
        ],
      }}
      tabs={{
        label: "压力测试",
        value: "a",
        items: [
          { id: "a", label: "概要", count: "1,234,567" },
          { id: "b", label: `生僻字 ${RARE}` },
        ],
      }}
      inspector={
        <Stack gap={8}>
          <Text truncate>{LONG_TITLE}</Text>
          <Text>{RARE}</Text>
        </Stack>
      }
    >
      <Stack gap={16}>
        <Card title={LONG_TITLE}>
          <Stack gap={8}>
            <Text variant="h1">{RARE}</Text>
            <Text>{`${"超长正文不换行时应在容器内折行。".repeat(12)}`}</Text>
          </Stack>
        </Card>
        <DataTable<Row> label="压力表格" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.name} />
      </Stack>
    </DetailPage>
  );
}

/** `/dev/ui/stress`：超长标题、7 位数指标、生僻字。 */
export function StressCatalog() {
  return (
    <FixtureShell nav="agents" context={`agents/${LONG_TITLE}`}>
      <StressBody />
    </FixtureShell>
  );
}
