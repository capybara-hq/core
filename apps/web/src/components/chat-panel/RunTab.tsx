"use client";

import { Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ChatItem } from "../../lib/stream";
import { ToolCallCard } from "../ToolCallCard";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/**
 * 运行标签：本对话的工具调用（来自日志里的 assistant_message / tool_call_started / tool_result），
 * 每条点开在面板里看完整的 IN / OUT。内核截断并存档的输出只显示存档 id：内核目前没有给网页读存档全文的接口
 * （存档只能由本会话的 agent 经 read_tool_output 读取）。
 */
export function RunTab({ tools }: { tools: ToolItem[] }) {
  const t = useTranslations("chatPanel");
  if (tools.length === 0) return <Text tone="muted">{t("runEmpty")}</Text>;
  return (
    <Stack gap={4}>
      {tools.map((item) => (
        <ToolCallCard key={item.key} item={item} full />
      ))}
    </Stack>
  );
}
