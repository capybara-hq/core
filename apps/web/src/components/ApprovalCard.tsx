"use client";

import {
  ApprovalBlock,
  type ApprovalState,
  RadioGroup,
  Stack,
  StatusMark,
  Text,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import {
  type Approval,
  type ApprovalScope,
  decideApproval,
  formatInput,
  getApproval,
  scopesFor,
} from "../lib/approvals";
import type { ToolInfo } from "../lib/conversations";
import type { ApprovalDecision, ApprovalItem } from "../lib/timeline";
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

/** 本地时间（客户端组件在数据到达后才渲染，不涉及水合）。 */
export const formatTime = (iso: string, locale: string) =>
  new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });

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
  const session = useSession();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<"approve" | "deny">();
  const decide = useCallback(
    async (id: string, decision: "approve" | "deny", scope: ApprovalScope, reason?: string) => {
      setPending(decision);
      try {
        const { approval } = await decideApproval(orgId, id, {
          decision,
          ...(decision === "approve" ? { scope } : {}),
          ...(decision === "deny" && reason !== undefined ? { reason } : {}),
        });
        return approval;
      } catch (e) {
        toast.error(errorMessage(e));
        return null;
      } finally {
        setPending(undefined);
        // 顶栏的待处理数立即更新（失败多半是已被处理，同样要更新）
        session.refreshPending?.();
      }
    },
    [orgId, toast, errorMessage, session],
  );
  return { decide, pending };
}

/** The tool as people read it: "<source>: <title>", else the title, else the key. */
export function toolLabel(key: string, info: ToolInfo | undefined): string {
  const title = info?.title ?? key;
  return info?.source.kind === "connector" || info?.source.kind === "extension"
    ? `${info.source.name}: ${title}`
    : title;
}

const shortTime = (iso: string, locale: string) =>
  new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

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
  const ts = useTranslations("subagents");
  const locale = useLocale();
  const { me } = useSession();
  const [view, setView] = useState<Approval | null>();
  const [local, setLocal] = useState<(Outcome & { at: string }) | null>(null);
  const { decide, pending } = useDecide(orgId);
  const decided = item.decided;

  useEffect(() => {
    if (decided !== null) return;
    let disposed = false;
    getApproval(orgId, item.approvalId).then(
      ({ approval }) => {
        if (!disposed) setView(approval);
      },
      () => {
        // Not visible = may not decide (assigned to someone else, or the role is too low).
        if (!disposed) setView(null);
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, item.approvalId, decided]);

  const who = (id: string | null) =>
    id === null ? t("system") : id === me.account.id ? t("you") : id;
  const fromView = view ? outcomeOf(view) : null;
  const outcome: (Outcome & { at: string | null }) | null =
    decided !== null
      ? { ...decided, at: item.decidedAt }
      : (local ?? (fromView !== null && view ? { ...fromView, at: view.decidedAt } : null));

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

  const tool = toolLabel(item.toolKey, info);
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
      when: outcome.at ? shortTime(outcome.at, locale) : "",
      ...(outcome.scope !== undefined ? { scope: outcome.scope } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  } else if (view === null) {
    return (
      <div data-role="approval" data-approval-id={item.approvalId}>
        <Text variant="small" tone="muted">
          {t("otherApproverFor", { tool, key: item.toolKey })}
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
