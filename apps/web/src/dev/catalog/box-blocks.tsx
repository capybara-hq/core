import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  type Column,
  DataTable,
  Field,
  FormSection,
  Input,
  ItemList,
  ItemListItem,
  KeyValue,
  Select,
  Subsection,
  Text,
} from "@capybara-hq/design";
import type { ReactNode } from "react";
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

export const BOX_BLOCKS = {
  callout: calloutBlocks,
  "item-list": itemListBlocks,
  subsection: subsectionBlocks,
} as const;
