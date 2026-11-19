import {
  ActionRow,
  BottomNav,
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

const noop = () => {};

type Approval = { id: string; agent: string; action: string; at: string };

const QUEUE: Approval[] = [
  { id: "run_8f2j9p", agent: "support-triage", action: "ticket.reply · ¥820 退款", at: "13:20:48" },
  { id: "run_8f2jw9", agent: "contract-review", action: "doc.sign · 合同盖章", at: "13:58:40" },
  { id: "run_8f2j5a", agent: "support-triage", action: "ticket.reply · ¥640 退款", at: "13:12:30" },
  { id: "run_8f2hx4", agent: "kb-ingest", action: "index.write · 覆盖索引", at: "12:58:02" },
];

function InboxBody() {
  useStatusBar("7 项待审批");
  const [active, setActive] = useState("run_8f2j9p");
  const item = QUEUE.find((a) => a.id === active) ?? QUEUE[0];
  return (
    <InboxPage
      header={{
        path: [{ label: "capybara", href: "/dev/ui" }, { label: "inbox" }],
        title: "审批",
        count: "7",
      }}
      list={
        <ListDetailList
          label="审批队列"
          items={QUEUE.map((a) => ({
            id: a.id,
            title: a.action,
            meta: a.agent,
            at: a.at,
            waiting: true,
          }))}
          current={active}
          onOpen={setActive}
        />
      }
      title={item?.action ?? ""}
      status={<StatusMark status="waiting" />}
      facts={[
        { label: "智能体", value: item?.agent ?? "" },
        { label: "键", value: "ticket.reply", mono: true },
        { label: "运行", value: item?.id ?? "" },
        { label: "时间", value: item?.at ?? "" },
      ]}
      factsLabel="详情"
      actionRow={{
        cancel: { label: "跳过", onSelect: noop },
        secondary: { label: "拒绝", onSelect: noop },
        primary: { label: "批准", shortcut: "⌘↵", onSelect: noop },
      }}
    >
      <Stack gap={8}>
        <Text>ticket.reply（需审批 &gt; ¥500）</Text>
        <Text tone="muted">客户申请退款 ¥820，超过自动审批上限 ¥500。</Text>
        <TraceSummary />
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
