"use client";

import {
  Button,
  Card,
  formatSpanDuration,
  Stack,
  Text,
  ToolCallRow,
  type ToolCallStatus,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatInput } from "../lib/approvals";
import { getQuestion, type Question } from "../lib/questions";
import type { ChatItem, SubagentInfo } from "../lib/stream";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { RESULT_PREVIEW_CHARS } from "./ToolCallCard";

/**
 * Interim sub-agent rows on today's conversation page (phase C, spec §17): UI refresh B replaces
 * them with its own components. Built from existing design components only.
 */

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type WaitItem = Extract<ChatItem, { kind: "subagentWait" }>;

/** An `agent` call item (dispatched, or refused before any dispatch). */
export const isAgentCall = (item: ChatItem): item is ToolItem =>
  item.kind === "tool" && (item.subagent !== undefined || item.name === "agent");

/** A finished sub-agent's status → the row's status. */
function rowStatus(item: ToolItem): ToolCallStatus {
  const s = item.subagent?.status;
  if (s === undefined) {
    return item.status === "pending" || item.status === "running"
      ? "running"
      : item.status === "error"
        ? "error"
        : item.status === "cancelled"
          ? "cancelled"
          : "done";
  }
  if (s === "running") return "running";
  if (s === "completed") return "done";
  if (s === "aborted") return "cancelled";
  return "error";
}

/** The task name: the dispatch's description, else the call input's. */
function descriptionOf(item: ToolItem): string {
  if (item.subagent !== undefined) return item.subagent.description;
  const d = (item.input as { description?: unknown } | null)?.description;
  return typeof d === "string" ? d : "";
}

function typeOf(item: ToolItem): string {
  if (item.subagent !== undefined) return item.subagent.agentType;
  const t = (item.input as { subagent_type?: unknown } | null)?.subagent_type;
  return typeof t === "string" ? t : "general-purpose";
}

/** One sub-agent row: type, task, calls and duration; expands to the prompt and the result. */
function SubagentRow({ item, onOpen }: { item: ToolItem; onOpen?: (id: string) => void }) {
  const t = useTranslations("subagents");
  const tt = useTranslations("tools");
  const info: SubagentInfo | undefined = item.subagent;
  const status = rowStatus(item);
  const description = descriptionOf(item);
  const parts = [description];
  if (info !== undefined) parts.push(t("calls", { n: info.toolCalls }));
  if (info?.durationMs != null) parts.push(formatSpanDuration(info.durationMs));
  const result = item.result;
  const output =
    result === null
      ? undefined
      : result.length > RESULT_PREVIEW_CHARS
        ? result.slice(0, RESULT_PREVIEW_CHARS)
        : result;
  const ended = info?.status;
  return (
    <div
      data-role="subagent"
      data-status={status}
      data-call-id={item.callId}
      data-subagent-id={info?.id}
    >
      <Stack direction="row" gap={8} align="center">
        <ToolCallRow
          name={typeOf(item)}
          summary={parts.filter((p) => p !== "").join(" · ")}
          status={status}
          input={formatInput(item.input)}
          {...(output !== undefined && { output })}
          labels={{
            running: tt("status.running"),
            error:
              ended !== undefined && ended !== "running" && ended !== "completed"
                ? t(`status.${ended}`)
                : tt("status.error"),
            cancelled: t("status.aborted"),
          }}
        />
        {info !== undefined && onOpen !== undefined && (
          <Button
            variant="ghost"
            density="dense"
            aria-label={t("openLabel", { description: description || info.agentType })}
            onClick={() => onOpen(info.id)}
          >
            {t("open")}
          </Button>
        )}
      </Stack>
    </div>
  );
}

/**
 * The `agent` calls of one step as one group: "N sub-agents running", or "N sub-agents done
 * (k failed) · calls · duration" (the longest one, as they run in parallel).
 */
export function SubagentGroup({
  items,
  onOpen,
}: {
  items: ToolItem[];
  onOpen?: (id: string) => void;
}) {
  const t = useTranslations("subagents");
  const statuses = items.map(rowStatus);
  const running = statuses.filter((s) => s === "running").length;
  const failed = statuses.filter((s) => s === "error").length;
  const calls = items.reduce((n, i) => n + (i.subagent?.toolCalls ?? 0), 0);
  const longest = items.reduce((m, i) => Math.max(m, i.subagent?.durationMs ?? 0), 0);
  const title =
    running > 0
      ? t("groupRunning", { n: running })
      : t("groupDone", {
          n: items.length,
          failed,
          calls,
          duration: formatSpanDuration(longest),
        });
  return (
    <div data-role="subagent-group">
      <Card title={title}>
        <Stack gap={4}>
          {items.map((i) => (
            <SubagentRow key={i.key} item={i} {...(onOpen !== undefined && { onOpen })} />
          ))}
        </Stack>
      </Card>
    </div>
  );
}

/** A question card for a sub-agent's question: the form is read from the question API. */
function SubagentQuestion({ orgId, item }: { orgId: string; item: WaitItem }) {
  const t = useTranslations("subagents");
  const [question, setQuestion] = useState<Question | null>();
  const id = item.questionId ?? "";
  useEffect(() => {
    let disposed = false;
    getQuestion(orgId, id).then(
      (r) => {
        if (!disposed) setQuestion(r.question);
      },
      () => {
        if (!disposed) setQuestion(null);
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, id]);
  if (question === undefined) return null;
  // not this person's question (the API answers 404): say who the sub-agent waits for
  if (question === null) {
    return (
      <div data-role="subagent-question-elsewhere">
        <Text tone="muted" icon="pause">
          {t("questionElsewhere", { name: item.subagentName })}
        </Text>
      </div>
    );
  }
  const answered =
    question.status === "pending"
      ? null
      : {
          questionId: question.id,
          callId: "",
          answer: question.answer,
          byAccountId: question.answeredBy,
          outcome: question.status,
        };
  return (
    <QuestionCard
      orgId={orgId}
      subagent={item.subagentName}
      item={{
        kind: "question",
        key: item.key,
        questionId: question.id,
        callId: "",
        form: question.form,
        expiresAt: question.expiresAt,
        answered,
      }}
    />
  );
}

/**
 * A sub-agent waiting for a person (`subagent_waiting`) in the parent: its approval or question is
 * acted on here with the existing cards; a connection is made in the sub-agent's own view.
 */
export function SubagentWaitCard({
  orgId,
  item,
  onOpen,
}: {
  orgId: string;
  item: WaitItem;
  onOpen?: (id: string) => void;
}) {
  const t = useTranslations("subagents");
  if (item.wait === "approval" && item.approvalId !== undefined) {
    return (
      <ApprovalCard
        orgId={orgId}
        subagent={item.subagentName}
        item={{
          kind: "approval",
          key: item.key,
          approvalId: item.approvalId,
          callId: "",
          toolKey: item.toolKey,
          input: undefined,
          expiresAt: item.expiresAt ?? "",
          decided: null,
        }}
      />
    );
  }
  if (item.wait === "input" && item.questionId !== undefined) {
    return <SubagentQuestion orgId={orgId} item={item} />;
  }
  return (
    <div data-role="subagent-connect">
      <Stack direction="row" gap={8} align="center">
        <Text tone="warn" icon="circle-alert">
          {t("connect", { name: item.subagentName })}
        </Text>
        {onOpen !== undefined && (
          <Button variant="ghost" density="dense" onClick={() => onOpen(item.subagentId)}>
            {t("open")}
          </Button>
        )}
      </Stack>
    </div>
  );
}
