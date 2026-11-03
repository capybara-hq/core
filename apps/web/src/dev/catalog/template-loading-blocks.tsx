"use client";

import {
  AuthPage,
  Button,
  Card,
  type Column,
  DataTable,
  DetailPage,
  Field,
  FormSection,
  Grid,
  type HeaderAction,
  InboxPage,
  Input,
  KeyValue,
  ListPage,
  ObjectList,
  ObjectRow,
  OverviewPage,
  SettingsPage,
  SpanWaterfall,
  Stack,
  Text,
  TracePage,
  WizardPage,
} from "@capybara-hq/design";
import { LIST_PAGE_FIXTURE, PAGE_HEADER_FIXTURE } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { TRACE_SPANS } from "./fixtures";
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
const loadingHeader = (path: typeof PATH, actions: number, description?: string) => ({
  path,
  title: "",
  ...(description ? { description } : {}),
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
          header={loadingHeader(PATH.slice(0, 1), 1, OVERVIEW_HEADER.description)}
          loading={{ stats: 4, sections: 2 }}
        />
      </RefBlock>
      {/* The home overview's shape: a main-side grid of two card stacks (spec §5.6). */}
      <RefBlock id="template-overview-main-side" width={W} height={H}>
        <OverviewPage header={OVERVIEW_HEADER}>
          <Grid columns="main-side">
            <Stack gap={16}>{sections}</Stack>
            <Stack gap={16}>{sections}</Stack>
          </Grid>
        </OverviewPage>
      </RefBlock>
      <RefBlock id="template-overview-loading-main-side" width={W} height={H}>
        <OverviewPage
          header={loadingHeader(PATH.slice(0, 1), 1, OVERVIEW_HEADER.description)}
          loading={{ stats: 0, mainSide: { main: 2, side: 2 } }}
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

// Settings, Wizard and Auth (spec §5.8, §5.9, §5.10). The loading blocks are what the page draws
// while its data is on the way; the default ones are the loaded page with the same header, nav,
// steps and field counts.

const SETTINGS_NAV = [
  {
    group: "组织",
    items: [
      { id: "org", label: "组织", href: "/" },
      { id: "env", label: "环境", href: "/" },
      { id: "members", label: "成员", href: "/", count: 5 },
    ],
  },
  { group: "计费", items: [{ id: "billing", label: "计费", href: "/" }] },
];
const SETTINGS_HEADER = { path: PATH.slice(0, 1), title: "设置" };
const SETTINGS_ROW = {
  unsaved: 1,
  cancel: { label: "取消", onSelect: noop },
  primary: { label: "保存", onSelect: noop },
};

function settingsBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-settings-default" width={W} height={H}>
        <SettingsPage
          header={SETTINGS_HEADER}
          nav={SETTINGS_NAV}
          activeNav="org"
          actionRow={SETTINGS_ROW}
        >
          <FormSection id="org" title="组织信息" description="名称显示在顶栏与邀请邮件中。">
            <Field label="组织名称">
              <Input defaultValue="示例组织" />
            </Field>
            <Field label="时区">
              <Input defaultValue="UTC+8 北京" />
            </Field>
          </FormSection>
          <FormSection id="security" title="安全" description="登录与会话的规则。">
            <Field label="会话时长">
              <Input defaultValue="12 小时" />
            </Field>
          </FormSection>
        </SettingsPage>
      </RefBlock>
      <RefBlock id="template-settings-loading" width={W} height={H}>
        <SettingsPage
          header={{ ...SETTINGS_HEADER, title: "" }}
          nav={SETTINGS_NAV}
          activeNav="org"
          actionRow={SETTINGS_ROW}
          loading={{ sections: [{ fields: 2 }, { fields: 1 }] }}
        />
      </RefBlock>
    </>
  );
}

const WIZARD_HEADER = { path: PATH.slice(0, 1), title: "接入模型" };
const WIZARD_STEPS = ["选择供应商", "填写凭据", "测试连接", "完成"];
const WIZARD_ROW = {
  cancel: { label: "取消", onSelect: noop },
  secondary: { label: "上一步", onSelect: noop },
  primary: { label: "下一步", onSelect: noop },
};

function wizardBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-wizard-default" width={W} height={H}>
        <WizardPage header={WIZARD_HEADER} steps={WIZARD_STEPS} current={1} actionRow={WIZARD_ROW}>
          <Card title="填写凭据">
            <Stack gap={16}>
              <Field label="名称">
                <Input defaultValue="anthropic" />
              </Field>
              <Field label="API Key">
                <Input type="password" defaultValue="sk-ant" />
              </Field>
            </Stack>
          </Card>
        </WizardPage>
      </RefBlock>
      <RefBlock id="template-wizard-loading" width={W} height={H}>
        <WizardPage
          header={{ ...WIZARD_HEADER, title: "" }}
          steps={WIZARD_STEPS}
          current={1}
          actionRow={WIZARD_ROW}
          loading={{ fields: 2 }}
        />
      </RefBlock>
    </>
  );
}

function authBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-auth-default" width={W} height={H}>
        <AuthPage title="登录" subtitle="示例组织">
          <Stack gap={16}>
            <Field label="账号">
              <Input defaultValue="grant" />
            </Field>
            <Field label="密码">
              <Input type="password" defaultValue="" />
            </Field>
            <Button variant="primary" density="prominent">
              登录
            </Button>
          </Stack>
        </AuthPage>
      </RefBlock>
      <RefBlock id="template-auth-loading" width={W} height={H}>
        <AuthPage title="登录" subtitle="示例组织" loading={{ fields: 2 }} />
      </RefBlock>
    </>
  );
}

// List and Trace (spec §5.1, §5.11). The list is the objects variant with a tabs row (the loading
// page keeps its tabs with a dash for the counts); the trace's waterfall loading has as many rows as
// the loaded fixture has spans.

const LIST_ACTIONS: HeaderAction[] = [
  { label: LIST_PAGE_FIXTURE.secondaryAction, variant: "default" },
  { label: LIST_PAGE_FIXTURE.primaryAction, variant: "primary", icon: "plus" },
];
const LIST_HEADER = {
  path: PATH.slice(0, 1),
  title: PAGE_HEADER_FIXTURE.title,
  actions: LIST_ACTIONS,
  tabs: PAGE_HEADER_FIXTURE.tabs,
  activeTab: "all",
  search: { label: PAGE_HEADER_FIXTURE.search, value: "", onChange: noop },
};
const AGENTS = ["研究助手", "周报助手", "客服助手"];

/** The loading states of the List template; `template-list-page` stays in reference-blocks. */
export function listLoadingBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-list-default-objects" width={W} height={H}>
        <ListPage header={LIST_HEADER} variant="objects" listLabel="Agents">
          {AGENTS.map((name) => (
            <ObjectRow key={name} mark={{ text: name }} name={name} description="检索资料并整理" />
          ))}
        </ListPage>
      </RefBlock>
      <RefBlock id="template-list-loading-objects" width={W} height={H}>
        <ListPage header={LIST_HEADER} variant="objects" listLabel="Agents" loading />
      </RefBlock>
    </>
  );
}

const TRACE_HEADER = {
  path: PATH.slice(0, 1),
  title: "退款工单 A1043",
  actions: ACTIONS.slice(0, 1),
};
const TRACE_METRICS = [
  { label: "总 TOKEN", value: "12,408" },
  { label: "成本（估算）", value: "0.0412 USD" },
  { label: "调用数", value: "6" },
  { label: "耗时", value: "6.8s" },
];

function traceBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-trace-default" width={W} height={H}>
        <TracePage
          header={{ ...TRACE_HEADER, metrics: TRACE_METRICS }}
          waterfall={
            <SpanWaterfall
              label="Span 瀑布"
              spans={TRACE_SPANS}
              selectedId="s0"
              onSelect={noop}
              labels={{ empty: "这个对话还没有开始过运行。" }}
            />
          }
          detail={
            <Card title="工具调用 · crm__refund_order">
              <KeyValue rows={PROPERTIES} />
            </Card>
          }
        />
      </RefBlock>
      <RefBlock id="template-trace-loading" width={W} height={H}>
        <TracePage
          header={loadingHeader(PATH.slice(0, 1), 1)}
          waterfall={null}
          detail={null}
          loading={{ spans: TRACE_SPANS.length, stats: TRACE_METRICS.length }}
        />
      </RefBlock>
    </>
  );
}

export const TEMPLATE_LOADING_BLOCKS = {
  "template-trace": traceBlocks,
  "template-settings": settingsBlocks,
  "template-wizard": wizardBlocks,
  "template-auth": authBlocks,
  "template-detail": detailBlocks,
  "template-overview": overviewBlocks,
  "template-inbox": () => (
    <>
      {inboxBlocks()}
      {inboxRecordsBlocks()}
    </>
  ),
} as const;
