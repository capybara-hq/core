"use client";

import { Button, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { ToolInfo } from "../../lib/conversations";
import { getQuestion, type Question } from "../../lib/questions";
import type { TimelineEntry } from "../../lib/timeline";
import { ApprovalCard } from "../ApprovalCard";
import { QuestionCard } from "../QuestionCard";

type Wait = Extract<TimelineEntry, { kind: "subagent-wait" }>;

/** A sub-agent's question, read from the question API (the parent's log has only its id). */
function ChildQuestion({ orgId, wait }: { orgId: string; wait: Wait }) {
  const t = useTranslations("subagents");
  const [question, setQuestion] = useState<Question | null>();
  const id = wait.questionId ?? "";
  useEffect(() => {
    let live = true;
    getQuestion(orgId, id).then(
      (r) => {
        if (live) setQuestion(r.question);
      },
      () => {
        // Not this person's (the starter answers, spec §9): say who the sub-agent waits for.
        if (live) setQuestion(null);
      },
    );
    return () => {
      live = false;
    };
  }, [orgId, id]);
  if (question === undefined) return null;
  if (question === null) {
    return (
      <div data-role="subagent-question-elsewhere">
        <Text variant="small" tone="muted">
          {t("questionElsewhere", { name: wait.subagent.name })}
        </Text>
      </div>
    );
  }
  return (
    <QuestionCard
      orgId={orgId}
      item={{
        questionId: question.id,
        callId: "",
        form: question.form,
        expiresAt: question.expiresAt,
        answered:
          question.status === "pending"
            ? null
            : {
                questionId: question.id,
                callId: "",
                answer: question.answer,
                byAccountId: question.answeredBy,
                outcome: question.status,
              },
      }}
    />
  );
}

/**
 * A sub-agent waiting for a person (`subagent_waiting`), in its parent: the child's approval or
 * question with the existing blocks, under a line naming the sub-agent; a connection is made in the
 * child's own record, so that is a line that opens it. The kernel decides who may act (the
 * conversation's starter): anyone else sees a waiting line.
 */
export function SubagentWait({
  orgId,
  wait,
  info,
  onOpen,
}: {
  orgId: string;
  wait: Wait;
  info: ReadonlyMap<string, ToolInfo>;
  onOpen?(id: string): void;
}) {
  const t = useTranslations("subagents");
  if (wait.wait === "connect") {
    return (
      <div data-role="subagent-connect">
        <Stack direction="row" gap={8} align="center">
          <Text variant="small" tone="muted">
            {t("connect", { name: wait.subagent.name })}
          </Text>
          {onOpen ? (
            <Button variant="ghost" density="dense" onClick={() => onOpen(wait.subagent.id)}>
              {t("open")}
            </Button>
          ) : null}
        </Stack>
      </div>
    );
  }
  return (
    <Stack gap={4}>
      <Text variant="small" tone="muted">
        {t("askedBy", { name: wait.subagent.name })}
      </Text>
      {wait.wait === "approval" && wait.approvalId !== undefined ? (
        <ApprovalCard
          orgId={orgId}
          item={{
            approvalId: wait.approvalId,
            callId: "",
            toolKey: wait.toolKey,
            input: undefined,
            expiresAt: wait.expiresAt ?? "",
            decided: null,
            decidedAt: null,
          }}
          info={info.get(wait.toolKey)}
        />
      ) : wait.questionId !== undefined ? (
        <ChildQuestion orgId={orgId} wait={wait} />
      ) : null}
    </Stack>
  );
}
