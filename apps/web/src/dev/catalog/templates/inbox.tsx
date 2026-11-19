import {
  ActionRow,
  Card,
  type Column,
  DataTable,
  InboxPage,
  KeyValue,
  ListDetail,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
} from "@capybara-hq/design";
import { LIST_DETAIL_FIXTURE as F } from "@capybara-hq/design/fixtures";
import { type ReactNode, useState } from "react";
import { FixtureShell } from "../frame";
import { RefBlock } from "../ref-block";
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
  useStatusBar("7 项待审批");
  const [active, setActive] = useState("run_8f2j9p");
  return (
    <InboxPage
      header={{
        path: [{ label: "capybara", href: "/dev/ui" }, { label: "inbox" }],
        title: "审批",
        count: "7",
      }}
      list={
        <DataTable<Approval>
          label="审批队列"
          rowHeight="dense"
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
      inspectorTitle="智能体属性"
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

// ListDetail (spec §6.47): the region in its three states, with the ids and boxes of
// docs/design/reference/src/list-detail.html (the shell's top bar and bottom navigation around the
// compact ones are the shell blocks' own; the region draws its own back bar here).
type ListItem = (typeof F.items)[number];

const LD_COLUMNS: Column<ListItem>[] = [
  {
    key: "title",
    header: F.listTitle,
    cell: (i) => (
      <Stack gap={0}>
        <Text>{i.title}</Text>
        <Text variant="small" tone="muted">
          {i.meta}
        </Text>
      </Stack>
    ),
  },
  { key: "at", header: "", tone: "muted", cell: (i) => i.at },
];

function ldList(current?: string): ReactNode {
  return (
    <DataTable<ListItem>
      label={F.listTitle}
      rowHeight="roomy"
      framed={false}
      columns={LD_COLUMNS}
      rows={F.items}
      rowKey={(i) => i.id}
      rowLabel={(i) => i.title}
      {...(current ? { activeKey: current } : {})}
      onOpen={noop}
    />
  );
}

function ldDetail(): ReactNode {
  const [primary, ...others] = [...F.detail.decisions].reverse();
  return (
    <>
      <Stack gap={12}>
        <Text variant="h2">{F.detail.title}</Text>
        <KeyValue
          rows={F.detail.facts.map((f) => ({
            k: f.label,
            v: f.mono ? <Text variant="body">{f.value}</Text> : f.value,
          }))}
        />
      </Stack>
      <ActionRow
        cancel={{ label: others[1]?.label ?? "", onSelect: noop }}
        secondary={{ label: others[0]?.label ?? "", onSelect: noop }}
        primary={{ label: primary?.label ?? "", onSelect: noop }}
      />
    </>
  );
}

function LdRegion({ open, current }: { open: boolean; current?: string }) {
  const [opened, setOpened] = useState(open);
  return (
    <ListDetail
      list={ldList(current)}
      detail={opened ? ldDetail() : null}
      onBack={() => setOpened(false)}
      listMin={320}
      detailMin={360}
      label={F.listTitle}
    />
  );
}

export function listDetailBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="list-detail-compact-list" width={390} height={844}>
        <LdRegion open={false} />
      </RefBlock>
      <RefBlock id="list-detail-compact-detail" width={390} height={844}>
        <LdRegion open />
      </RefBlock>
      <RefBlock id="list-detail-two-pane" width={720} height={560}>
        <LdRegion open current="ib1" />
      </RefBlock>
    </>
  );
}
