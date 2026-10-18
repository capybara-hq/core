"use client";

import { useTranslations } from "next-intl";
import type { ModelRef } from "../lib/conversations";
import type { ChatItem } from "../lib/stream";

/**
 * 消息列表：用户消息、agent 回复（流式草稿带 `data-streaming`）、失败提示。
 * 思考区按产出该消息的模型的 `capabilities.reasoning` 显示：`reasoningOf` 返回 false 时不显示，
 * 返回 undefined（模型列表未取到或模型已下线）时有思考内容就显示。
 */
export function MessageList({
  items,
  reasoningOf = () => undefined,
}: {
  items: ChatItem[];
  reasoningOf?: (model: ModelRef) => boolean | undefined;
}) {
  const t = useTranslations("chat");
  if (items.length === 0) return <p className="muted">{t("empty")}</p>;
  return (
    <ol className="messages" aria-live="polite">
      {items.map((item) => {
        if (item.kind === "user") {
          return (
            <li key={item.key} className="message user" data-role="user">
              <span className="author">{t("you")}</span>
              <div className="body">{item.text}</div>
            </li>
          );
        }
        if (item.kind === "failed") {
          return (
            <li key={item.key} className="message failed" data-role="failed">
              <span className="error">{t("failed", { code: item.code })}</span>
            </li>
          );
        }
        return (
          <li
            key={item.key}
            className="message assistant"
            data-role="assistant"
            data-streaming={item.streaming ? "true" : undefined}
            data-stop-reason={item.stopReason ?? undefined}
          >
            <span className="author">{t("assistant")}</span>
            {item.thinking !== "" && (item.model === null || reasoningOf(item.model) !== false) && (
              <details className="thinking">
                <summary>{t("thinking")}</summary>
                {item.thinking}
              </details>
            )}
            <div className="body">{item.text}</div>
            {item.stopReason === "aborted" && <span className="badge">{t("stopped")}</span>}
          </li>
        );
      })}
    </ol>
  );
}
