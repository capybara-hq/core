"use client";

import {
  AuthPage,
  Button,
  Callout,
  Card,
  type Column,
  DataTable,
  DetailPage,
  Field,
  FormSection,
  type HeaderAction,
  InboxPage,
  Input,
  ItemList,
  ItemListItem,
  KeyValue,
  ListPage,
  ObjectCard,
  ObjectList,
  ObjectRow,
  OverviewPage,
  RadioGroup,
  Select,
  SettingsPage,
  SpanWaterfall,
  Stack,
  Switch,
  Text,
  TracePage,
  WizardPage,
} from "@capybara-hq/design";
import { LIST_PAGE_FIXTURE, PAGE_HEADER_FIXTURE } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { AGENT_CARDS } from "./card-grid-blocks";
import { TRACE_SPANS } from "./fixtures";
import { RefBlock } from "./ref-block";

// The loading states of the Detail, Overview and Inbox templates (spec §5.2, §5.6, §5.7). Each
// template's `-default` and `-loading` blocks come from one fixture (the same header, tabs,
// filters, facts, inspector and metrics), so the part boxes of the two can be compared. The box is the
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

const facts = <KeyValue rows={PROPERTIES} />;

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
        <DetailPage header={DETAIL_HEADER} tabs={TABS} facts={facts}>
          {sections}
        </DetailPage>
      </RefBlock>
      <RefBlock id="template-detail-loading" width={W} height={H}>
        <DetailPage header={loadingHeader(PATH, 2)} tabs={TABS} loading={{ facts: true }} />
      </RefBlock>
      {/* A tab with a known static structure: facts, actions and a table (spec §5.2). */}
      <RefBlock id="template-detail-content" width={W} height={H}>
        <DetailPage header={DETAIL_HEADER} tabs={TABS}>
          <Stack gap={16}>
            <KeyValue columns={2} rows={PROPERTIES} />
            <Stack direction="row" gap={8}>
              <Button>停用</Button>
              <Button variant="secondary">升级</Button>
            </Stack>
            <Stack gap={8}>
              <Text variant="small" tone="muted">
                副本
              </Text>
              <DataTable<{ id: string }>
                label="副本"
                columns={REPLICA_COLUMNS}
                rows={[{ id: "api-1" }]}
                rowKey={(r) => r.id}
              />
            </Stack>
          </Stack>
        </DetailPage>
      </RefBlock>
      <RefBlock id="template-detail-loading-content" width={W} height={H}>
        <DetailPage
          header={loadingHeader(PATH, 2)}
          tabs={TABS}
          loading={{
            content: [
              { kind: "key-value", rows: 4, columns: 2 },
              { kind: "buttons", count: 2 },
              {
                kind: "table",
                title: "副本",
                label: "副本",
                columns: REPLICA_COLUMNS as Column<never>[],
              },
            ],
          }}
        />
      </RefBlock>
    </>
  );
}

const REPLICA_COLUMNS: Column<{ id: string }>[] = [
  { key: "id", header: "副本", cell: (r) => r.id },
];

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
      {/* A note that does not depend on the data stays while the numbers load (spec §5.6). */}
      <RefBlock id="template-overview-keep" width={W} height={H}>
        <OverviewPage header={{ ...OVERVIEW_HEADER, metrics: METRICS }}>
          <Callout tone="info">超级管理员看不到任何对话内容。</Callout>
        </OverviewPage>
      </RefBlock>
      <RefBlock id="template-overview-loading-keep" width={W} height={H}>
        <OverviewPage
          header={loadingHeader(PATH.slice(0, 1), 1, OVERVIEW_HEADER.description)}
          loading={{ stats: METRICS.length, keep: true }}
        >
          <Callout tone="info">超级管理员看不到任何对话内容。</Callout>
        </OverviewPage>
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
      {/* Control groups that are no Field: card radios with a hint, a KeyValue, a switch row. */}
      <RefBlock id="template-settings-radio-cards" width={W} height={H}>
        <SettingsPage header={SETTINGS_HEADER} nav={SETTINGS_NAV} activeNav="org">
          <FormSection id="policy" title="沙箱工具" description="沙箱工具的默认策略。">
            <Stack gap={8}>
              <RadioGroup
                label="沙箱工具"
                variant="card"
                value="allow"
                onChange={noop}
                options={[
                  { value: "allow", label: "直接运行", description: "沙箱里的命令直接执行。" },
                  { value: "ask", label: "需要审批", description: "除只读工具外都要审批。" },
                ]}
              />
              <Text variant="small" tone="muted">
                只有管理员可以修改。
              </Text>
            </Stack>
          </FormSection>
          <FormSection id="limits" title="沙箱资源" description="每个沙箱的 CPU 与内存。">
            <Stack gap={8}>
              <KeyValue
                keyWidth="10ch"
                rows={[
                  { k: "CPU", v: "2 核" },
                  { k: "内存", v: "4096 MB" },
                  { k: "来源", v: "部署默认" },
                ]}
              />
              <Text variant="small" tone="muted">
                只对新建的沙箱生效。
              </Text>
            </Stack>
          </FormSection>
          <FormSection id="ext" title="待办" description="1.0.0">
            <Stack direction="row" gap={12} align="center">
              <Switch label="启用待办" checked onChange={noop} />
              <Text>已启用</Text>
            </Stack>
            <Text variant="prose" tone="muted">
              必需插件：每个组织都已启用，不能停用。
            </Text>
            <Stack gap={8}>
              <Text variant="small" tone="muted">
                权限
              </Text>
              {/* Rows split by hairlines inside the form card, never cards (spec §1). */}
              <ItemList label="权限">
                {["存储", "网络"].map((g) => (
                  <ItemListItem
                    key={g}
                    title={g}
                    meta={
                      <>
                        <span>· read</span>
                        <span>· write</span>
                      </>
                    }
                  />
                ))}
              </ItemList>
            </Stack>
          </FormSection>
        </SettingsPage>
      </RefBlock>
      <RefBlock id="template-settings-loading-radio-cards" width={W} height={H}>
        <SettingsPage
          header={{ ...SETTINGS_HEADER, title: "" }}
          nav={SETTINGS_NAV}
          activeNav="org"
          loading={{
            sections: [
              {
                title: "沙箱工具",
                description: "沙箱工具的默认策略。",
                fields: [{ control: "radio-cards", options: 2, help: true }],
              },
              {
                title: "沙箱资源",
                description: "每个沙箱的 CPU 与内存。",
                fields: [{ control: "key-value", rows: 3, keyWidth: "10ch", help: true }],
              },
              { fields: [{ control: "switch" }, { control: "text" }, { control: "item-group" }] },
            ],
          }}
        />
      </RefBlock>
      {/* A stack of titled cards (the installed plugins). */}
      <RefBlock id="template-settings-cards" width={W} height={H}>
        <SettingsPage header={SETTINGS_HEADER} nav={SETTINGS_NAV} activeNav="org">
          <Stack gap={16}>
            {["crm 1.2.0", "todo 0.3.0", "board 2.0.0"].map((name) => (
              <section key={name} aria-label={name}>
                <Card title={name} actions={<Button variant="danger">卸载</Button>}>
                  <Stack gap={8}>
                    <Text tone="muted">已安装 · 2026-10-20 09:00</Text>
                    <Stack gap={4}>
                      <Text variant="small" tone="muted">
                        组件
                      </Text>
                      <Text variant="small">· 连接器 crm — 由安装创建</Text>
                      <Text variant="small">· 技能 notes — 由安装创建</Text>
                    </Stack>
                  </Stack>
                </Card>
              </section>
            ))}
          </Stack>
        </SettingsPage>
      </RefBlock>
      <RefBlock id="template-settings-loading-cards" width={W} height={H}>
        <SettingsPage
          header={{ ...SETTINGS_HEADER, title: "" }}
          nav={SETTINGS_NAV}
          activeNav="org"
          loading={{ cards: { shape: { lines: 1, list: 2, actions: 1 } } }}
        />
      </RefBlock>
      {/* A section that lists items (the model purposes): rows in a flush card, never cards. */}
      <RefBlock id="template-settings-items" width={W} height={H}>
        <SettingsPage header={SETTINGS_HEADER} nav={SETTINGS_NAV} activeNav="org">
          <FormSection id="purposes" title="模型用途" description="每个用途用哪个模型。" flush>
            <ItemList label="用途" inset="flush">
              {PURPOSES.map((p) => (
                <ItemListItem
                  key={p.code}
                  title={p.title}
                  code={p.code}
                  meta={p.lines.map((l) => (
                    <Text key={l} variant="small" tone="muted">
                      {l}
                    </Text>
                  ))}
                >
                  <Field label="模型">
                    <Select value="" onChange={noop} options={[{ value: "", label: "使用默认" }]} />
                  </Field>
                </ItemListItem>
              ))}
            </ItemList>
          </FormSection>
        </SettingsPage>
      </RefBlock>
      <RefBlock id="template-settings-loading-items" width={W} height={H}>
        <SettingsPage
          header={{ ...SETTINGS_HEADER, title: "" }}
          nav={SETTINGS_NAV}
          activeNav="org"
          loading={{
            sections: [
              {
                title: "模型用途",
                description: "每个用途用哪个模型。",
                items: PURPOSES.map((p) => ({
                  lines: p.lines.length,
                  lineSize: "small" as const,
                  field: { control: "select" as const },
                })),
              },
            ],
          }}
        />
      </RefBlock>
    </>
  );
}

/** The purposes of the `items` blocks: a title, its mono id and its small lines. */
const PURPOSES = [
  { title: "评测", code: "eval", lines: ["由内核声明"] },
  {
    title: "子智能体 · 快",
    code: "subagent_fast",
    lines: ["由内核声明", "部署默认：deepseek-chat"],
  },
];

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
      {/* A step whose body is a review stack, no card (spec §5.9). */}
      <RefBlock id="template-wizard-content" width={W} height={H}>
        <WizardPage header={WIZARD_HEADER} steps={WIZARD_STEPS} current={1} actionRow={WIZARD_ROW}>
          <Stack gap={16}>
            <Stack gap={4}>
              <Text>crm 1.0.0</Text>
              <Text variant="small" tone="muted">
                发布者 Acme
              </Text>
            </Stack>
            <Stack gap={8}>
              <Text>技能</Text>
              <Text tone="muted">没有技能</Text>
            </Stack>
          </Stack>
        </WizardPage>
      </RefBlock>
      <RefBlock id="template-wizard-loading-content" width={W} height={H}>
        <WizardPage
          header={{ ...WIZARD_HEADER, title: "" }}
          steps={WIZARD_STEPS}
          current={1}
          actionRow={WIZARD_ROW}
          loading={{ content: [{ kind: "lines", lines: 2 }, { kind: "list" }] }}
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
        <ListPage header={LIST_HEADER} variant="objects" listLabel="智能体">
          {AGENTS.map((name) => (
            <ObjectRow key={name} mark={{ text: name }} name={name} description="检索资料并整理" />
          ))}
        </ListPage>
      </RefBlock>
      <RefBlock id="template-list-loading-objects" width={W} height={H}>
        <ListPage header={LIST_HEADER} variant="objects" listLabel="智能体" loading />
      </RefBlock>
      {/* A list page whose content is its own sections (spec §5.1 `keep`). */}
      <RefBlock id="template-list-keep" width={W} height={H}>
        <ListPage header={LIST_HEADER}>
          <FormSection id="a" title="内置市场" description="官方市场">
            <Field label="地址">
              <Input defaultValue="https://example.com" />
            </Field>
          </FormSection>
        </ListPage>
      </RefBlock>
      <RefBlock id="template-list-loading-keep" width={W} height={H}>
        <ListPage header={LIST_HEADER} loading={{ keep: true }}>
          <FormSection id="a" title="内置市场" description="官方市场" loading={{ fields: 1 }} />
        </ListPage>
      </RefBlock>
      {/* Cards on the page ground (spec §6.34, ruling P4-15): the workspace 智能体 tab. */}
      <RefBlock id="template-list-cards" width={W} height={H}>
        <ListPage header={LIST_HEADER} variant="cards" listLabel="智能体">
          {AGENT_CARDS.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed catalog cards
            <ObjectCard key={i} {...c} />
          ))}
        </ListPage>
      </RefBlock>
      <RefBlock id="template-list-loading-cards" width={W} height={H}>
        <ListPage header={LIST_HEADER} variant="cards" listLabel="智能体" loading />
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
            <Card title="工具调用 · mcp__crm__refund_order">
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
