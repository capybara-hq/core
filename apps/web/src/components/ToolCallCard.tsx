"use client";

import { Card, Stack, StatusMark, Text, Textarea } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { formatInput } from "../lib/approvals";
import type { ChatItem, ToolStatus } from "../lib/stream";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** 卡片内展示的结果上限（内核已把超大结果转存并截为预览，这里再兜一次底）。 */
export const RESULT_PREVIEW_CHARS = 4000;

type Status = ComponentProps<typeof StatusMark>["status"];

const STATUS: Record<ToolStatus, Status> = {
  pending: "waiting",
  running: "running",
  done: "success",
  error: "failed",
  cancelled: "cancelled",
};

/** 行数（代码样式 Textarea 的高度）：至少 2 行，至多 12 行。 */
const rowsOf = (text: string) => Math.min(12, Math.max(2, text.split("\n").length));

/**
 * 工具调用卡片：标题为工具名，右侧为状态；默认折叠，展开显示参数（JSON）与结果（只读代码样式）。
 * 结果超长时只显示预览，并给出完整结果的存档 id（模型可用 read_tool_output 读取）。
 */
export function ToolCallCard({ item }: { item: ToolItem }) {
  const t = useTranslations("tools");
  const input = formatInput(item.input);
  const result = item.result ?? "";
  const truncated = result.length > RESULT_PREVIEW_CHARS;
  const shown = truncated ? result.slice(0, RESULT_PREVIEW_CHARS) : result;
  return (
    <div data-role="tool" data-call-id={item.callId} data-status={item.status}>
      <Card
        title={`${t("call")} · ${item.name}`}
        actions={<StatusMark status={STATUS[item.status]} label={t(`status.${item.status}`)} />}
      >
        <details>
          <summary>
            <Text variant="small" tone="muted">
              {t("details")}
            </Text>
          </summary>
          <Stack gap={8}>
            <Text variant="small" tone="muted">
              {t("input")}
            </Text>
            <Textarea code readOnly aria-label={t("input")} rows={rowsOf(input)} value={input} />
            <Text variant="small" tone="muted">
              {t("result")}
            </Text>
            {item.result === null ? (
              <Text variant="small" tone="faint">
                {t("noResult")}
              </Text>
            ) : (
              <div data-part="result">
                <Textarea
                  code
                  readOnly
                  aria-label={t("result")}
                  rows={rowsOf(shown)}
                  value={shown}
                />
              </div>
            )}
            {truncated && (
              <Text variant="small" tone="muted">
                {t("truncated", { n: RESULT_PREVIEW_CHARS })}
              </Text>
            )}
            {item.outputId !== null && (
              <Text variant="small" tone="muted">
                {t("outputId", { id: item.outputId })}
              </Text>
            )}
          </Stack>
        </details>
      </Card>
    </div>
  );
}
