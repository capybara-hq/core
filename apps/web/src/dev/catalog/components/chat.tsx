import {
  AttachmentChip,
  AttachmentPreview,
  Card,
  Checklist,
  CodeBlock,
  EmbedFrame,
  FileButton,
  FileDrop,
  Grid,
  ImageBlock,
  IoBlock,
  Stack,
  Tabs,
  Text,
  Textarea,
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

/**
 * 示例图片地址：ImageBlock 只渲染 http(s)。example.com 返回的不是图片，目录页里固定显示为加载失败的图片（alt），
 * 截图稳定、不依赖外网内容。
 */
const SAMPLE_IMAGE = "https://example.com/capybara-chart.png";

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
          图片 ImageBlock · 只渲染 http(s)，宽度不超出容器
        </Text>
        <ImageBlock src={SAMPLE_IMAGE} alt="示例图片" />
      </Grid>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          上传条目 AttachmentChip · 上传中 / 就绪 / 出错 / 无移除按钮
        </Text>
        <Stack direction="row" gap={8} wrap>
          <AttachmentChip
            name="weekly-chart.png"
            size={348_160}
            status="uploading"
            progress={0.6}
            onRemove={noop}
          />
          <AttachmentChip name="report.pdf" size={1_258_291} status="ready" onRemove={noop} />
          <AttachmentChip
            name="archive.zip"
            size={2048}
            status="error"
            error="不支持这种文件类型。"
            onRemove={noop}
          />
          <AttachmentChip
            name="a-very-long-file-name-for-truncation.csv"
            size={512}
            status="ready"
          />
        </Stack>
      </Grid>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          拖放区域 FileDrop · 拖入时的覆盖层；选文件 FileButton
        </Text>
        <FileDrop label="松开以添加文件" onFiles={noop} dragging>
          <Stack direction="row" gap={8} align="end">
            <FileButton label="添加文件" onFiles={noop} />
            <Textarea aria-label="消息" rows={3} placeholder="输入消息" />
          </Stack>
        </FileDrop>
      </Grid>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          消息附件 AttachmentPreview · 图片缩略图 / 文件卡片 / 不安全地址只显示名称
        </Text>
        <Stack direction="row" gap={8} wrap>
          <AttachmentPreview kind="image" name="示例图片.png" href={SAMPLE_IMAGE} />
          <AttachmentPreview kind="file" name="report.pdf" meta="PDF" href="/dev/ui/components" />
          <AttachmentPreview
            kind="file"
            name="notes.md"
            meta="Markdown"
            href="//evil.example.com/notes.md"
          />
        </Stack>
      </Grid>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          待人处理的卡片 Card tone=accent（审批 / 提问 / 连接）
        </Text>
        <Card tone="accent" title="需要审批">
          <Text variant="small" tone="muted">
            fixture__delete_item · 删除条目 x1
          </Text>
        </Card>
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
