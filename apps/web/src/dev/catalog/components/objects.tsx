import { Callout, EmptyState, Grid, ObjectList, ObjectRow } from "@capybara-hq/design";
import { Row, Section } from "../frame";

const noop = () => {};

/** Spec §6.17–§6.19: object list and rows, empty state, callout. */
export function ObjectsSection() {
  return (
    <Section title="对象列表 ObjectList" note="一行一个对象；空状态；需要处理的提示条">
      <Row label="ObjectList · 对象行（范围芯片、说明、元信息、最近使用、操作、菜单）">
        <Grid columns={1}>
          <ObjectList label="Agent 列表">
            <ObjectRow
              mark={{ text: "研" }}
              name="研究助手"
              href="/dev/ui/components"
              chips={[{ label: "组织共享" }]}
              description="查资料、读文件、整理成报告；会先列计划再动手。"
              meta="deepseek-chat · 4 技能 · 6 工具 · 沙箱"
              trailing="刚刚"
              action={{ label: "对话", onSelect: noop }}
              menu={[{ label: "编辑", onSelect: noop }]}
            />
            <ObjectRow
              mark={{ text: "数" }}
              name="数据核对"
              chips={[{ label: "仅自己" }, { label: "回退模型不可用", tone: "warn" }]}
              description="对比两份表格，标出差异并给出原因猜测。"
              meta="deepseek-chat · 1 技能 · 沙箱"
              trailing="3 天前"
              action={{ label: "对话", onSelect: noop }}
              menu={[{ label: "编辑", onSelect: noop }]}
            />
          </ObjectList>
        </Grid>
      </Row>
      <Row label="ObjectRow · 状态标签（待配置 / 已启用）与图标标记">
        <Grid columns={1}>
          <ObjectList label="扩展列表">
            <ObjectRow
              mark={{ icon: "extension", tone: "warn" }}
              name="openai-compatible"
              mono
              description="兼容 OpenAI Chat Completions 的模型服务。"
              meta={["v0.1.0", "必需", "model-provider@2", "预装", "副本 1/1 一致"]}
              state={{ label: "待配置", tone: "warn" }}
              action={{ label: "配置", onSelect: noop }}
              menu={[{ label: "停用", onSelect: noop }]}
            />
            <ObjectRow
              mark={{ icon: "extension" }}
              name="object-store-s3"
              mono
              description="S3 兼容的对象存储。"
              state={{ label: "已启用", tone: "ok" }}
              menu={[{ label: "停用", onSelect: noop }]}
            />
          </ObjectList>
        </Grid>
      </Row>
      <Row label="Callout · 说明 / 警告 / 失败">
        <Grid columns={1}>
          <Callout tone="info">企业管理员不能查看对话内容。</Callout>
          <Callout tone="warn" action={{ label: "去配置", onSelect: noop }}>
            openai-compatible 还没有配置模型地址和密钥：所有组织都还没有可用的模型。
          </Callout>
          <Callout tone="fail" action={{ label: "查看", onSelect: noop }}>
            模型调用连续失败。
          </Callout>
        </Grid>
      </Row>
      <Row label="EmptyState">
        <Grid columns={1}>
          <EmptyState
            text="还没有 agent"
            hint="新建一个 agent，就能和它对话。"
            action={{ label: "新建 agent", icon: "plus", variant: "primary", onSelect: noop }}
          />
          <EmptyState
            size="compact"
            text="还没有会话"
            action={{ label: "新会话", variant: "default", onSelect: noop }}
          />
          <EmptyState size="compact" icon="search-x" text="没有匹配的会话" />
        </Grid>
      </Row>
    </Section>
  );
}
