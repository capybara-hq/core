"use client";

import { Badge, KeyValue, Stack, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { listApps } from "../../lib/apps";
import type { ConversationEvent, ModelRef } from "../../lib/conversations";
import { useLoad } from "../../lib/use-load";

type Usage = Extract<ConversationEvent, { type: "usage" }>["payload"];

/** 最近一次用到的模型：最后的 model_call（兜底时与运行的模型不同），没有时取最后的 run_started。 */
function latestModel(events: ConversationEvent[]): ModelRef | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as ConversationEvent;
    if (e.type === "model_call") return { provider: e.payload.provider, model: e.payload.model };
    if (e.type === "run_started") return e.payload.model;
  }
  return null;
}

function latestUsage(events: ConversationEvent[]): Usage | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as ConversationEvent;
    if (e.type === "usage") return e.payload;
  }
  return null;
}

/** 应用工具的 key 是 `<应用 slug>__<工具名>`。 */
const slugOf = (toolKey: string): string | null => {
  const i = toolKey.indexOf("__");
  return i > 0 ? toolKey.slice(0, i) : null;
};

/**
 * 本对话用到的应用（按首次出现的顺序）：工具调用按 key 前缀对上应用 slug，
 * 再加上消息附件与「需要连接」里的应用名。插件工具（如 todo__write）不是应用，对不上 slug 的不列。
 */
function appsUsed(events: ConversationEvent[], nameOfSlug: Map<string, string>): string[] {
  const out: string[] = [];
  const add = (name: string | undefined) => {
    if (name !== undefined && name !== "" && !out.includes(name)) out.push(name);
  };
  for (const e of events) {
    if (e.type === "assistant_message") {
      for (const b of e.payload.content) {
        if (b.type === "tool_call") {
          const slug = slugOf(b.name);
          if (slug !== null) add(nameOfSlug.get(slug));
        }
      }
    } else if (e.type === "user_message") {
      for (const a of e.payload.attachments ?? []) add(a.appName);
    } else if (e.type === "connection_required") {
      add(e.payload.appName);
    }
  }
  return out;
}

/**
 * 上下文标签：最近一次 `usage` 的 token 数对模型的上下文窗口（模型没有声明窗口时只显示 token 数）、
 * agent / 模型 / 会话、本对话用到的应用、压缩记录（`compaction_summary`）。
 */
export function ContextTab({
  orgId,
  conversationId,
  agentName,
  events,
  contextWindowOf,
}: {
  orgId: string;
  conversationId: string;
  agentName: string | undefined;
  events: ConversationEvent[];
  contextWindowOf(m: ModelRef): number | undefined;
}) {
  const t = useTranslations("chatPanel");
  const locale = useLocale();
  const apps = useLoad(() => listApps(orgId), [orgId]);
  const nameOfSlug = useMemo(
    () =>
      new Map(apps.state.kind === "ready" ? apps.state.data.apps.map((a) => [a.slug, a.name]) : []),
    [apps.state],
  );
  const fmt = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US");
  const model = latestModel(events);
  const usage = latestUsage(events);
  let tokens: string;
  let windowUnknown = false;
  if (usage === null) tokens = t("noUsage");
  else {
    const used =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
    const total = contextWindowOf({ provider: usage.provider, model: usage.model });
    if (total === undefined || total <= 0) {
      tokens = t("tokensOnly", { used: fmt.format(used) });
      windowUnknown = true;
    } else {
      tokens = t("tokensOf", {
        used: fmt.format(used),
        total: fmt.format(total),
        pct: String(Math.round((used / total) * 100)),
      });
    }
  }
  const used = appsUsed(events, nameOfSlug);
  const compactions = events.filter(
    (e): e is Extract<ConversationEvent, { type: "compaction_summary" }> =>
      e.type === "compaction_summary",
  );

  return (
    <Stack gap={16}>
      <Stack gap={4}>
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: t("agent"), v: agentName ?? "—" },
            { k: t("model"), v: model === null ? "—" : `${model.provider}/${model.model}` },
            { k: t("conversation"), v: conversationId },
            { k: t("tokens"), v: tokens },
          ]}
        />
        {windowUnknown && (
          <Text variant="small" tone="faint">
            {t("windowUnknown")}
          </Text>
        )}
      </Stack>
      <Stack gap={8}>
        <Text variant="small" tone="muted">
          {t("apps")}
        </Text>
        {used.length === 0 ? (
          <Text variant="small" tone="faint">
            {t("none")}
          </Text>
        ) : (
          <Stack direction="row" gap={8} wrap>
            {used.map((name) => (
              <Badge key={name}>{name}</Badge>
            ))}
          </Stack>
        )}
      </Stack>
      <Stack gap={8}>
        <Text variant="small" tone="muted">
          {t("compactions")}
        </Text>
        {compactions.length === 0 ? (
          <Text variant="small" tone="faint">
            {t("none")}
          </Text>
        ) : (
          compactions.map((c) => (
            <details key={c.seq}>
              <summary>
                <Text variant="small">
                  {t("compactionCovers", { seq: c.payload.coversUpToSeq })}
                </Text>
              </summary>
              <Text variant="small" tone="muted" pre>
                {c.payload.text}
              </Text>
            </details>
          ))
        )}
      </Stack>
    </Stack>
  );
}
