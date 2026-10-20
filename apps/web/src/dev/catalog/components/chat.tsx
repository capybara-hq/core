import {
  Checklist,
  CodeBlock,
  EmbedFrame,
  Grid,
  IoBlock,
  Tabs,
  Text,
  ThinkingRow,
  Timeline,
  TimelineItem,
  ToolCallRow,
} from "@capybara-hq/design";
import { useState } from "react";
import { Row, Section } from "../frame";

const noop = () => {};

const SEARCH_INPUT = JSON.stringify(
  { channel: "#feedback", since: "2026-10-14", limit: 50 },
  null,
  2,
);
const SEARCH_OUTPUT = Array.from(
  { length: 18 },
  (_, i) => `${String(i + 1).padStart(2, "0")}  @user${i + 1}  导出 CSV 时中文列名乱码`,
).join("\n");

const TASKS = [
  { text: "读取本周 #feedback 消息", status: "completed" as const },
  { text: "按主题聚类", status: "in_progress" as const },
  { text: "写周报草稿", status: "pending" as const },
  { text: "发到 #product", status: "pending" as const },
];

const PANEL_TABS = [
  { id: "run", label: "运行", alert: true },
  { id: "tasks", label: "任务", badge: "1/4" },
  { id: "context", label: "上下文" },
  { id: "board", label: "看板", badge: "12" },
];

/** spec §6.9：对话时间线、思考行、工具调用行、IN / OUT、清单、代码块、嵌入页、面板标签。 */
export function ChatSection() {
  const [tab, setTab] = useState("tasks");
  return (
    <Section title="对话时间线 Timeline / 插件视图积木" note="对话流与 Inspector 标签共用">
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          时间线 · 思考 / 完成 / 运行中 / 出错 / 已取消（默认折叠一行）
        </Text>
        <Timeline label="本轮步骤">
          <TimelineItem mark="hollow">
            <ThinkingRow seconds={4} text="先拉本周 #feedback 的消息，再按主题聚类。" />
          </TimelineItem>
          <TimelineItem mark="dot">
            <ToolCallRow
              name="slack__search"
              summary="搜索 #feedback 本周消息 · 42 条"
              status="done"
              input={SEARCH_INPUT}
              output={SEARCH_OUTPUT}
            />
          </TimelineItem>
          <TimelineItem mark="running">
            <ToolCallRow
              name="todo__write"
              summary="更新任务清单（4 项）"
              status="running"
              input='{"items":4}'
            />
          </TimelineItem>
          <TimelineItem mark="error">
            <ToolCallRow
              name="lark__send"
              summary="发送到 #product"
              status="error"
              input='{"chat":"#product"}'
              output="ChannelSendError: rate limited (retryable)"
            />
          </TimelineItem>
          <TimelineItem mark="dot">
            <ToolCallRow name="crm__lookup" status="cancelled" input='{"id":"C-1042"}' />
          </TimelineItem>
          <TimelineItem mark="hollow">
            <ThinkingRow seconds={1} />
          </TimelineItem>
        </Timeline>
      </Grid>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          工具调用 · 展开（IN / OUT，长输出折叠 12 行）
        </Text>
        <ToolCallRow
          name="slack__search"
          summary="搜索 #feedback 本周消息 · 42 条"
          status="done"
          input={SEARCH_INPUT}
          output={SEARCH_OUTPUT}
          defaultExpanded
        />
      </Grid>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          工具调用 · 展开 · 出错 / 输出已截断
        </Text>
        <Grid columns={1} gap={8}>
          <ToolCallRow
            name="lark__send"
            summary="发送到 #product"
            status="error"
            input='{"chat":"#product"}'
            output="ChannelSendError: rate limited (retryable)"
            defaultExpanded
          />
          <ToolCallRow
            name="http__get"
            summary="GET /reports/weekly"
            status="done"
            input='{"url":"https://example.com/reports/weekly"}'
            output="(前 4 KB) …"
            outputTruncated
            onShowAll={noop}
            defaultExpanded
          />
        </Grid>
      </Grid>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          IN / OUT 块 · 短 / 自定义折叠行数
        </Text>
        <Grid columns={1} gap={8}>
          <IoBlock label="IN" text='{"q":"feedback"}' />
          <IoBlock label="OUT" text={SEARCH_OUTPUT} collapsedLines={3} />
        </Grid>
      </Grid>
      <Row label="Inspector 标签 · 徽标 / 提醒">
        <Tabs label="右侧面板" items={PANEL_TABS} value={tab} onChange={setTab} />
      </Row>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          清单 Checklist · 已完成 / 进行中 / 待办
        </Text>
        <Checklist label="任务" items={TASKS} />
      </Grid>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          代码块 CodeBlock · 有 / 无语言
        </Text>
        <Grid columns={1} gap={8}>
          <CodeBlock
            language="sql"
            text={"SELECT topic, count(*)\n  FROM feedback\n GROUP BY topic;"}
          />
          <CodeBlock text="capybara plugins review todo" />
        </Grid>
      </Grid>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          嵌入页 EmbedFrame · sandbox=allow-scripts allow-forms · 高 120
        </Text>
        <EmbedFrame src="about:blank" title="示例嵌入页" height={120} onMessage={noop} />
      </Grid>
    </Section>
  );
}
