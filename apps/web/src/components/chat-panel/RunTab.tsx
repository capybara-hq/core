"use client";

import { Stack, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { readToolOutput } from "../../lib/conversations";
import type { ChatItem } from "../../lib/stream";
import { useErrorMessage } from "../../lib/use-error-message";
import { ToolCallCard } from "../ToolCallCard";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/**
 * 运行标签：本对话的工具调用（来自日志里的 assistant_message / tool_call_started / tool_result），
 * 每条点开在面板里看完整的 IN / OUT。内核截断并存档的输出，点「查看全部输出」经存档接口
 * （`GET .../conversations/:id/outputs/:outputId`）取全文。
 */
export function RunTab({
  orgId,
  conversationId,
  tools,
}: {
  orgId: string;
  conversationId: string;
  tools: ToolItem[];
}) {
  const t = useTranslations("chatPanel");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  /** 存档 id → 取到的全文（只在本标签内缓存）。 */
  const [archived, setArchived] = useState<Record<string, { text: string; complete: boolean }>>({});
  if (tools.length === 0) return <Text tone="muted">{t("runEmpty")}</Text>;
  const showAll = (outputId: string) => {
    readToolOutput(orgId, conversationId, outputId).then(
      (r) => setArchived((a) => ({ ...a, [outputId]: r })),
      (e: unknown) => toast.error(errorMessage(e)),
    );
  };
  return (
    <Stack gap={4}>
      {tools.map((item) => {
        const id = item.outputId;
        const got = id === null ? undefined : archived[id];
        return (
          <ToolCallCard
            key={item.key}
            item={item}
            full
            {...(got !== undefined && { archived: got })}
            {...(id !== null && { onShowAll: () => showAll(id) })}
          />
        );
      })}
    </Stack>
  );
}
