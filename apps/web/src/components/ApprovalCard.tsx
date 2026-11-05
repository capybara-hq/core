"use client";

import {
  ApprovalBlock,
  type ApprovalState,
  RadioGroup,
  Stack,
  StatusMark,
  Text,
  Textarea,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import {
  type Approval,
  type ApprovalScope,
  decideApproval,
  formatInput,
  scopesFor,
} from "../lib/approvals";
import type { ToolInfo } from "../lib/conversations";
import { approvalQuery } from "../lib/query/conversation";
import { inboxChangeKeys } from "../lib/query/inbox";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useWaiterWords } from "../lib/query/who-waits";
import { shortTime } from "../lib/time";
import type { ApprovalDecision, ApprovalItem } from "../lib/timeline";
import { toolLabel, toolLabelOfKey, toolLabelText } from "../lib/tool-label";
import { useErrorMessage } from "../lib/use-error-message";
import { useSession } from "./shell/session";

/** 已处理的结果（来自 `approval_decided` 事件或审批详情）。 */
export type Outcome = Pick<ApprovalDecision, "decision" | "scope" | "byAccountId" | "reason">;

/** 审批详情里的状态 → 处理结果（pending 为 null）。 */
export function outcomeOf(a: Approval): Outcome | null {
  if (a.status === "pending") return null;
  return {
    decision: a.status,
    ...(a.scope !== null ? { scope: a.scope } : {}),
    byAccountId: a.decidedBy,
  };
}

const rowsOf = (text: string) => Math.min(12, Math.max(2, text.split("\n").length));

/** 参数（JSON，只读代码样式）。 */
export function ApprovalInput({ input }: { input: unknown }) {
  const t = useTranslations("approval");
  const text = formatInput(input);
  return <Textarea code readOnly aria-label={t("input")} rows={rowsOf(text)} value={text} />;
}

/** 批准范围单选（按角色升级的审批只有「仅本次」）。 */
export function ScopePicker({
  approval,
  value,
  onChange,
  disabled,
}: {
  approval: Pick<Approval, "requestedFor">;
  value: ApprovalScope;
  onChange(scope: ApprovalScope): void;
  disabled?: boolean;
}) {
  const t = useTranslations("approval");
  return (
    <RadioGroup
      label={t("scopeLabel")}
      value={value}
      onChange={(v) => onChange(v as ApprovalScope)}
      {...(disabled ? { disabled } : {})}
      options={scopesFor(approval).map((s) => ({
        value: s,
        label: t(`scope.${s}`),
        description: t(`scopeHint.${s}`),
      }))}
    />
  );
}

/** 处理结果：状态标记 + 范围 + 处理人。 */
export function ApprovalOutcome({ outcome }: { outcome: Outcome }) {
  const t = useTranslations("approval");
  const { me } = useSession();
  const who =
    outcome.byAccountId === null
      ? t("system")
      : outcome.byAccountId === me.account.id
        ? t("you")
        : outcome.byAccountId;
  const status =
    outcome.decision === "approved"
      ? "success"
      : outcome.decision === "denied"
        ? "failed"
        : "cancelled";
  return (
    <Stack direction="row" gap={12} align="center" wrap>
      <StatusMark status={status} label={t(`decision.${outcome.decision}`)} />
      {outcome.decision === "approved" && outcome.scope !== undefined && (
        <Text variant="small" tone="muted">
          {t(`scope.${outcome.scope}`)}
        </Text>
      )}
      <Text variant="small" tone="muted">
        {t("decidedBy", { who })}
      </Text>
    </Stack>
  );
}

/**
 * 提交审批决定：成功返回处理后的结果；已被处理（`approval.already_decided`）等错误以 toast 告知并返回 null。
 */
export function useDecide(orgId: string) {
  const qc = useQueryClient();
  const session = useSession();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<"approve" | "deny">();
  // The answer is the decided approval: it replaces the cached one. The inbox and its count
  // change too, wherever the decision was taken (here in a conversation, or on /inbox).
  const { mutateAsync } = useAppMutation({
    fn: (v: { id: string; decision: "approve" | "deny"; scope: ApprovalScope; reason?: string }) =>
      decideApproval(orgId, v.id, {
        decision: v.decision,
        ...(v.decision === "approve" ? { scope: v.scope } : {}),
        ...(v.decision === "deny" && v.reason !== undefined ? { reason: v.reason } : {}),
      }),
    invalidates: () => inboxChangeKeys(orgId),
    onSuccess: ({ approval }, v) => qc.setQueryData(keys.org(orgId).approval(v.id), approval),
  });
  const decide = useCallback(
    async (id: string, decision: "approve" | "deny", scope: ApprovalScope, reason?: string) => {
      setPending(decision);
      try {
        const { approval } = await mutateAsync({
          id,
          decision,
          scope,
          ...(reason !== undefined ? { reason } : {}),
        });
        return approval;
      } catch (e) {
        toast.error(errorMessage(e));
        return null;
      } finally {
        setPending(undefined);
        // The sidebar's pending count follows at once (a failure most likely means someone
        // already decided: it changed too).
        session.refreshPending?.();
      }
    },
    [toast, errorMessage, session, mutateAsync],
  );
  return { decide, pending };
}

/**
 * The approval in the conversation (spec §5.7, design `ApprovalBlock`): the tool, its model-visible
 * key and every argument (key arguments first), one approve button per allowed scope, Deny with an
 * optional reason, and which rule asked. Pending, it reads the approval (who may decide, the
 * scopes); a viewer who can't decide (404) sees only that an approver is awaited. Decided, one line:
 * who, the scope, when, and the reason of a denial.
 */
export function ApprovalCard({
  orgId,
  item,
  info,
}: {
  orgId: string;
  item: ApprovalItem;
  info?: ToolInfo | undefined;
}) {
  const t = useTranslations("approval");
  const locale = useLocale();
  const timeZone = useTimeZone();
  const { me } = useSession();
  const [local, setLocal] = useState<(Outcome & { at: string }) | null>(null);
  const { decide, pending } = useDecide(orgId);
  const decided = item.decided;
  // Pending, the approval tells who may decide; not visible = may not decide (assigned to
  // someone else, or the role is too low).
  const approval = useQuery({
    ...approvalQuery(orgId, item.approvalId),
    enabled: decided === null,
    retry: false,
  });
  const view: Approval | null | undefined =
    approval.data !== undefined ? approval.data : approval.error !== null ? null : undefined;

  const fromView = view ? outcomeOf(view) : null;
  const outcome: (Outcome & { at: string | null }) | null =
    decided !== null
      ? { ...decided, at: item.decidedAt }
      : (local ?? (fromView !== null && view ? { ...fromView, at: view.decidedAt } : null));
  // Names only when someone else decided, or is awaited, so a person's own card reads nothing more
  const by = outcome?.byAccountId ?? null;
  const awaited = outcome === null && view === null ? item.approver : undefined;
  const words = useWaiterWords(
    orgId,
    (by !== null && by !== me.account.id) ||
      (awaited?.kind === "account" && awaited.accountId !== me.account.id),
  );
  const who = (id: string | null) =>
    id === null ? t("system") : (words({ kind: "account", accountId: id }) ?? t("you"));

  async function onDecide(decision: "approve" | "deny", scope: ApprovalScope, reason?: string) {
    const r = await decide(item.approvalId, decision, scope, reason);
    if (r) {
      setLocal({
        decision: r.status === "pending" ? "cancelled" : r.status,
        ...(r.scope !== null ? { scope: r.scope } : {}),
        byAccountId: r.decidedBy,
        ...(reason !== undefined ? { reason } : {}),
        at: r.decidedAt ?? new Date().toISOString(),
      });
    }
  }

  const tool = toolLabelText(info ? toolLabel(info, locale) : toolLabelOfKey(item.toolKey));
  const input =
    typeof item.input === "object" && item.input !== null && !Array.isArray(item.input)
      ? (item.input as Record<string, unknown>)
      : view && typeof view.input === "object" && view.input !== null
        ? (view.input as Record<string, unknown>)
        : {};
  let state: ApprovalState;
  if (outcome !== null) {
    state = {
      kind: "decided",
      decision: outcome.decision,
      who: who(outcome.byAccountId),
      when: outcome.at ? shortTime(outcome.at, locale, timeZone) : "",
      ...(outcome.scope !== undefined ? { scope: outcome.scope } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  } else if (view === null) {
    return (
      <div data-role="approval" data-approval-id={item.approvalId}>
        <Text variant="small" tone="muted">
          {awaited !== undefined && words(awaited) !== undefined
            ? t("otherApproverNamed", { tool, key: item.toolKey, who: words(awaited) ?? "" })
            : t("otherApproverFor", { tool, key: item.toolKey })}
        </Text>
      </div>
    );
  } else {
    state = { kind: "pending", busy: pending !== undefined || view === undefined };
  }
  return (
    <div data-role="approval" data-approval-id={item.approvalId}>
      <ApprovalBlock
        tool={tool}
        toolKey={item.toolKey}
        input={input}
        keyArgs={info?.keyArgs ?? []}
        scopes={view ? scopesFor(view) : ["once"]}
        {...(item.policy !== undefined ? { policy: t(`policy.${item.policy}`) } : {})}
        state={state}
        onApprove={(scope) => void onDecide("approve", scope)}
        onDeny={(reason) => void onDecide("deny", "once", reason)}
      />
    </div>
  );
}
