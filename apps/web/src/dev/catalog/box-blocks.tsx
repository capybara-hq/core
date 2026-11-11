import {
  Badge,
  Button,
  Callout,
  Card,
  CheckList,
  type CheckListRow,
  CodeBlock,
  type Column,
  DataTable,
  Field,
  FormSection,
  Icon,
  ImpactPreview,
  Input,
  ItemList,
  ItemListItem,
  KeyValue,
  Select,
  Stack,
  Subsection,
  Text,
  ToolPolicyList,
  type ToolPolicyRow,
} from "@capybara-hq/design";
import { type ReactNode, useState } from "react";
import { RefBlock } from "./ref-block";

// "One box is enough" (spec §1 principle 7, acceptance item AB): the groupings inside a box. The
// blocks have the same ids (and boxes) as docs/design/reference/src/item-list.html and
// subsection.html (and callout.html: the Callout's line form inside a box).

const noop = () => {};
const MODELS = [
  { value: "", label: "未设置" },
  { value: "deepseek/deepseek-chat", label: "DeepSeek / deepseek-chat" },
];

/** A purpose row as `/admin/models` 用途默认映射 draws it (the model purposes, P1). */
function PurposeRow({ title, code, lines }: { title: string; code: string; lines: string[] }) {
  return (
    <ItemListItem
      title={title}
      code={code}
      meta={lines.map((l) => (
        <Text key={l} variant="small" tone="muted">
          {l}
        </Text>
      ))}
    >
      <Field label="模型">
        <Select value="deepseek/deepseek-chat" onChange={noop} options={MODELS} />
      </Field>
    </ItemListItem>
  );
}

function itemListBlocks(): ReactNode {
  return (
    <>
      {/* Plain rows inside a Card: an agent's channels. */}
      <RefBlock id="item-list-rows" width={560} pad>
        <Card title="渠道">
          <ItemList
            label="渠道"
            rows={[
              {
                id: "lark",
                tag: { label: "飞书" },
                title: "财务助手群",
                meta: "研究助手 · 2 个会话",
                actions: <Button density="dense">解绑</Button>,
              },
              {
                id: "slack",
                tag: { label: "Slack" },
                title: "#finance",
                meta: "研究助手",
                status: { label: "已停用" },
              },
            ]}
          />
        </Card>
      </RefBlock>
      {/* Item rows with fields in a flush form card: the model purposes. */}
      <RefBlock id="item-list-fields" width={960} pad>
        <FormSection id="purposes" title="用途默认映射" description="各组织可在设置里覆盖。" flush>
          <ItemList label="用途" inset="flush">
            <PurposeRow title="评测" code="eval" lines={["由内核声明"]} />
            <PurposeRow title="标题" code="title" lines={["由内核声明"]} />
            <PurposeRow
              title="子智能体 · 快"
              code="subagent_fast"
              lines={["由内核声明", "子智能体选「快」时用这个模型。"]}
            />
          </ItemList>
        </FormSection>
      </RefBlock>
      {/* A permission review inside a box: rows, a warn line, the code borderless. */}
      <RefBlock id="item-list-review" width={720} pad>
        <Card title="crm 1.2.0">
          <ItemList label="crm 的权限">
            <ItemListItem
              title="数据库表"
              marks={<Badge tone="warn">敏感</Badge>}
              meta={<Text variant="small">可以删除自己的表。</Text>}
            >
              <Text variant="small" tone="muted">
                · crm_contacts
              </Text>
            </ItemListItem>
            <ItemListItem
              title="迁移里的危险语句"
              marks={<Badge tone="warn">敏感</Badge>}
              meta={
                <Text variant="small" tone="warn" icon="circle-alert">
                  删除表 · migrations/0002_drop.sql 第 3 行
                </Text>
              }
            >
              <CodeBlock language="sql" text="DROP TABLE IF EXISTS crm_legacy;" />
            </ItemListItem>
          </ItemList>
        </Card>
      </RefBlock>
    </>
  );
}

type ModelRow = { id: string; context: string };
const TABLE_COLUMNS: Column<ModelRow>[] = [
  { key: "id", header: "模型", cell: (r) => r.id },
  { key: "context", header: "上下文", cell: (r) => r.context, align: "right" },
];

function subsectionBlocks(): ReactNode {
  return (
    <>
      {/* A nested config object inside a Card: an h3, its help, its fields under the guide. */}
      <RefBlock id="subsection-guide" width={720} pad>
        <Card title="凭据">
          <Field label="App ID">
            <Input defaultValue="cli_a1b2c3" />
          </Field>
          <Subsection title="事件订阅" description="长连接收不到时才需要配置。">
            <Field label="Verification Token">
              <Input defaultValue="" placeholder="可选" />
            </Field>
            <Field label="Encrypt Key">
              <Input defaultValue="" placeholder="可选" />
            </Field>
          </Subsection>
        </Card>
      </RefBlock>
      {/* Several tables in one flush form card: a heading row per provider over its table. */}
      <RefBlock id="subsection-flush" width={960} pad>
        <FormSection id="providers" title="供应商与模型" description="每百万 token 的价格。" flush>
          <Subsection title="deepseek" count={2} variant="flush">
            <DataTable<ModelRow>
              label="deepseek"
              columns={TABLE_COLUMNS}
              rows={[
                { id: "deepseek-chat", context: "128K" },
                { id: "deepseek-reasoner", context: "128K" },
              ]}
              rowKey={(r) => r.id}
            />
          </Subsection>
          <Subsection title="qwen" count={1} variant="flush">
            <DataTable<ModelRow>
              label="qwen"
              columns={TABLE_COLUMNS}
              rows={[{ id: "qwen-plus", context: "128K" }]}
              rowKey={(r) => r.id}
            />
          </Subsection>
        </FormSection>
      </RefBlock>
      {/* The regions of a Sheet's body (an extension's Sheet): divided subsections, an h3 over
          its content with no guide, each after the first under a line-soft hairline. */}
      <RefBlock id="subsection-divided" width={720} pad>
        <Card title="OpenAI 兼容模型">
          <Subsection title="部署配置" variant="divided">
            <Field label="端点">
              <Input defaultValue="" placeholder="https://" />
            </Field>
          </Subsection>
          <Subsection title="状态" variant="divided">
            <KeyValue
              rows={[
                { k: "状态", v: "待配置" },
                { k: "来源", v: "预装" },
              ]}
            />
          </Subsection>
          <Subsection title="权限" variant="divided">
            <Text variant="small" tone="muted">
              提供 model-provider@1
            </Text>
          </Subsection>
        </Card>
      </RefBlock>
    </>
  );
}

function calloutBlocks(): ReactNode {
  return (
    <>
      {/* On the page ground: the tinted bar, its icon, the sentence and one dense button. */}
      <RefBlock id="callout-warn" width={720} pad>
        <Callout tone="warn" action={{ label: "去配置", onSelect: noop }}>
          扩展 demo 还缺配置：endpoints。
        </Callout>
      </RefBlock>
      <RefBlock id="callout-info" width={720} pad>
        <Callout tone="info">超级管理员不能查看会话内容。</Callout>
      </RefBlock>
      {/* Inside a box it draws the warn line with its icon by itself, its action kept. */}
      <RefBlock id="callout-in-box" width={720} pad>
        <Card title="配置">
          <Callout tone="warn" action={{ label: "去配置", onSelect: noop }}>
            扩展 demo 还缺配置：endpoints。
          </Callout>
          <Field label="endpoints">
            <Input defaultValue="" placeholder="https://" />
          </Field>
        </Card>
      </RefBlock>
    </>
  );
}

/** What a change would do (spec §6.35): divided groups of rows, a warn note under its row. */
function impactPreviewBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="impact-preview-default" width={640} pad>
        <Card title="关闭 crm">
          <ImpactPreview
            empty="没有影响"
            groups={[
              {
                id: "agents",
                title: "受影响的智能体",
                items: [
                  { id: "a1", title: "研究助手", notes: [{ text: "技能 crm-notes、连接器 crm" }] },
                ],
              },
              {
                id: "removed",
                title: "将移除",
                items: [
                  { id: "s", title: "crm-notes", code: "技能" },
                  {
                    id: "c",
                    title: "crm",
                    code: "连接器",
                    notes: [{ text: "凭据会清空", tone: "warn" }],
                  },
                ],
              },
              { id: "kept", title: "保留", items: [], empty: "没有保留的组件" },
            ]}
          />
        </Card>
      </RefBlock>
      <RefBlock id="impact-preview-empty" width={640} pad>
        <Card title="设置范围">
          <ImpactPreview empty="没有组织受影响" groups={[{ id: "orgs", title: "受影响的组织" }]} />
        </Card>
      </RefBlock>
    </>
  );
}

const POLICIES = [
  { value: "", label: "默认" },
  { value: "ask", label: "需审批" },
  { value: "deny", label: "禁止" },
];

/** A ToolPolicyList that keeps its own state (the catalog is clickable). */
function LiveToolPolicyList({
  label,
  rows: initial,
  search,
  selectAll,
}: {
  label: string;
  rows: ToolPolicyRow[];
  search?: boolean;
  selectAll?: boolean;
}) {
  const [rows, setRows] = useState(initial);
  const check = (ids: string[], next: boolean) =>
    setRows((cur) =>
      cur.map((r) =>
        ids.includes(r.id) ? { ...r, checked: next, policy: next ? r.policy : "" } : r,
      ),
    );
  return (
    <ToolPolicyList
      label={label}
      rows={rows}
      policyOptions={POLICIES}
      onCheck={(id, next) => check([id], next)}
      onPolicy={(id, v) =>
        setRows((cur) => cur.map((r) => (r.id === id ? { ...r, policy: v } : r)))
      }
      {...(selectAll ? { onCheckAll: check } : {})}
      {...(search ? { search } : {})}
    />
  );
}

const CONNECTOR_POLICIES = [
  { value: "allow", label: "允许" },
  { value: "ask", label: "询问" },
  { value: "deny", label: "禁止" },
];

/** A connector's 工具 tab: the switch after the select (control: switch), clickable. */
function LiveSwitchPolicyList({ rows: initial }: { rows: ToolPolicyRow[] }) {
  const [rows, setRows] = useState(initial);
  return (
    <ToolPolicyList
      label="工具"
      control="switch"
      rows={rows}
      policyOptions={CONNECTOR_POLICIES}
      onCheck={(id, next) =>
        setRows((cur) => cur.map((r) => (r.id === id ? { ...r, checked: next } : r)))
      }
      onPolicy={(id, v) =>
        setRows((cur) => cur.map((r) => (r.id === id ? { ...r, policy: v } : r)))
      }
    />
  );
}

/** Tools with their policy next to them (spec §6.36), as the agent page's 工具 section draws them. */
function toolPolicyListBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="tool-policy-list-default" width={640} pad>
        <Card title="内置工具">
          <LiveToolPolicyList
            label="内置工具"
            rows={[
              { id: "ask", label: "向用户提问", checked: true, policy: "" },
              { id: "read", label: "读取存档的工具结果", checked: true, policy: "ask" },
              { id: "skill", label: "编写技能", checked: false, policy: "" },
              {
                id: "web",
                label: "搜索网页",
                checked: true,
                policy: "deny",
                note: { text: "不可用：本组织没有可用的网页提供方", tone: "warn" },
              },
            ]}
          />
        </Card>
      </RefBlock>
      <RefBlock id="tool-policy-list-select-all" width={480} pad>
        <Card title="Docs">
          <LiveToolPolicyList
            label="Docs 的工具"
            search
            selectAll
            rows={[
              { id: "search", label: "Search documents", checked: true, policy: "" },
              { id: "create", label: "Create document", checked: true, policy: "ask" },
              { id: "delete", label: "Delete document", checked: false, policy: "" },
              { id: "list", label: "List folders", checked: false, policy: "" },
            ]}
          />
        </Card>
      </RefBlock>
      <RefBlock id="tool-policy-list-switch" width={640} pad>
        <Card title="工具">
          <LiveSwitchPolicyList
            rows={[
              { id: "send", label: "Send message", checked: true, policy: "ask" },
              { id: "schedule", label: "slack_schedule_message", checked: true, policy: "ask" },
              {
                id: "canvas",
                label: "slack_create_canvas",
                checked: false,
                checkLocked: true,
                policy: "ask",
                note: { text: "待复核", tone: "warn", action: { label: "去复核", onClick: noop } },
              },
            ]}
          />
        </Card>
      </RefBlock>
      <RefBlock id="tool-policy-list-read-only" width={640} pad>
        <Card title="工具">
          <ToolPolicyList
            label="工具"
            readOnly
            control="switch"
            policyOptions={CONNECTOR_POLICIES}
            onCheck={noop}
            onPolicy={noop}
            rows={[
              { id: "read", label: "Read channel", checked: true, policy: "allow" },
              { id: "search", label: "Search messages", checked: true, policy: "allow" },
              {
                id: "canvas",
                label: "slack_read_canvas",
                checked: false,
                policy: "allow",
                note: { text: "已停用" },
              },
            ]}
          />
        </Card>
      </RefBlock>
    </>
  );
}

/** A CheckList the catalog can tick (spec §6.39). */
function LiveCheckList({ title, rows: initial }: { title?: string; rows: CheckListRow[] }) {
  const [rows, setRows] = useState(initial);
  const check = (ids: string[], next: boolean) =>
    setRows((cur) => cur.map((r) => (ids.includes(r.id) ? { ...r, checked: next } : r)));
  return (
    <CheckList
      label={title ?? "组织技能"}
      rows={rows}
      onCheck={(id, next) => check([id], next)}
      {...(title !== undefined ? { title, onCheckAll: check } : {})}
    />
  );
}

const GUIDE: CheckListRow = {
  id: "guide",
  title: "skill-guide",
  marks: (
    <>
      <Badge>平台</Badge>
      <Badge>内置</Badge>
    </>
  ),
  description: "How to find, read and use skills; loaded by the model when needed.",
  checked: true,
  locked: true,
};

/** Skills to choose, the agent page's 组织技能 (spec §6.39). */
function checkListBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="check-list-default" width={640} pad>
        <Card title="组织技能">
          <LiveCheckList
            rows={[
              {
                id: "brainstorming",
                title: "brainstorming",
                marks: <Badge>平台</Badge>,
                description:
                  "You MUST use this before any creative work - creating features, building components, adding functionality, modifying behavior.",
                checked: true,
              },
              {
                id: "using",
                title: "using-superpowers",
                marks: <Badge>平台</Badge>,
                description:
                  "Use when starting any conversation - establishes how to find and use skills, requiring Skill tool invocation before ANY response including clarifying questions",
                checked: false,
              },
              {
                id: "csv",
                title: "csv-report",
                description: "Turn a CSV file into a short report with charts.",
                checked: true,
              },
              GUIDE,
            ]}
          />
        </Card>
      </RefBlock>
      <RefBlock id="check-list-group" width={640} pad>
        <Card title="组织技能">
          <Stack gap={12}>
            <Input
              type="search"
              density="dense"
              prefix={<Icon name="search" size={14} />}
              placeholder="搜索技能"
              aria-label="搜索技能"
            />
            <LiveCheckList
              title="superpowers"
              rows={[
                {
                  id: "debug",
                  title: "systematic-debugging",
                  marks: <Badge>平台</Badge>,
                  description:
                    "Use when encountering any bug, test failure, or unexpected behavior.",
                  checked: true,
                },
                {
                  id: "tdd",
                  title: "test-driven-development",
                  marks: <Badge>平台</Badge>,
                  description:
                    "Use when implementing any feature or bugfix, before writing implementation code.",
                  checked: true,
                },
                {
                  id: "plans",
                  title: "writing-plans",
                  marks: <Badge>平台</Badge>,
                  description: "Use when you have a spec or requirements for a multi-step task.",
                  checked: false,
                },
              ]}
            />
            <Stack gap={4}>
              <LiveCheckList title="内置" rows={[GUIDE]} />
              <Text variant="small" tone="faint">
                内置技能对每个智能体都开启，不能关闭：模型按需加载。
              </Text>
            </Stack>
          </Stack>
        </Card>
      </RefBlock>
    </>
  );
}

export const BOX_BLOCKS = {
  callout: calloutBlocks,
  "check-list": checkListBlocks,
  "impact-preview": impactPreviewBlocks,
  "item-list": itemListBlocks,
  subsection: subsectionBlocks,
  "tool-policy-list": toolPolicyListBlocks,
} as const;
