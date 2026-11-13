"use client";

import {
  ApprovalBlock,
  type ApprovalState,
  type CommandAsk as CommandAskBlock,
  type NetworkAsk,
  type NetworkFallback,
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
  CREATE_ACCOUNT_OPERATION,
  decideApproval,
  formatInput,
  scopesFor,
} from "../lib/approvals";
import type { ToolInfo } from "../lib/conversations";
import { retryOnMountOf } from "../lib/query/client";
import { approvalQuery } from "../lib/query/conversation";
import { inboxChangeKeys } from "../lib/query/inbox";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useWaiterWords } from "../lib/query/who-waits";
import { shortTime } from "../lib/time";
import type { ApprovalDecision, ApprovalItem } from "../lib/timeline";
import { lang, PLATFORM_PREFIX, toolLabel, toolLabelOfKey, toolLabelText } from "../lib/tool-label";
import { useErrorMessage } from "../lib/use-error-message";
import { InitialPasswordReveal } from "./InitialPasswordReveal";
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
  approval: Pick<Approval, "requestedFor" | "scopes">;
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
        : "cancelled"; // expired, cancelled and skipped alike
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
    fn: (v: {
      id: string;
      decision: "approve" | "deny";
      scope: ApprovalScope;
      reason?: string;
      hosts?: string[];
    }) =>
      decideApproval(orgId, v.id, {
        decision: v.decision,
        ...(v.decision === "approve" ? { scope: v.scope } : {}),
        ...(v.decision === "approve" && v.hosts !== undefined ? { hosts: v.hosts } : {}),
        ...(v.decision === "deny" && v.reason !== undefined ? { reason: v.reason } : {}),
      }),
    invalidates: () => inboxChangeKeys(orgId),
    onSuccess: ({ approval }, v) => qc.setQueryData(keys.org(orgId).approval(v.id), approval),
  });
  const decide = useCallback(
    async (
      id: string,
      decision: "approve" | "deny",
      scope: ApprovalScope,
      reason?: string,
      /** A network ask's checked hosts. */
      hosts?: string[],
    ) => {
      setPending(decision);
      try {
        const { approval } = await mutateAsync({
          id,
          decision,
          scope,
          ...(reason !== undefined ? { reason } : {}),
          ...(hosts !== undefined ? { hosts } : {}),
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
 * who, the scope, when, and the reason of a denial. With `fromRead` (a sub-agent's wait, whose
 * decision the parent's log does not carry) the item's `decided: null` means unknown, not pending:
 * nothing is drawn until the read answers, so a decided approval never paints as pending first.
 *
 * A network ask (network ask spec §6.5, `kind: "network"`) draws the block's network variant: the
 * hosts, the refused command, 「这次允许」 / 「这台设备一直允许」 / 「拒绝」 and the checked hosts in
 * the decision. Decided, it still reads the approval: the granted hosts and a fallback from
 * "always" to "this time" are only there. Pending after an "always" whose device change did not
 * take effect or was not confirmed (`detail.attempt`, re-read on `approval_updated`), one line
 * says why under the block.
 */
export function ApprovalCard({
  orgId,
  item,
  info,
  fromRead = false,
}: {
  orgId: string;
  item: ApprovalItem;
  info?: ToolInfo | undefined;
  fromRead?: boolean;
}) {
  const t = useTranslations("approval");
  const locale = useLocale();
  const timeZone = useTimeZone();
  const { me } = useSession();
  const [local, setLocal] = useState<(Outcome & { at: string }) | null>(null);
  const { decide, pending } = useDecide(orgId);
  const decided = item.decided;
  // Pending, the approval tells who may decide; not visible = may not decide (assigned to
  // someone else, or the role is too low). A network ask reads it decided too (granted hosts).
  const approvalQ = approvalQuery(orgId, item.approvalId);
  const approval = useQuery({
    ...approvalQ,
    enabled: decided === null || item.network !== undefined,
    retry: false,
    // a 404 the server read (not this viewer's to decide) stays as it was painted
    retryOnMount: retryOnMountOf(approvalQ.queryKey),
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

  async function onDecide(
    decision: "approve" | "deny",
    scope: ApprovalScope,
    reason?: string,
    hosts?: string[],
  ) {
    const r = await decide(item.approvalId, decision, scope, reason, hosts);
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

  // a Platform call's approval is keyed `Platform:<operation>` (the conversation item's key is the tool's)
  const platformKey = view?.toolKey?.startsWith(PLATFORM_PREFIX) ? view.toolKey : undefined;
  const tool = toolLabelText(
    info && platformKey === undefined
      ? toolLabel(info, locale)
      : toolLabelOfKey(platformKey ?? item.toolKey),
  );
  const input =
    typeof item.input === "object" && item.input !== null && !Array.isArray(item.input)
      ? (item.input as Record<string, unknown>)
      : view && typeof view.input === "object" && view.input !== null
        ? (view.input as Record<string, unknown>)
        : {};
  // an approved accounts.create: its generated password is shown once to the person who approved
  const revealsPassword =
    outcome?.decision === "approved" &&
    outcome.byAccountId === me.account.id &&
    ((platformKey ?? item.toolKey) === `${PLATFORM_PREFIX}${CREATE_ACCOUNT_OPERATION}` ||
      (item.toolKey === "Platform" && input.operation === CREATE_ACCOUNT_OPERATION));
  const network = networkAskOf(item, view);
  const command = commandAskOf(item, view);
  const detail = view?.kind === "network" ? (view.detail ?? null) : null;
  let state: ApprovalState;
  if (outcome !== null) {
    const fallback: NetworkFallback | undefined =
      detail?.outcome === "once_fallback" ? (detail.fallback ?? "unsupported") : undefined;
    const granted = outcome.decision === "approved" ? detail?.grantedHosts : undefined;
    state = {
      kind: "decided",
      decision: outcome.decision,
      who: who(outcome.byAccountId),
      when: outcome.at ? shortTime(outcome.at, locale, timeZone) : "",
      ...(fallback !== undefined
        ? { scope: "once" as const, fallback }
        : outcome.scope !== undefined
          ? { scope: outcome.scope }
          : {}),
      ...(granted !== undefined && granted.length > 0 ? { hosts: granted } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  } else if (view === null) {
    if (command !== undefined) {
      return (
        <div data-role="approval" data-approval-id={item.approvalId}>
          <Text variant="small" tone="muted">
            {t("command.otherApprover")}
          </Text>
        </div>
      );
    }
    if (network !== undefined) {
      return (
        <div data-role="approval" data-approval-id={item.approvalId}>
          <Text variant="small" tone="muted">
            {t("network.otherApprover", { hosts: network.hosts.join(", ") })}
          </Text>
        </div>
      );
    }
    return (
      <div data-role="approval" data-approval-id={item.approvalId}>
        <Text variant="small" tone="muted">
          {awaited !== undefined && words(awaited) !== undefined
            ? t("otherApproverNamed", { tool, key: item.toolKey, who: words(awaited) ?? "" })
            : t("otherApproverFor", { tool, key: item.toolKey })}
        </Text>
      </div>
    );
  } else if (view === undefined && fromRead) {
    return null;
  } else {
    state = { kind: "pending", busy: pending !== undefined || view === undefined };
  }
  return (
    <div data-role="approval" data-approval-id={item.approvalId}>
      <ApprovalBlock
        tool={tool}
        toolKey={platformKey ?? item.toolKey}
        {...(view?.summary ? { summary: view.summary[lang(locale)] } : {})}
        input={input}
        keyArgs={info?.keyArgs ?? []}
        scopes={view ? scopesFor(view) : ["once"]}
        {...(item.policy !== undefined && network === undefined && command === undefined
          ? { policy: t(`policy.${item.policy}`) }
          : {})}
        {...(network !== undefined ? { network } : {})}
        {...(command !== undefined ? { command } : {})}
        state={state}
        onApprove={(scope, hosts) =>
          void onDecide("approve", scope, undefined, network !== undefined ? hosts : undefined)
        }
        onDeny={(reason) => void onDecide("deny", "once", reason)}
      />
      {state.kind === "pending" && detail?.attempt !== undefined && (
        <Text variant="small" tone="warn">
          {detail.attempt.outcome === "failed"
            ? t("network.attempt.failed", { message: detail.attempt.message })
            : detail.attempt.outcome === "unknown"
              ? t("network.attempt.unknown")
              : t("network.attempt.appliedUndecided")}
        </Text>
      )}
      {revealsPassword && <InitialPasswordReveal orgId={orgId} approvalId={item.approvalId} />}
    </div>
  );
}

const stringField = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

/**
 * The command review ask of an approval (auto mode spec §5.4): from the approval's detail once
 * read (the full command), else from the log's display-only event field (a clipped copy clipped
 * again to the card's 300 characters); undefined for any other approval.
 */
export function commandAskOf(
  item: Pick<ApprovalItem, "command">,
  view: Approval | null | undefined,
): CommandAskBlock | undefined {
  const detail = view?.kind === "command" ? view.command : null;
  if (detail) {
    return {
      kind: detail.kind,
      command: detail.command,
      ...(detail.path !== undefined ? { path: detail.path } : {}),
      reason: detail.reason,
    };
  }
  return item.command;
}

/**
 * The network ask of an approval: from its detail once read, else from the log (the hosts of
 * `approval_requested.network`, the command of the call's input); undefined for a tool approval.
 */
export function networkAskOf(
  item: Pick<ApprovalItem, "network" | "input">,
  view: Approval | null | undefined,
): NetworkAsk | undefined {
  const detail = view?.kind === "network" ? view.detail : undefined;
  if (detail) {
    return {
      hosts: detail.hosts.map((h) => h.host),
      command: detail.command,
      ...(detail.description ? { description: detail.description } : {}),
    };
  }
  if (item.network === undefined) return undefined;
  const description = stringField(item.input, "description");
  return {
    hosts: item.network.hosts,
    command: stringField(item.input, "command") ?? "",
    ...(description ? { description } : {}),
  };
}
