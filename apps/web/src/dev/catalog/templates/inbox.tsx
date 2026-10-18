import {
  Card,
  type Column,
  DataTable,
  InboxPage,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
} from "@capybara-hq/design";
import { useState } from "react";
import { FixtureShell } from "../frame";
import { TraceSummary } from "../table";
import { DetailInspector } from "./detail";

const noop = () => {};

type Approval = { id: string; agent: string; action: string; at: string };

const QUEUE: Approval[] = [
  { id: "run_8f2j9p", agent: "support-triage", action: "ticket.reply · ¥820 退款", at: "13:20:48" },
  { id: "run_8f2jw9", agent: "contract-review", action: "doc.sign · 合同盖章", at: "13:58:40" },
  { id: "run_8f2j5a", agent: "support-triage", action: "ticket.reply · ¥640 退款", at: "13:12:30" },
  { id: "run_8f2hx4", agent: "kb-ingest", action: "index.write · 覆盖索引", at: "12:58:02" },
];

const COLUMNS: Column<Approval>[] = [
  {
    key: "agent",
    header: "待审批",
    cell: (a) => (
      <Stack gap={0}>
        <Text>{a.agent}</Text>
        <Text variant="small" tone="muted">
          {a.action}
        </Text>
      </Stack>
    ),
  },
  { key: "at", header: "时间", tone: "muted", cell: (a) => a.at },
];

function InboxBody() {
  useStatusBar("· 7 项待审批");
  const [active, setActive] = useState("run_8f2j9p");
  return (
    <InboxPage
      header={{ title: "审批", count: "7" }}
      list={
        <DataTable<Approval>
          label="审批队列"
          density="compact"
          framed={false}
          columns={COLUMNS}
          rows={QUEUE}
          rowKey={(a) => a.id}
          rowLabel={(a) => a.agent}
          activeKey={active}
          onOpen={(a) => setActive(a.id)}
        />
      }
      inspector={<DetailInspector />}
      inspectorTitle="Agent 属性"
      actionRow={{
        cancel: { label: "跳过", onSelect: noop },
        secondary: { label: "拒绝", onSelect: noop },
        primary: { label: "批准", shortcut: "⌘↵", onSelect: noop },
      }}
    >
      <Stack gap={16}>
        <Card title={`support-triage · ${active}`} actions={<StatusMark status="waiting" />}>
          <Stack gap={8}>
            <Text>ticket.reply（需审批 &gt; ¥500）</Text>
            <Text tone="muted">客户申请退款 ¥820，超过自动审批上限 ¥500。</Text>
          </Stack>
        </Card>
        <Card title="执行链路">
          <TraceSummary />
        </Card>
      </Stack>
    </InboxPage>
  );
}

/** T6 收件箱：人工审批。 */
export function InboxTemplate() {
  return (
    <FixtureShell nav="approvals" context="approvals">
      <InboxBody />
    </FixtureShell>
  );
}
