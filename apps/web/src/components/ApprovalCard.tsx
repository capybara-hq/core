"use client";

import {
  ApprovalBlock,
  type ApprovalBlockProps,
  type ApprovalFact,
  type ApprovalState,
  type CommandAsk as CommandAskBlock,
  type NetworkAsk,
  type PersonLike,
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
  decideApproval,
  formatInput,
  type PersonField,
  scopesFor,
} from "../lib/approvals";
import type { PermissionScope, SandboxEscalation, ToolInfo } from "../lib/conversations";
import { withNode } from "../lib/node-slot";
import { type PersonRef, usePersonLookup, useViewerPerson } from "../lib/people";
import { retryOnMountOf } from "../lib/query/client";
import { approvalQuery } from "../lib/query/conversation";
import { inboxChangeKeys } from "../lib/query/inbox";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useThreadWaitTarget, type WaitTarget } from "../lib/query/who-waits";
import { shortTime } from "../lib/time";
import type { ApprovalDecision, ApprovalItem } from "../lib/timeline";
import { lang, PLATFORM_PREFIX, toolLabel, toolLabelOfKey, toolLabelText } from "../lib/tool-label";
import { useErrorMessage } from "../lib/use-error-message";
import { Person } from "./Person";
import { useSession } from "./shell/session";

/**
 * A decided approval's outcome (from its `approval_decided` event or its detail). A superseded
 * one carries the root permission `revision` and the `reason` (`user` / `authority-changed`).
 */
export type Outcome = Pick<
  ApprovalDecision,
  "decision" | "scope" | "byAccountId" | "reason" | "revision"
> & {
  /** The decider as the approval read names them (null: the account is gone); absent: not read. */
  byPerson?: PersonRef | null;
};

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
    byPerson: a.decidedByPerson,
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

/**
 * The per-field problems of a refused secure input request: `approval.input_leaked` names paths,
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
 * hosts, the refused command, "allow this time" / "add to this device's list" / "deny" and the
 * checked hosts in the decision. The scopes are the view's own; "always" adds the hosts to the
 * device's list and `appliesAt` says when that takes effect. Decided, it still reads the approval:
 * the granted hosts are only there.
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
  // What the person types lives only here: sent once with the submit, cleared after, never cached.
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const decided = item.decided;
  const lookup = usePersonLookup();
  const viewer = useViewerPerson();
  // a decided card whose decider the thread's people do not name (a sub-agent's, decided in its
  // own log) reads the approval for the person
  const decidedByUnknown =
    decided !== null &&
    decided.byAccountId !== null &&
    decided.byAccountId !== me.account.id &&
    lookup(decided.byAccountId) === null;
  // Pending, the approval tells who may decide; not visible = may not decide (assigned to
  // someone else, or the role is too low). A network ask reads it decided too (granted hosts).
  const approvalQ = approvalQuery(orgId, item.approvalId);
  const approval = useQuery({
    ...approvalQ,
    enabled:
      decided === null ||
      item.network !== undefined ||
      item.loopback !== undefined ||
      decidedByUnknown,
    retry: false,
    // a 404 the server read (not this viewer's to decide) stays as it was painted
    retryOnMount: retryOnMountOf(approvalQ.queryKey),
  });
  const view: Approval | null | undefined =
    approval.data !== undefined ? approval.data : approval.error !== null ? null : undefined;

  const fromView = view ? outcomeOf(view) : null;
  const outcome: (Outcome & { at: string | null }) | null =
    decided !== null
      ? {
          ...decided,
          ...(fromView?.byPerson !== undefined ? { byPerson: fromView.byPerson } : {}),
          at: item.decidedAt,
        }
      : (local ?? (fromView !== null && view ? { ...fromView, at: view.decidedAt } : null));
  const awaited = outcome === null && view === null ? item.approver : undefined;
  const waitTarget = useThreadWaitTarget();
  const tp = useTranslations("people");
  // The decider: the system, the viewer ("you"), or a person with their avatar; one who left
  // reads "Former member". Names come from the thread's people, else from the approval read.
  const who = (o: Outcome): PersonLike | string => {
    if (o.byAccountId === null) return t("system");
    if (o.byAccountId === me.account.id) return viewer;
    const p = lookup(o.byAccountId) ?? o.byPerson ?? null;
    return p ? { name: p.name, avatarUrl: p.avatarUrl } : { name: tp("departed"), avatarUrl: null };
  };

  // A secure input request (the person types a call's secret fields): known from the log's
  // event before the approval is read, from the approval itself once it is.
  const secure = view?.kind === "secure_input" || item.secureInput !== undefined;
  // The fields shown and the fields submitted are this one list: the approval's (labels,
  // descriptions) once read, the log's paths until then.
  const secureFields: readonly PersonField[] = secure
    ? (view?.personFields ??
      (item.secureInput?.fields ?? []).map(
        (path): PersonField => ({
          path,
          label: { zh: path, en: path },
          multiline: false,
          required: true,
          isSet: false,
        }),
      ))
    : [];

  async function onDecide(
    decision: "approve" | "deny",
    scope: ApprovalScope,
    reason?: string,
    hosts?: string[],
  ) {
    // values are submitted only once the approval is read (Submit is disabled until then)
    if (secure && decision === "approve" && !view) return;
    const person = secureFields;
    const r = await decide(
      item.approvalId,
      decision,
      scope,
      reason,
      hosts,
      decision === "approve" && person.length > 0
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
        // the decision route answers no person: `decidedBy` (the viewer) is looked up
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
  const loopback = loopbackAskOf(item, view);
  const netAsk = loopback === undefined ? networkAskOf(item, view) : undefined;
  // a device service's ask (the agent's browser) words its own title and body
  const network: NetworkAsk | undefined =
    loopback !== undefined
      ? {
          hosts: [`localhost:${loopback.port}`],
          command: "",
          title: t("network.loopbackTitle", { port: loopback.port }),
          // the body names a database port, else the page that was loading
          body: loopback.database ? t("network.loopbackDatabase") : (loopback.url ?? ""),
        }
      : netAsk?.service === true
        ? {
            hosts: netAsk.hosts,
            command: netAsk.command,
            ...(netAsk.appliesAt ? { appliesAt: netAsk.appliesAt } : {}),
            title: t("network.serviceTitle", { host: netAsk.hosts.join(", ") }),
            body: t("network.serviceNote"),
          }
        : netAsk;
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
  // The crossing's details live inside the pending card (design spec §6.16.11, maintainer
  // decision 2026-11-21); decided or superseded, only its one line remains.
  const details = useCardDetails(scope, escalation, command?.path);
  const detail = view?.kind === "network" ? (view.detail ?? null) : null;
  // the scopes exactly as the view lists them: a network ask may offer "always" (add the hosts to
  // the device's own list)
  // a loopback ask offers one choice, for this conversation
  const scopes =
    loopback !== undefined ? (["session"] as const) : view ? scopesFor(view) : (["once"] as const);
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
        </Stack>
      </div>
    );
  }
  // The secure input variant ({@link secureFields}); a refused value's error stays until a new one
  // is typed.
  const secureTarget = view?.personTarget ?? item.secureInput?.target;
  const secureInput: ApprovalBlockProps["secureInput"] | undefined =
    secure && secureTarget !== undefined
      ? {
          target: secureTarget[lang(locale)],
          fields: secureFields.map((f) => {
            const error =
              fieldErrors[f.path] ??
              ((values[f.path] ?? "") === "" && view?.leakedFields?.includes(f.path)
                ? t("person.leaked")
                : undefined);
            return {
              path: f.path,
              label: f.label[lang(locale)],
              ...(f.description !== undefined ? { description: f.description[lang(locale)] } : {}),
              multiline: f.multiline,
              value: values[f.path] ?? "",
              ...(error !== undefined ? { error } : {}),
              onChange: (v: string) => {
                setValues((o) => ({ ...o, [f.path]: v }));
                setFieldErrors(({ [f.path]: _drop, ...rest }) => rest);
              },
            };
          }),
          onSubmit: () => void onDecide("approve", "once"),
          onCancel: () => void onDecide("deny", "once"),
          ...(!view ? { submitDisabled: true } : {}),
        }
      : undefined;
  let state: ApprovalState;
  if (outcome !== null) {
    const granted =
      outcome.decision === "approved" && detail?.kind !== "loopback"
        ? detail?.grantedHosts
        : undefined;
    state = {
      kind: "decided",
      decision: outcome.decision,
      who: who(outcome),
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
            {loopback !== undefined
              ? t("network.loopbackOtherApprover", { port: loopback.port })
              : t(netAsk?.service ? "network.serviceOtherApprover" : "network.otherApprover", {
                  hosts: network.hosts.join(", "),
                })}
          </Text>
        </div>
      );
    }
    const target = awaited === undefined ? undefined : waitTarget(awaited);
    return (
      <div data-role="approval" data-approval-id={item.approvalId}>
        <Text variant="small" tone="muted">
          {target === undefined
            ? t("otherApproverFor", { tool, key: item.toolKey })
            : withNode(
                (mark) => t("otherApproverNamed", { tool, key: item.toolKey, who: mark }),
                <WaitTargetName target={target} />,
              )}
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
        {...(loopback !== undefined
          ? {
              scopeLabels: { session: t("network.loopbackAllow") },
            }
          : {})}
        {...(command !== undefined ? { command } : {})}
        state={state}
        {...(view?.file !== undefined
          ? {
              file: {
                name: view.file.name,
                size: view.file.size,
                sha256: view.file.sha256,
                ...(view.file.thumbnail !== undefined ? { thumbnail: view.file.thumbnail } : {}),
              },
            }
          : {})}
        {...(secureInput !== undefined ? { secureInput } : {})}
        onApprove={(scope, hosts) =>
          void onDecide(
            "approve",
            scope,
            undefined,
            network !== undefined && loopback === undefined ? hosts : undefined,
          )
        }
        onDeny={(reason) => void onDecide("deny", "once", reason)}
        {...details}
        {...(view?.reviewUnsure ? { notes: [...(details.notes ?? []), t("reviewUnsure")] } : {})}
      />
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
    return crossing(reach.writeDirectories.length === 0 ? "host" : "directory");
  }
  return from.rule === null
    ? { key: "reviewModel", values: {}, detail: true }
    : { key: "rule", values: { rule: from.rule }, detail: true };
}

/**
 * The network ask of an approval: from its detail once read, else from the log (the hosts of
 * `approval_requested.network`, the command of the call's input); undefined for a tool approval.
 * `service`: a device service such as the agent's browser asked (browser use spec §7.1), not a
 * command (before the detail is read: an ask recorded under another tool than `Bash`).
 */
export function networkAskOf(
  item: Pick<ApprovalItem, "network" | "input" | "toolKey">,
  view: Approval | null | undefined,
): (NetworkAsk & { service?: true }) | undefined {
  const detail = view?.kind === "network" ? view.detail : undefined;
  // a loopback ask has its own reading ({@link loopbackAskOf})
  if (detail?.kind === "loopback") return undefined;
  if (detail?.kind === "service") {
    return {
      hosts: [...detail.hosts],
      command: detail.url ?? "",
      ...(detail.appliesAt ? { appliesAt: detail.appliesAt } : {}),
      service: true,
    };
  }
  if (detail) {
    return {
      hosts: detail.hosts.map((h) => h.host),
      command: detail.command,
      ...(detail.description ? { description: detail.description } : {}),
      ...(detail.appliesAt ? { appliesAt: detail.appliesAt } : {}),
    };
  }
  if (item.network === undefined) return undefined;
  if (item.toolKey !== "Bash") return { hosts: item.network.hosts, command: "", service: true };
  const description = stringField(item.input, "description");
  return {
    hosts: item.network.hosts,
    command: stringField(item.input, "command") ?? "",
    ...(description ? { description } : {}),
  };
}

/** A loopback port ask (browser loopback port grants spec §5.2): the port and what it holds. */
export interface LoopbackAsk {
  port: number;
  database: boolean;
  url: string | null;
}

/**
 * The loopback port ask of an approval: from its detail once read, else from the log's
 * `approval_requested.loopback` (no page url there); undefined for any other approval.
 */
export function loopbackAskOf(
  item: Pick<ApprovalItem, "loopback">,
  view: Approval | null | undefined,
): LoopbackAsk | undefined {
  const detail = view?.kind === "network" ? view.detail : undefined;
  if (detail?.kind === "loopback") {
    return { port: detail.port, database: detail.database, url: detail.url };
  }
  if (item.loopback === undefined) return undefined;
  return { port: item.loopback.port, database: item.loopback.database, url: null };
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
 * What a crossing puts inside the pending card (design spec §6.16.11, "Details inside the card"):
 * an escalation leads with the agent's justification (plain text, never clipped), names the
 * directory it runs in above the command, says under Allow once that only this call leaves the
 * sandbox, adds a note when it starts a background process (its deadline in whole minutes, rounded
 * up), and its decided line says it ran outside the sandbox. A permission crossing lists its exact
 * reach above the command (every directory and host, nothing inferred; the target file only when
 * it is not the path the card already shows) and hints that a directory includes its contents.
 */
function useCardDetails(
  scope: ReturnType<typeof permissionScopeOf>,
  escalation: ReturnType<typeof escalationOf>,
  shownPath: string | undefined,
): Pick<
  ApprovalBlockProps,
  "reason" | "workingRoot" | "facts" | "scopeHints" | "notes" | "decidedNote"
> {
  const t = useTranslations("approval");
  if (escalation !== undefined) {
    const { justification, workingRoot, background, maxSeconds } = escalation;
    return {
      reason: { text: justification, label: t("escalation.justification") },
      ...(workingRoot !== undefined ? { workingRoot } : {}),
      scopeHints: { once: t("escalation.hint") },
      ...(background === true
        ? {
            notes: [
              maxSeconds !== undefined
                ? t("escalation.backgroundLimit", { minutes: Math.ceil(maxSeconds / 60) })
                : t("escalation.background"),
            ],
          }
        : {}),
      decidedNote: t("escalation.decided"),
    };
  }
  if (scope !== undefined) {
    const { permissionScope: reach, targetPath } = scope;
    const facts: ApprovalFact[] = [
      { label: t("permissionScope.write"), values: reach.writeDirectories },
      { label: t("permissionScope.hosts"), values: reach.hosts },
      ...(targetPath !== undefined && targetPath !== shownPath
        ? [{ label: t("permissionScope.target"), values: [targetPath] }]
        : []),
    ];
    return { facts, scopeHints: { once: t("permissionScope.hint") } };
  }
  return {};
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

/** Who an approval waits for: a role in words, or the person (16) with their avatar. */
function WaitTargetName({ target }: { target: WaitTarget }) {
  return target.kind === "role" ? target.words : <Person person={target.person} size={16} />;
}
