import {
  ActionRow,
  BottomNav,
  Card,
  type Column,
  DataTable,
  InboxPage,
  ListDetail,
  ListDetailItem,
  ListDetailList,
  type ListDetailListItem,
  ReferenceScreen,
  Stack,
  StatusMark,
  Text,
  TopBar,
  useStatusBar,
} from "@capybara-hq/design";
import { LIST_DETAIL_FIXTURE as F } from "@capybara-hq/design/fixtures";
import { type ReactNode, useState } from "react";
import { bottomItems, overflow } from "../compact-shell-blocks";
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
// docs/design/reference/src/list-detail.html: the compact ones in the screen the shell gives them
// (the top bar, and the bottom navigation on the list, a tab root), two panes alone.
const LD_ITEMS: ListDetailListItem[] = F.items.map((i) => ({
  id: i.id,
  title: i.title,
  meta: i.meta,
  at: i.at,
  ...(i.state === "warn" ? { waiting: true } : {}),
}));

function ldDetail(): ReactNode {
  const by = (variant: "primary" | "default") =>
    F.detail.decisions.filter((d) => d.variant === variant).map((d) => d.label);
  const [cancel = "", secondary = ""] = by("default");
  const [primary = ""] = by("primary");
  return (
    <ListDetailItem
      title={F.detail.title}
      facts={F.detail.facts.map((f) => ({
        label: f.label,
        value: f.value,
        ...(f.mono ? { mono: true } : {}),
      }))}
      actions={
        <ActionRow
          cancel={{ label: cancel, onSelect: noop }}
          secondary={{ label: secondary, onSelect: noop }}
          primary={{ label: primary, onSelect: noop }}
        />
      }
    />
  );
}

function LdRegion({ open, current }: { open: boolean; current?: string }) {
  const [opened, setOpened] = useState(open);
  return (
    <ListDetail
      list={
        <ListDetailList
          label={F.listTitle}
          items={LD_ITEMS}
          current={current}
          onOpen={() => setOpened(true)}
        />
      }
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
        <ReferenceScreen
          top={<TopBar title={F.listTitle} onSearch={noop} menu={overflow} />}
          bottom={<BottomNav items={bottomItems(true)} current="inbox" />}
        >
          <LdRegion open={false} />
        </ReferenceScreen>
      </RefBlock>
      <RefBlock id="list-detail-compact-detail" width={390} height={844}>
        <ReferenceScreen
          top={<TopBar title={F.detail.title} back={noop} onSearch={noop} menu={overflow} />}
        >
          <LdRegion open />
        </ReferenceScreen>
      </RefBlock>
      <RefBlock id="list-detail-two-pane" width={720} height={560}>
        <ReferenceScreen>
          <LdRegion open current="ib1" />
        </ReferenceScreen>
      </RefBlock>
    </>
  );
}
