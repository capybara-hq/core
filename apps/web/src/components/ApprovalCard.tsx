"use client";

import {
  ApprovalBlock,
  type ApprovalState,
  type CommandAsk as CommandAskBlock,
  type NetworkAsk,
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
import { useCallback, useRef, useState } from "react";
import { ApiClientError } from "../lib/api";
import {
  type Approval,
  type ApprovalScope,
  CREATE_ACCOUNT_OPERATION,
  decideApproval,
  formatInput,
  scopesFor,
} from "../lib/approvals";
import type { PermissionScope, SandboxEscalation, ToolInfo } from "../lib/conversations";
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
import { PermissionScopeDetail } from "./PermissionScopeDetail";
import { SandboxEscalationDetail } from "./SandboxEscalationDetail";
import { useSession } from "./shell/session";

/**
 * A decided approval's outcome (from its `approval_decided` event or its detail). A superseded
 * one carries the root permission `revision` and the `reason` (`user` / `authority-changed`).
 */
export type Outcome = Pick<
  ApprovalDecision,
  "decision" | "scope" | "byAccountId" | "reason" | "revision"
>;

/** An approval detail's status as its outcome (null while pending). */
export function outcomeOf(a: Approval): Outcome | null {
  if (a.status === "pending") return null;
  // the API names a supersession's facts apart from a decision's (no decider, no scope)
  if (a.status === "superseded")
    return {
      decision: "superseded",
      byAccountId: null,
      ...(a.supersededReason != null ? { reason: a.supersededReason } : {}),
      ...(a.supersededRevision != null ? { revision: a.supersededRevision } : {}),
    };
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
        : "cancelled"; // expired, cancelled, skipped and superseded alike
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
 * The per-field problems of a refused person-field approval: `approval.input_leaked` names paths,
 * `approval.inputs_invalid` names `{ path, problem }`. Null for any other error. The kernel never
 * echoes a value, so nothing here can show one.
 */
function personFieldErrors(e: unknown, leakCopy: string): Record<string, string> | null {
  if (!(e instanceof ApiClientError)) return null;
  const fields = (e.rawDetails[0] as { fields?: unknown } | undefined)?.fields;
  if (!Array.isArray(fields)) return null;
  const out: Record<string, string> = {};
  if (e.code === "approval.input_leaked") {
    for (const f of fields) if (typeof f === "string") out[f] = leakCopy;
  } else if (e.code === "approval.inputs_invalid") {
    for (const f of fields) {
      const { path, problem } = (f ?? {}) as { path?: unknown; problem?: unknown };
      if (typeof path === "string" && typeof problem === "string") out[path] = problem;
    }
  } else return null;
  return out;
}

/**
 * 提交审批决定：成功返回处理后的结果；已被处理（`approval.already_decided`）等错误以 toast 告知并返回 null。
 */
export function useDecide(orgId: string) {
  // The person's typed values travel in a ref, never as mutation variables: TanStack keeps those
  // in the mutation cache.
  const inputsRef = useRef<Record<string, string> | undefined>(undefined);
  const qc = useQueryClient();
  const session = useSession();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const leakCopy = useTranslations("approval")("person.leaked");
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
        ...(v.decision === "approve" && inputsRef.current !== undefined
          ? { inputs: inputsRef.current }
          : {}),
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
      /** Person field values (approve only) and where a refused field's problem goes. */
      person?: {
        inputs: Record<string, string>;
        onFieldErrors(errors: Record<string, string>, leaked: boolean): void;
      },
    ) => {
      setPending(decision);
      inputsRef.current = decision === "approve" ? person?.inputs : undefined;
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
        const fieldErrors = person && personFieldErrors(e, leakCopy);
        if (fieldErrors) {
          // the card stays pending: each refused field says why, nothing else changes
          person?.onFieldErrors(
            fieldErrors,
            e instanceof ApiClientError && e.code === "approval.input_leaked",
          );
          return null;
        }
        toast.error(errorMessage(e));
        // most likely decided or superseded meanwhile: the card and the inbox read it again
        // (never a second decision)
        for (const queryKey of [keys.org(orgId).approval(id), ...inboxChangeKeys(orgId)])
          void qc.invalidateQueries({ queryKey });
        return null;
      } finally {
        inputsRef.current = undefined;
        setPending(undefined);
        // The sidebar's pending count follows at once (a failure most likely means someone
        // already decided: it changed too).
        session.refreshPending?.();
      }
    },
    [toast, errorMessage, session, mutateAsync, qc, orgId, leakCopy],
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
 * hosts, the refused command, "allow this time" / "deny" and the checked hosts in the decision. Device
 * protocol 4 never widens a device from the deployment, so it offers no "always" (the block names
 * the machine command instead). Decided, it still reads the approval: the granted hosts are only
 * there.
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
  // What the person types lives only here: sent once with the approve, cleared after, never cached.
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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
    const person = view?.personFields;
    const r = await decide(
      item.approvalId,
      decision,
      scope,
      reason,
      hosts,
      decision === "approve" && person && person.length > 0
        ? {
            inputs: Object.fromEntries(person.map((f) => [f.path, values[f.path] ?? ""])),
            onFieldErrors: (errors, leaked) => {
              setFieldErrors(errors);
              // a leaked value is cleared (its error stays) so it is never resubmitted by accident
              if (leaked)
                setValues((o) =>
                  Object.fromEntries(Object.entries(o).filter(([path]) => !(path in errors))),
                );
            },
          }
        : undefined,
    );
    if (r) {
      setValues({});
      setFieldErrors({});
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
  const asked = commandAskOf(item, view);
  const lead = asked === undefined ? undefined : commandLeadOf(item, view);
  // the card words the ask in the UI's language; the kernel's reason stays model-facing text
  const command =
    asked === undefined || lead === undefined
      ? asked
      : {
          ...asked,
          lead: t(`command.lead.${lead.key}`, lead.values),
          // a crossing's reach and an escalation's justification are drawn below the card; a
          // review rule's own reason says what the lead cannot, so it stays as detail text
          ...(lead.detail ? { detail: asked.reason } : {}),
        };
  const scope = permissionScopeOf(item, view);
  const escalation = escalationOf(item, view);
  const detail = view?.kind === "network" ? (view.detail ?? null) : null;
  // a network ask is granted for this run only: an "always" is never offered (device protocol 4)
  const personFields = view?.personFields ?? [];
  // values are typed once for one call: a person-field approval is never remembered
  const scopes =
    personFields.length > 0
      ? (["once"] as const)
      : view
        ? scopesFor(view).filter((s) => network === undefined || s !== "always")
        : (["once"] as const);
  // A permission change replaced the ask before anyone decided it: a final line, never actions.
  if (outcome?.decision === "superseded") {
    return (
      <div data-role="approval" data-approval-id={item.approvalId} data-state="superseded">
        <Stack gap={8}>
          <Stack direction="row" gap={12} align="center" wrap>
            <Text variant="small">{tool}</Text>
            <StatusMark status="cancelled" label={t("decision.superseded")} />
            {outcome.at ? (
              <Text variant="small" tone="muted">
                {shortTime(outcome.at, locale, timeZone)}
              </Text>
            ) : null}
          </Stack>
          <Text variant="prose" tone="muted">
            {t(
              outcome.reason === "authority-changed"
                ? "superseded.authorityChanged"
                : "superseded.user",
            )}
          </Text>
          {outcome.revision !== undefined && (
            <Text variant="small" tone="muted">
              {t("superseded.revision", { n: outcome.revision })}
            </Text>
          )}
          {scope !== undefined && (
            <PermissionScopeDetail scope={scope.permissionScope} targetPath={scope.targetPath} />
          )}
          {escalation !== undefined && (
            <SandboxEscalationDetail
              justification={escalation.justification}
              workingRoot={escalation.workingRoot}
              background={escalation.background}
              maxSeconds={escalation.maxSeconds}
            />
          )}
        </Stack>
      </div>
    );
  }
  let state: ApprovalState;
  if (outcome !== null) {
    const granted = outcome.decision === "approved" ? detail?.grantedHosts : undefined;
    state = {
      kind: "decided",
      decision: outcome.decision,
      who: who(outcome.byAccountId),
      when: outcome.at ? shortTime(outcome.at, locale, timeZone) : "",
      ...(outcome.scope !== undefined ? { scope: outcome.scope } : {}),
      ...(granted !== undefined && granted.length > 0 ? { hosts: granted } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  } else if (view === null) {
    if (command !== undefined) {
      return (
        <div data-role="approval" data-approval-id={item.approvalId}>
          <Text variant="small" tone="muted">
            {t(
              command.kind === "write"
                ? "command.otherApproverWrite"
                : command.kind === "read"
                  ? "command.otherApproverRead"
                  : "command.otherApprover",
            )}
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
        scopes={[...scopes]}
        {...(item.policy !== undefined && network === undefined && command === undefined
          ? { policy: t(`policy.${item.policy}`) }
          : {})}
        {...(network !== undefined ? { network } : {})}
        {...(command !== undefined ? { command } : {})}
        state={state}
        {...(personFields.length > 0 && view?.personTarget
          ? {
              personTarget: view.personTarget[lang(locale)],
              approveDisabled: personFields.some((f) => (values[f.path] ?? "") === ""),
              personFields: personFields.map((f) => ({
                path: f.path,
                label: f.label,
                ...(f.description !== undefined ? { description: f.description } : {}),
                multiline: f.multiline,
                value: values[f.path] ?? "",
                ...(fieldErrors[f.path] !== undefined ? { error: fieldErrors[f.path] } : {}),
                onChange: (v: string) => {
                  setValues((o) => ({ ...o, [f.path]: v }));
                  setFieldErrors(({ [f.path]: _drop, ...rest }) => rest);
                },
              })),
            }
          : {})}
        onApprove={(scope, hosts) =>
          void onDecide("approve", scope, undefined, network !== undefined ? hosts : undefined)
        }
        onDeny={(reason) => void onDecide("deny", "once", reason)}
      />
      {scope !== undefined && (
        <PermissionScopeDetail scope={scope.permissionScope} targetPath={scope.targetPath} />
      )}
      {escalation !== undefined && (
        <SandboxEscalationDetail
          justification={escalation.justification}
          workingRoot={escalation.workingRoot}
          background={escalation.background}
          maxSeconds={escalation.maxSeconds}
        />
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

/** The `approval.command.lead.*` key of a command ask, and its values. */
export interface CommandLead {
  key:
    | "read"
    | "write"
    | "directory"
    | "host"
    | "escalation"
    | "rule"
    | "reviewModel"
    | "readUnsure"
    | "writeUnsure"
    | "directoryUnsure"
    | "hostUnsure"
    | "escalationUnsure";
  values: Record<string, string>;
  /** The review's reason is worth showing under the lead (a rule's or the review model's ask). */
  detail?: true;
}

/**
 * What a command ask asks, from its structured facts only (kind, reach, escalation, rule and the
 * profile it was reviewed under), never from the kernel's English reason: a file read or write
 * outside the scope, a directory or host a command needs, running outside the sandbox, or a
 * sensitive command a review rule (or the review model) held. Under Approve for me a crossing
 * reaches the person only when the review model could not decide it, and the lead says so.
 */
export function commandLeadOf(
  item: Pick<ApprovalItem, "command">,
  view: Approval | null | undefined,
): CommandLead | undefined {
  const detail = view?.kind === "command" ? (view.command ?? null) : null;
  const from = detail ?? item.command;
  if (from === undefined || from === null) return undefined;
  const profile = detail?.permissionCandidate?.binding.profile ?? item.command?.profile;
  const unsure = profile === "approve-for-me";
  const crossing = (key: "read" | "write" | "directory" | "host" | "escalation"): CommandLead => ({
    key: unsure ? `${key}Unsure` : key,
    values: {},
  });
  if (from.escalation !== undefined) return crossing("escalation");
  const reach = from.permissionScope;
  if (reach !== undefined) {
    if (from.kind === "read") return crossing("read");
    if (from.kind === "write") return crossing("write");
    return crossing(
      reach.readDirectories.length === 0 && reach.writeDirectories.length === 0
        ? "host"
        : "directory",
    );
  }
  return from.rule === null
    ? { key: "reviewModel", values: {}, detail: true }
    : { key: "rule", values: { rule: from.rule }, detail: true };
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

/**
 * The exact reach a permission ask grants: from its detail once read, else from the log's
 * `approval_requested.command` (both carry the same untruncated arrays); undefined for an ask
 * without one (an auto-mode command ask, other kinds).
 */
export function permissionScopeOf(
  item: Pick<ApprovalItem, "command">,
  view: Approval | null | undefined,
): { permissionScope: PermissionScope; targetPath?: string } | undefined {
  const detail = view?.kind === "command" ? view.command : null;
  const from = detail?.permissionScope !== undefined ? detail : item.command;
  // an escalation names no directory scope: its own detail shows what it crosses
  if (from?.permissionScope === undefined || from.escalation !== undefined) return undefined;
  return {
    permissionScope: from.permissionScope,
    ...(from.targetPath !== undefined ? { targetPath: from.targetPath } : {}),
  };
}

/**
 * The per-call sandbox escalation an ask requests: from its detail once read, else from the log's
 * `approval_requested.command`; undefined for any other ask.
 */
export function escalationOf(
  item: Pick<ApprovalItem, "command">,
  view: Approval | null | undefined,
): (SandboxEscalation & { workingRoot?: string }) | undefined {
  const detail = view?.kind === "command" ? view.command : null;
  const from = detail?.escalation !== undefined ? detail : item.command;
  if (from?.escalation === undefined) return undefined;
  return {
    justification: from.escalation.justification,
    ...(from.escalation.background === true ? { background: true as const } : {}),
    ...(from.escalation.maxSeconds !== undefined ? { maxSeconds: from.escalation.maxSeconds } : {}),
    ...(from.workingRoot !== undefined ? { workingRoot: from.workingRoot } : {}),
  };
}
