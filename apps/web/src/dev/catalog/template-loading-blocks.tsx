"use client";

import {
  Card,
  type Column,
  DataTable,
  DetailPage,
  type HeaderAction,
  InboxPage,
  KeyValue,
  ObjectList,
  ObjectRow,
  OverviewPage,
  Stack,
  Text,
} from "@capybara-hq/design";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// The loading states of the Detail, Overview and Inbox templates (spec §5.2, §5.6, §5.7). Each
// template's `-default` and `-loading` blocks come from one fixture (the same header, tabs,
// filters, inspector and metrics), so the part boxes of the two can be compared. The box is the
// 1280-wide content area without the sidebar.

const W = 1280;
const H = 640;
const noop = () => {};

const PATH = [
  { label: "capybara", href: "/" },
  { label: "agents", href: "/" },
  { label: "研究助手" },
];
const ACTIONS: HeaderAction[] = [
  { label: "编辑", variant: "default" },
  { label: "试运行", variant: "secondary" },
];
const METRICS = [
  { label: "本周运行", value: "128" },
  { label: "失败", value: "3", tone: "warn" as const },
  { label: "平均耗时", value: "4.2s" },
  { label: "令牌", value: "1.2M" },
];
const TABS = {
  label: "页面",
  value: "summary",
  onChange: noop,
  items: [
    { id: "summary", label: "概要" },
    { id: "runs", label: "运行" },
    { id: "config", label: "配置" },
  ],
};
const PROPERTIES = [
  { k: "创建者", v: "grant" },
  { k: "模型", v: "claude-sonnet" },
  { k: "版本", v: "v12" },
  { k: "可见性", v: "组织" },
];

const inspector = <KeyValue rows={PROPERTIES} />;

const sections: ReactNode = (
  <>
    <Card title="概要">
      <Stack gap={8}>
        <Text>研究助手负责检索资料并整理成带出处的摘要。</Text>
        <Text tone="muted">最近一次发布在三天前。</Text>
      </Stack>
    </Card>
    <Card title="最近运行">
      <Text>128 次运行，3 次失败。</Text>
    </Card>
  </>
);

const DETAIL_HEADER = { path: PATH, title: "研究助手", actions: ACTIONS };
// The loading headers draw what the reference sources draw: a title bar and action blocks (the
// page does not know its title or actions yet); the tabs row is the template's own.
const loadingHeader = (path: typeof PATH, actions: number) => ({
  path,
  title: "",
  loading: { title: true, actions, tabs: 0 },
});

function detailBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-detail-default" width={W} height={H}>
        <DetailPage header={DETAIL_HEADER} tabs={TABS} inspector={inspector}>
          {sections}
        </DetailPage>
      </RefBlock>
      <RefBlock id="template-detail-loading" width={W} height={H}>
        <DetailPage
          header={loadingHeader(PATH, 2)}
          tabs={TABS}
          inspector={inspector}
          loading={{ inspector: true }}
        />
      </RefBlock>
    </>
  );
}

const OVERVIEW_HEADER = {
  path: PATH.slice(0, 1),
  title: "概览",
  description: "这个组织最近的运行情况。",
  actions: ACTIONS.slice(0, 1),
};

function overviewBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-overview-default" width={W} height={H}>
        <OverviewPage header={{ ...OVERVIEW_HEADER, metrics: METRICS }}>{sections}</OverviewPage>
      </RefBlock>
      <RefBlock id="template-overview-loading" width={W} height={H}>
        <OverviewPage
          header={loadingHeader(PATH.slice(0, 1), 1)}
          loading={{ stats: 4, sections: 2 }}
        />
      </RefBlock>
    </>
  );
}

const INBOX_HEADER = { path: PATH.slice(0, 1), title: "待我处理", actions: ACTIONS.slice(0, 1) };
const FILTERS = <Text tone="muted">全部 · 审批 · 提问</Text>;
const ITEMS = ["删除生产分支", "发送周报邮件", "更新客户表格"];

function inboxBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-inbox-default" width={W} height={H}>
        <InboxPage
          header={INBOX_HEADER}
          filters={FILTERS}
          list={
            <ObjectList label="待处理">
              {ITEMS.map((name) => (
                <ObjectRow key={name} mark={{ text: name }} name={name} description="等待审批" />
              ))}
            </ObjectList>
          }
        >
          {sections}
        </InboxPage>
      </RefBlock>
      <RefBlock id="template-inbox-loading" width={W} height={H}>
        <InboxPage
          header={loadingHeader(PATH.slice(0, 1), 1)}
          filters={FILTERS}
          loading={{ rows: 4 }}
        />
      </RefBlock>
    </>
  );
}

// The inbox whose list is a DataTable (the real /inbox: rowHeight="dense", framed={false}).
type Item = { id: string; title: string };
const RECORDS: Item[] = ITEMS.map((title, i) => ({ id: String(i), title }));
const COLUMNS: Column<Item>[] = [{ key: "title", header: "事项", cell: (r) => r.title }];
const TABLE = { label: "待处理", columns: COLUMNS, rowHeight: "dense", framed: false } as const;

function inboxRecordsBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-inbox-default-records" width={W} height={H}>
        <InboxPage
          header={INBOX_HEADER}
          filters={FILTERS}
          list={
            <DataTable<Item>
              label={TABLE.label}
              rowHeight="dense"
              framed={false}
              columns={COLUMNS}
              rows={RECORDS}
              rowKey={(r) => r.id}
            />
          }
        >
          {sections}
        </InboxPage>
      </RefBlock>
      <RefBlock id="template-inbox-loading-records" width={W} height={H}>
        <InboxPage
          header={loadingHeader(PATH.slice(0, 1), 1)}
          filters={FILTERS}
          loading={{ list: "records", table: TABLE }}
        />
      </RefBlock>
    </>
  );
}

export const TEMPLATE_LOADING_BLOCKS = {
  "template-detail": detailBlocks,
  "template-overview": overviewBlocks,
  "template-inbox": () => (
    <>
      {inboxBlocks()}
      {inboxRecordsBlocks()}
    </>
  ),
} as const;
