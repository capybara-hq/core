"use client";

import { Card, Stack, StatusMark, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ModelRef } from "../lib/conversations";
import type { ChatItem } from "../lib/stream";

/**
 * 消息列表（PlaygroundPage 的内容区）：用户消息、agent 回复（流式草稿带 `data-streaming`）、失败提示，
 * 每条一张 Card，正文在 `[data-part="body"]`。
 * 思考区按产出该消息的模型的 `capabilities.reasoning` 显示：`reasoningOf` 返回 false 时不显示，
 * 返回 undefined（模型列表未取到或模型已下线）时有思考内容就显示；默认折叠。
 */
export function MessageList({
  items,
  reasoningOf = () => undefined,
}: {
  items: ChatItem[];
  reasoningOf?: (model: ModelRef) => boolean | undefined;
}) {
  const t = useTranslations("chat");
  if (items.length === 0) return <Text tone="muted">{t("empty")}</Text>;
  return (
    <div role="log" aria-live="polite">
      <Stack gap={12}>
        {items.map((item) => {
          if (item.kind === "user") {
            return (
              <div key={item.key} data-role="user">
                <Card title={t("you")}>
                  <div data-part="body">
                    <Text pre>{item.text}</Text>
                  </div>
                </Card>
              </div>
            );
          }
          if (item.kind === "failed") {
            return (
              <div key={item.key} data-role="failed">
                <Card tone="danger">
                  <Text tone="fail">{`✗ ${t("failed", { code: item.code })}`}</Text>
                </Card>
              </div>
            );
          }
          const showThinking =
            item.thinking !== "" && (item.model === null || reasoningOf(item.model) !== false);
          return (
            <div
              key={item.key}
              data-role="assistant"
              data-streaming={item.streaming ? "true" : undefined}
              data-stop-reason={item.stopReason ?? undefined}
            >
              <Card
                title={t("assistant")}
                actions={
                  item.stopReason === "aborted" ? (
                    <StatusMark status="cancelled" label={t("stopped")} />
                  ) : item.streaming ? (
                    <StatusMark status="running" label={t("running")} />
                  ) : undefined
                }
              >
                <Stack gap={8}>
                  {showThinking && (
                    <details>
                      <summary>
                        <Text variant="small" tone="muted">
                          {t("thinking")}
                        </Text>
                      </summary>
                      <Card>
                        <Text variant="small" tone="muted" pre>
                          {item.thinking}
                        </Text>
                      </Card>
                    </details>
                  )}
                  <div data-part="body">
                    <Text pre>{item.text}</Text>
                  </div>
                </Stack>
              </Card>
            </div>
          );
        })}
      </Stack>
    </div>
  );
}
