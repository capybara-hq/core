"use client";

import {
  Badge,
  Card,
  Stack,
  StatusMark,
  Text,
  ThinkingRow,
  Timeline,
  TimelineItem,
  type TimelineMark,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { attachmentDownloadUrl, attachmentTypeLabel } from "../lib/attachments";
import type { ModelRef } from "../lib/conversations";
import type { ChatItem, MessageFile } from "../lib/stream";
import { ApprovalCard } from "./ApprovalCard";
import { ConnectCard } from "./ConnectCard";
import { QuestionCard } from "./QuestionCard";
import { SessionFilePreview } from "./SessionFilePreview";
import { ToolCallCard } from "./ToolCallCard";

type UserItem = Extract<ChatItem, { kind: "user" }>;
type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** 用户消息之间的一轮：思考、回复、工具调用、审批 / 提问 / 连接卡片按顺序串成一条时间线。 */
type Group = { kind: "user"; item: UserItem } | { kind: "turn"; key: string; items: ChatItem[] };

function groupItems(items: ChatItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      groups.push({ kind: "user", item });
      continue;
    }
    const last = groups.at(-1);
    if (last?.kind === "turn") last.items.push(item);
    else groups.push({ kind: "turn", key: `t:${item.key}`, items: [item] });
  }
  return groups;
}

/** 等待中（如等审批，尚未开始执行）用空心标记：主色的 running 只给真正在执行的调用。 */
const TOOL_MARK: Record<ToolItem["status"], TimelineMark> = {
  pending: "hollow",
  running: "running",
  done: "dot",
  error: "error",
  cancelled: "hollow",
};

/** 消息里的一个上传文件（同源下载地址；登录过期时的重试见 SessionFilePreview）。 */
function MessageFilePreview({ orgId, file }: { orgId: string; file: MessageFile }) {
  return (
    <SessionFilePreview
      kind={file.kind === "image" ? "image" : "file"}
      name={file.name}
      href={attachmentDownloadUrl(orgId, file.attachmentId)}
      meta={attachmentTypeLabel(file.mediaType)}
    />
  );
}

function UserMessage({ orgId, item }: { orgId: string; item: UserItem }) {
  const t = useTranslations("chat");
  return (
    <div data-role="user">
      <Card title={t("you")}>
        <Stack gap={8}>
          <div data-part="body">
            <Text pre>{item.text}</Text>
          </div>
          {item.attachments.length > 0 && (
            // biome-ignore lint/a11y/useSemanticElements: 附件条目分组；apps/web 不能写样式，用 role=group
            <div role="group" aria-label={t("attachments")}>
              <Stack direction="row" gap={8} wrap>
                {item.attachments.map((a) => (
                  <Badge key={`${a.appId}:${a.uri}`}>{`@${a.name} · ${a.appName}`}</Badge>
                ))}
              </Stack>
            </div>
          )}
          {item.files.length > 0 && (
            // biome-ignore lint/a11y/useSemanticElements: 文件分组；apps/web 不能写样式，用 role=group
            <div role="group" aria-label={t("files")}>
              <Stack direction="row" gap={8} wrap>
                {item.files.map((f) => (
                  <MessageFilePreview key={f.attachmentId} orgId={orgId} file={f} />
                ))}
              </Stack>
            </div>
          )}
        </Stack>
      </Card>
    </div>
  );
}

/**
 * 消息列表（PlaygroundPage 的内容区）：用户消息是卡片；其后的一轮用 `Timeline` 串起各步——
 * 思考（「思考了 N 秒」，可展开）、回复（流式草稿带 `data-streaming`）、工具调用行（默认折叠，展开看 IN / OUT）、
 * 审批 / 输入请求 / 需要连接卡片（`data-role` 为 approval / question / connect，待处理时强调色描边）与失败提示。
 * 回复正文在 `[data-part="body"]`。思考按产出该消息的模型的 `capabilities.reasoning` 显示：`reasoningOf`
 * 返回 false 时不显示，返回 undefined（模型列表未取到或模型已下线）时有思考内容就显示。
 */
export function MessageList({
  orgId,
  items,
  reasoningOf = () => undefined,
}: {
  orgId: string;
  items: ChatItem[];
  reasoningOf?: (model: ModelRef) => boolean | undefined;
}) {
  const t = useTranslations("chat");
  const te = useTranslations("errors");
  if (items.length === 0) return <Text tone="muted">{t("empty")}</Text>;

  const assistant = (item: AssistantItem): ReactNode[] => {
    const showThinking =
      item.thinking !== "" && (item.model === null || reasoningOf(item.model) !== false);
    const out: ReactNode[] = [];
    if (showThinking) {
      out.push(
        <TimelineItem key={`${item.key}:thinking`} mark="hollow">
          <ThinkingRow
            seconds={item.thinkingSeconds ?? 0}
            text={item.thinking}
            {...(item.thinkingSeconds === null && {
              // 流式中：「思考中…」；已落定但缺少 model_call（算不出秒数）：「思考过程」
              labels: { title: item.streaming ? t("thinkingLive") : t("thinking") },
            })}
          />
        </TimelineItem>,
      );
    }
    const aborted = item.stopReason === "aborted";
    if (item.text !== "" || item.streaming || aborted || !showThinking) {
      out.push(
        <TimelineItem key={item.key} mark={item.streaming ? "running" : "dot"}>
          <div
            data-role="assistant"
            data-streaming={item.streaming ? "true" : undefined}
            data-stop-reason={item.stopReason ?? undefined}
          >
            <Stack gap={4}>
              <div data-part="body">
                <Text pre>{item.text}</Text>
              </div>
              {aborted ? (
                <StatusMark status="cancelled" label={t("stopped")} />
              ) : item.streaming ? (
                <StatusMark status="running" label={t("running")} />
              ) : null}
            </Stack>
          </div>
        </TimelineItem>,
      );
    }
    return out;
  };

  const step = (item: ChatItem): ReactNode[] => {
    switch (item.kind) {
      case "assistant":
        return assistant(item);
      case "tool":
        return [
          <TimelineItem key={item.key} mark={TOOL_MARK[item.status]}>
            <ToolCallCard item={item} />
          </TimelineItem>,
        ];
      case "approval":
        return [
          <TimelineItem key={item.key} mark="dot">
            <ApprovalCard orgId={orgId} item={item} />
          </TimelineItem>,
        ];
      case "question":
        return [
          <TimelineItem key={item.key} mark="dot">
            <QuestionCard orgId={orgId} item={item} />
          </TimelineItem>,
        ];
      case "connect":
        return [
          <TimelineItem key={item.key} mark="dot">
            <ConnectCard orgId={orgId} item={item} />
          </TimelineItem>,
        ];
      case "failed":
        return [
          <TimelineItem key={item.key} mark="error">
            <div data-role="failed">
              <Text tone="fail">
                {`✗ ${
                  item.code === "run.hook_denied"
                    ? item.plugin !== undefined
                      ? te("run.hook_denied", { plugin: item.plugin })
                      : te("run.hook_denied_unknown")
                    : t("failed", { code: item.code })
                }`}
              </Text>
            </div>
          </TimelineItem>,
        ];
      default:
        return [];
    }
  };

  return (
    <div role="log" aria-live="polite">
      <Stack gap={12}>
        {groupItems(items).map((g) =>
          g.kind === "user" ? (
            <UserMessage key={g.item.key} orgId={orgId} item={g.item} />
          ) : (
            <Timeline key={g.key} label={t("timeline")}>
              {g.items.flatMap(step)}
            </Timeline>
          ),
        )}
      </Stack>
    </div>
  );
}
