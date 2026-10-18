"use client";

import {
  Button,
  Card,
  KeyValue,
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
import type { ApprovalDecision, ChatItem } from "../lib/stream";
import { useErrorMessage } from "../lib/use-error-message";
import { useSession } from "./shell/session";

type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

/** 已处理的结果（来自 `approval_decided` 事件或审批详情）。 */
export type Outcome = Pick<ApprovalDecision, "decision" | "scope" | "byAccountId">;

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
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<"approve" | "deny">();
  const decide = useCallback(
    async (id: string, decision: "approve" | "deny", scope: ApprovalScope) => {
      setPending(decision);
      try {
        const { approval } = await decideApproval(orgId, id, {
          decision,
          ...(decision === "approve" ? { scope } : {}),
        });
        return approval;
      } catch (e) {
        toast.error(errorMessage(e));
        return null;
      } finally {
        setPending(undefined);
      }
    },
    [orgId, toast, errorMessage],
  );
  return { decide, pending };
}

/**
 * 对话内的审批卡片：工具名、应用、参数、三种范围单选与「批准 / 拒绝」；已处理的显示结果与处理人。
 * 待处理时读取审批详情（应用名、工具原名、能否选范围）；当前用户不能处理（404）时只显示「等待审批人」。
 */
export function ApprovalCard({ orgId, item }: { orgId: string; item: ApprovalItem }) {
  const t = useTranslations("approval");
  const locale = useLocale();
  const [view, setView] = useState<Approval | null>();
  const [scope, setScope] = useState<ApprovalScope>("once");
  const [local, setLocal] = useState<Outcome | null>(null);
  const { decide, pending } = useDecide(orgId);
  const outcome: Outcome | null = item.decided ?? local ?? (view ? outcomeOf(view) : null);

  useEffect(() => {
    if (item.decided !== null) return;
    let disposed = false;
    getApproval(orgId, item.approvalId).then(
      ({ approval }) => {
        if (!disposed) setView(approval);
      },
      () => {
        // 看不到 = 不能处理（指定给别人或角色不够）；其他错误同样只显示等待
        if (!disposed) setView(null);
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, item.approvalId, item.decided]);

  async function onDecide(decision: "approve" | "deny") {
    const r = await decide(item.approvalId, decision, scope);
    if (r) {
      setLocal({
        decision: r.status === "pending" ? "cancelled" : r.status,
        ...(r.scope !== null ? { scope: r.scope } : {}),
        byAccountId: r.decidedBy,
      });
    }
  }

  const canDecide = outcome === null && view !== undefined && view !== null;
  const rows = [
    { k: t("tool"), v: view?.toolName ?? item.toolKey },
    ...(view?.app ? [{ k: t("app"), v: view.app.name }] : []),
    { k: t("expires"), v: formatTime(item.expiresAt, locale) },
  ];

  return (
    <div data-role="approval" data-approval-id={item.approvalId}>
      <Card
        title={t("title")}
        actions={
          outcome === null ? <StatusMark status="waiting" label={t("waiting")} /> : undefined
        }
      >
        <Stack gap={12}>
          <KeyValue keyWidth="10ch" rows={rows} />
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("input")}
            </Text>
            <ApprovalInput input={view?.input ?? item.input} />
          </Stack>
          {outcome !== null ? (
            <ApprovalOutcome outcome={outcome} />
          ) : canDecide ? (
            <Stack gap={12}>
              <ScopePicker
                approval={view}
                value={scope}
                onChange={setScope}
                disabled={pending !== undefined}
              />
              <Stack direction="row" gap={8}>
                <Button
                  variant="primary"
                  loading={pending === "approve"}
                  disabled={pending !== undefined}
                  onClick={() => void onDecide("approve")}
                >
                  {t("approve")}
                </Button>
                <Button
                  variant="danger"
                  loading={pending === "deny"}
                  disabled={pending !== undefined}
                  onClick={() => void onDecide("deny")}
                >
                  {t("deny")}
                </Button>
              </Stack>
            </Stack>
          ) : view === null ? (
            <Text variant="small" tone="muted">
              {t("otherApprover")}
            </Text>
          ) : null}
        </Stack>
      </Card>
    </div>
  );
}
