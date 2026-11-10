"use client";

import {
  type ActionRowProps,
  Button,
  Card,
  CellTitle,
  type Column,
  DataTable,
  DateTime,
  Field,
  InboxPage,
  ItemList,
  KeyValue,
  Stack,
  StatusMark,
  Text,
  Textarea,
  useStatusBar,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { ApprovalInput, ScopePicker, useDecide } from "../../../components/ApprovalCard";
import { PendingConnectorDialog } from "../../../components/agent/PendingConnectorDialog";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import {
  requesterOf,
  SkillChangeReview,
  useDecideSkillChange,
} from "../../../components/SkillChangeReview";
import { usePagePath } from "../../../components/shell/path";
import { Link, useRouter } from "../../../i18n/navigation";
import type { Approval, ApprovalScope } from "../../../lib/approvals";
import {
  type CatalogRequest,
  decideOrgRequest,
  requesterOf as directoryRequester,
  dismissOrgRequest,
  displayNameOf,
  isSetupRequest,
  requestSubject,
  requestVersion,
} from "../../../lib/catalog";
import {
  dismissNotice,
  hasNotice,
  type InboxItem,
  isShowable,
  type OrgNotice,
} from "../../../lib/inbox";
import { entryOfRequest } from "../../../lib/pending-connectors";
import { inboxChangeKeys, inboxQuery } from "../../../lib/query/inbox";
import { keys } from "../../../lib/query/keys";
import { useAppMutation } from "../../../lib/query/mutation";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import type { SkillChange } from "../../../lib/skills";
import { approvalToolLabel, toolLabelText } from "../../../lib/tool-label";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/inbox`: what waits on me (`GET /inbox` by type): tool call approvals, skill changes of the
 * shared agents I own and catalog requests (InboxPage: the list, the detail, the ActionRow). From
 * the query cache (the layout prefetched the inbox and the first item's skill change on a first
 * load); a decision hides the item at once and invalidates the inbox.
 */
export default function InboxPageView() {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <InboxView orgId={ws.orgId} />;
}

function InboxView({ orgId }: { orgId: string }) {
  const read = usePageQuery(inboxQuery(orgId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  return <Inbox orgId={orgId} inbox={read.kind === "ready" ? read.data : null} />;
}

function Inbox({
  orgId,
  inbox,
}: {
  orgId: string;
  /** `null` while it loads. */
  inbox: { items: InboxItem[]; truncated?: boolean } | null;
}) {
  const here = usePagePath("org");
  const t = useTranslations("inbox");
  const locale = useLocale();
  const toast = useToast();
  const ta = useTranslations("approval");
  const router = useRouter();
  const qc = useQueryClient();
  // Items decided here: hidden at once, before the inbox is read again (their actions can't be
  // pressed twice meanwhile).
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const rows = (inbox?.items ?? []).filter((i) => isShowable(i) && !decided.has(subjectOf(i)));
  const truncated = inbox?.truncated === true;
  const [activeId, setActiveId] = useState<string>();
  const active = rows.find((a) => a.id === activeId) ?? rows[0];
  const [scope, setScope] = useState<ApprovalScope>("once");
  const approvals = useDecide(orgId);
  const changes = useDecideSkillChange(orgId);
  const td = useTranslations("catalog.inbox");
  const errorMessage = useErrorMessage();
  const [requestPending, setRequestPending] = useState<"approve" | "reject">();
  // A connector setup request (ruling P4-7): the reason a rejection sends, and the configure dialog
  const [rejectReason, setRejectReason] = useState("");
  const [configuring, setConfiguring] = useState<CatalogRequest | null>(null);
  const ts = useTranslations("inbox.setup");
  const tn = useTranslations("inbox.skillRenamed");
  const tnn = useTranslations("inbox.orgNotice");
  const [noticePending, setNoticePending] = useState(false);
  // Dismissing a notice changes only the inbox
  const dismissMutation = useAppMutation({
    fn: (id: string) => dismissNotice(orgId, id),
    invalidates: () => inboxChangeKeys(orgId),
  });
  // Dismissing a decided request of mine changes only the inbox
  const dismissDecidedMutation = useAppMutation({
    fn: (id: string) => dismissOrgRequest(orgId, id),
    invalidates: () => inboxChangeKeys(orgId),
  });
  const tdd = useTranslations("inbox.requestDecided");
  // A catalog request decision changes the catalog's view of the item and the inbox (a failure
  // reads the inbox again through `handled`).
  const decideRequestMutation = useAppMutation({
    fn: (v: { id: string; decision: "approve" | "reject"; reason?: string }) =>
      decideOrgRequest(orgId, v.id, {
        approve: v.decision === "approve",
        ...(v.reason !== undefined && v.reason !== "" ? { reason: v.reason } : {}),
      }),
    invalidates: () => [
      keys.org(orgId).catalog(),
      keys.org(orgId).catalogItemsAll(),
      ...inboxChangeKeys(orgId),
    ],
  });
  // Nothing while the inbox loads (not "0 pending").
  useStatusBar(inbox === null ? null : `· ${t("pendingCount", { n: rows.length })}`);

  // 换一项时审批范围回到「仅本次」
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在选中项变化时重置
  useEffect(() => {
    setScope("once");
    setRejectReason("");
  }, [active?.id]);

  const labels: Labels = {
    skillChange: { share: t("skillChange.kind.share"), version: t("skillChange.kind.version") },
    request: td("label"),
    skillRenamed: tn("label"),
    setup: ts("label"),
    setupDecided: ts("decidedLabel"),
    notice: tnn,
    decided: tdd("label"),
    approved: tdd("approved"),
    rejected: tdd("rejected"),
  };
  const columns: Column<InboxItem>[] = [
    {
      // A neutral header: the rows are requests and notices alike
      key: "item",
      header: t("columns.item"),
      cell: (item) => {
        const r = rowOf(item, labels, locale);
        return (
          <CellTitle
            title={r.title}
            {...(r.trailing !== null ? { trailing: r.trailing } : {})}
            {...(r.description !== "" ? { description: r.description } : {})}
          />
        );
      },
    },
    {
      key: "at",
      header: t("columns.time"),
      tone: "muted",
      cell: (item) => <DateTime value={item.createdAt} />,
    },
  ];

  /**
   * An item was handled (or failed as already handled elsewhere: it is no longer pending): it is
   * hidden and the first item is selected. A decision invalidated the inbox itself; a failure
   * (`message === null`) reads it again here.
   */
  const handled = (id: string, message: string | null) => {
    if (message !== null) toast.success(message);
    setDecided((s) => new Set(s).add(id));
    setActiveId(undefined);
    if (message === null) {
      for (const queryKey of inboxChangeKeys(orgId)) void qc.invalidateQueries({ queryKey });
    }
  };

  async function decideApproval(approval: Approval, decision: "approve" | "deny") {
    // 顶栏待处理数的刷新由 useDecide 负责
    const r = await approvals.decide(approval.id, decision, scope);
    handled(approval.id, r ? (decision === "approve" ? t("approved") : t("denied")) : null);
  }

  async function decideChange(change: SkillChange, decision: "approve" | "reject") {
    const ok = await changes.decide(change, decision);
    handled(
      change.id,
      ok ? (decision === "approve" ? t("skillChange.approved") : t("skillChange.rejected")) : null,
    );
  }

  async function decideRequest(
    request: CatalogRequest,
    decision: "approve" | "reject",
    reason?: string,
  ) {
    setRequestPending(decision);
    try {
      await decideRequestMutation.mutateAsync({
        id: request.id,
        decision,
        ...(reason !== undefined ? { reason: reason.trim() } : {}),
      });
      handled(
        request.id,
        isSetupRequest(request)
          ? ts("rejected")
          : decision === "approve"
            ? td("approved")
            : td("rejected"),
      );
    } catch (e) {
      toast.error(errorMessage(e));
      handled(request.id, null);
    } finally {
      setRequestPending(undefined);
    }
  }

  async function dismissDecided(request: CatalogRequest) {
    setNoticePending(true);
    try {
      await dismissDecidedMutation.mutateAsync(request.id);
      handled(request.id, tn("dismissed"));
    } catch (e) {
      toast.error(errorMessage(e));
      handled(request.id, null);
    } finally {
      setNoticePending(false);
    }
  }

  async function dismiss(notice: OrgNotice) {
    setNoticePending(true);
    try {
      await dismissMutation.mutateAsync(notice.id);
      handled(notice.id, tn("dismissed"));
    } catch (e) {
      toast.error(errorMessage(e));
      handled(notice.id, null);
    } finally {
      setNoticePending(false);
    }
  }

  const detail: Detail | null =
    active === undefined
      ? null
      : hasNotice(active)
        ? noticeDetail({
            notice: active.notice,
            pending: noticePending,
            onDismiss: () => void dismiss(active.notice),
            tn,
            tnn,
            t,
            locale,
          })
        : active.type === "catalog_request_decided" && isSetupRequest(active.request)
          ? setupDecidedDetail({
              request: active.request,
              pending: noticePending,
              onDismiss: () => void dismissDecided(active.request),
              ts,
              tdd,
              t,
            })
          : active.type === "catalog_request" && isSetupRequest(active.request)
            ? setupRequestDetail({
                request: active.request,
                pending: requestPending,
                reason: rejectReason,
                setReason: setRejectReason,
                onConfigure: () => setConfiguring(active.request),
                onReject: () => void decideRequest(active.request, "reject", rejectReason),
                ts,
                td,
                t,
                locale,
              })
            : active.type === "catalog_request_decided"
              ? decidedRequestDetail({
                  request: active.request,
                  pending: noticePending,
                  onDismiss: () => void dismissDecided(active.request),
                  tdd,
                  t,
                  locale,
                })
              : active.type === "catalog_request"
                ? directoryRequestDetail({
                    request: active.request,
                    pending: requestPending,
                    onDecide: (d) => void decideRequest(active.request, d),
                    td,
                    t,
                    locale,
                  })
                : active.type === "tool_approval"
                  ? toolApprovalDetail({
                      approval: active.approval,
                      scope,
                      setScope,
                      pending: approvals.pending,
                      onDecide: (d) => void decideApproval(active.approval, d),
                      openConversation: () => router.push(active.approval.conversationPath),
                      locale,
                      t,
                      ta,
                    })
                  : skillChangeDetail({
                      orgId,
                      change: active.skillChange,
                      pending: changes.pending,
                      onDecide: (d) => void decideChange(active.skillChange, d),
                      t,
                    });

  if (inbox === null) {
    return (
      <InboxPage
        header={{ path: [...here, { label: "inbox" }], title: t("title") }}
        // The loaded inbox opens its first item: the inspector (its facts) and the decision row
        inspectorTitle={t("inspectorTitle")}
        actionRow={{
          secondary: { label: ta("deny"), onSelect: () => {} },
          primary: { label: ta("approve"), onSelect: () => {} },
        }}
        loading={{
          list: "records",
          table: { label: t("listLabel"), columns, rowHeight: "dense", framed: false },
          inspector: { rows: 4, keyWidth: "10ch" },
        }}
      />
    );
  }
  const setupAgent = configuring?.agent ?? null;
  return (
    <>
      {configuring !== null && setupAgent !== null && (
        <PendingConnectorDialog
          orgId={orgId}
          agentId={setupAgent.id}
          agentName={setupAgent.name}
          entries={(configuring.connectors ?? []).map(entryOfRequest)}
          onClose={() => setConfiguring(null)}
          onDone={() => handled(configuring.id, ts("configured"))}
        />
      )}
      <InboxPage
        header={{
          path: [...here, { label: "inbox" }],
          title: t("title"),
          count: `${rows.length}${truncated ? "+" : ""}`,
        }}
        {...(rows.length === 0 ? { empty: { text: t("empty"), hint: t("emptyHint") } } : {})}
        list={
          <DataTable<InboxItem>
            label={t("listLabel")}
            rowHeight="dense"
            framed={false}
            columns={columns}
            rows={rows}
            rowKey={(a) => a.id}
            rowLabel={(a) => rowOf(a, labels, locale).title}
            {...(active ? { activeKey: active.id } : {})}
            onOpen={(a) => setActiveId(a.id)}
            state="ready"
            empty={{ title: t("empty"), hint: t("emptyHint") }}
          />
        }
        {...(detail
          ? {
              inspectorTitle: t("inspectorTitle"),
              inspector: detail.inspector,
              actionRow: detail.actionRow,
            }
          : {})}
      >
        <Stack gap={12}>
          {truncated && (
            <Text variant="small" tone="warn">
              {t("truncated")}
            </Text>
          )}
          {detail ? detail.content : rows.length > 0 ? <Text tone="muted">{t("pick")}</Text> : null}
        </Stack>
      </InboxPage>
    </>
  );
}

/** The id of what an item asks to decide (the approval, the skill change, the request, the notice). */
const subjectOf = (i: InboxItem): string =>
  i.type === "tool_approval"
    ? i.approval.id
    : i.type === "skill_change"
      ? i.skillChange.id
      : hasNotice(i)
        ? i.notice.id
        : i.request.id;

/** The labels the row titles start with. */
interface Labels {
  skillChange: Record<SkillChange["kind"], string>;
  request: string;
  skillRenamed: string;
  setup: string;
  setupDecided: string;
  notice: Translate;
  decided: string;
  approved: string;
  rejected: string;
}

/**
 * One list row (spec §5.7): it leads with what the item is about (the tool, the skill, the
 * plugin's display name), the version beside it (never cut, the name takes the ellipsis), and
 * the kind of item on the second line (共享技能 · the agent, 已共享 · the org, 上传已确认 …).
 */
function rowOf(
  item: InboxItem,
  labels: Labels,
  locale: string,
): { title: string; trailing: string | null; description: string } {
  const joined = (...parts: string[]) => parts.filter((p) => p !== "").join(" · ");
  if (item.type === "skill_change") {
    const c = item.skillChange;
    return {
      title: c.name,
      trailing: null,
      description: joined(labels.skillChange[c.kind], c.agent.name),
    };
  }
  if (
    (item.type === "catalog_request" || item.type === "catalog_request_decided") &&
    isSetupRequest(item.request)
  ) {
    const r = item.request;
    return {
      title: r.agent?.name ?? "—",
      trailing: null,
      description:
        item.type === "catalog_request"
          ? labels.setup
          : joined(
              labels.setupDecided,
              r.status === "approved" ? labels.approved : labels.rejected,
            ),
    };
  }
  if (item.type === "catalog_request") {
    const version = requestVersion(item.request);
    return {
      title: displayNameOf(requestSubject(item.request), locale),
      trailing: version === null ? null : versionLabel(version),
      description: labels.request,
    };
  }
  if (hasNotice(item)) {
    const n = item.notice;
    if (n.kind === "skill_renamed") {
      return {
        title: n.skillRenamed.to,
        trailing: null,
        description: joined(labels.skillRenamed, n.skillRenamed.from),
      };
    }
    const line = noticeLine(n, labels.notice, locale);
    return line.name === null
      ? { title: line.label, trailing: null, description: "" }
      : {
          title: line.name,
          trailing: line.version,
          description: joined(line.label, line.subtitle),
        };
  }
  if (item.type === "catalog_request_decided") {
    return {
      title: displayNameOf(requestSubject(item.request), locale),
      trailing: null,
      description: joined(
        labels.decided,
        item.request.status === "approved" ? labels.approved : labels.rejected,
      ),
    };
  }
  return {
    title: toolLabelText(approvalToolLabel(item.approval, locale)),
    trailing: null,
    description: item.approval.agent.name,
  };
}

/** 选中项的三块：内容区、Inspector、ActionRow。 */
interface Detail {
  content: ReactNode;
  inspector: ReactNode;
  actionRow: ActionRowProps;
}

type Translate = ReturnType<typeof useTranslations>;

/** 工具调用审批：参数、范围单选；批准 / 拒绝。 */
function toolApprovalDetail({
  approval,
  scope,
  setScope,
  pending,
  onDecide,
  openConversation,
  locale,
  t,
  ta,
}: {
  approval: Approval;
  scope: ApprovalScope;
  setScope(scope: ApprovalScope): void;
  pending: "approve" | "deny" | undefined;
  onDecide(decision: "approve" | "deny"): void;
  openConversation(): void;
  locale: string;
  t: Translate;
  ta: Translate;
}): Detail {
  return {
    inspector: (
      <Stack gap={16}>
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: ta("agent"), v: approval.agent.name },
            { k: t("conversation"), v: approval.conversationId },
            { k: t("requested"), v: <DateTime value={approval.createdAt} /> },
            { k: ta("expires"), v: <DateTime value={approval.expiresAt} /> },
          ]}
        />
        <Stack direction="row">
          <Button onClick={openConversation}>{t("openConversation")}</Button>
        </Stack>
      </Stack>
    ),
    actionRow: {
      secondary: {
        label: ta("deny"),
        onSelect: () => onDecide("deny"),
        loading: pending === "deny",
        disabled: pending !== undefined,
      },
      primary: {
        label: ta("approve"),
        onSelect: () => onDecide("approve"),
        loading: pending === "approve",
        disabled: pending !== undefined,
      },
    },
    content: (
      <div data-approval-id={approval.id}>
        <Card
          title={toolLabelText(approvalToolLabel(approval, locale))}
          actions={<StatusMark status="waiting" label={ta("waiting")} />}
        >
          <Stack gap={12}>
            <KeyValue
              keyWidth="10ch"
              rows={[
                { k: ta("tool"), v: approval.toolKey },
                ...(approval.connector ? [{ k: ta("connector"), v: approval.connector.name }] : []),
              ]}
            />
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {ta("input")}
              </Text>
              <ApprovalInput input={approval.input} />
            </Stack>
            <ScopePicker
              approval={approval}
              value={scope}
              onChange={setScope}
              disabled={pending !== undefined}
            />
          </Stack>
        </Card>
      </div>
    ),
  };
}

/** 技能变更（收件箱只列出当前用户作为负责人能决定的）：卡片显示差异；批准 / 拒绝。 */
function skillChangeDetail({
  orgId,
  change,
  pending,
  onDecide,
  t,
}: {
  orgId: string;
  change: SkillChange;
  pending: "approve" | "reject" | undefined;
  onDecide(decision: "approve" | "reject"): void;
  t: Translate;
}): Detail {
  return {
    inspector: (
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: t("skillChange.agent"), v: change.agent.name },
          { k: t("skillChange.requester"), v: requesterOf(change) },
          { k: t("conversation"), v: change.requestedInConversation },
          { k: t("requested"), v: <DateTime value={change.createdAt} /> },
        ]}
      />
    ),
    actionRow: {
      secondary: {
        label: t("skillChange.reject"),
        onSelect: () => onDecide("reject"),
        loading: pending === "reject",
        disabled: pending !== undefined,
      },
      primary: {
        label: t("skillChange.approve"),
        onSelect: () => onDecide("approve"),
        loading: pending === "approve",
        disabled: pending !== undefined,
      },
    },
    content: <SkillChangeReview key={change.id} orgId={orgId} change={change} />,
  };
}

/** 成员提交的目录申请（组织管理员）：条目、版本与说明；批准 / 拒绝。 */
function directoryRequestDetail({
  request,
  pending,
  onDecide,
  td,
  t,
  locale,
}: {
  request: CatalogRequest;
  pending: "approve" | "reject" | undefined;
  onDecide(decision: "approve" | "reject"): void;
  td: Translate;
  t: Translate;
  locale: string;
}): Detail {
  const subject = requestSubject(request);
  const name = displayNameOf(subject, locale);
  const version = requestVersion(request);
  return {
    inspector: (
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: td("requester"), v: directoryRequester(request) },
          { k: td("version"), v: version === null ? "—" : versionLabel(version) },
          { k: t("requested"), v: <DateTime value={request.createdAt} /> },
        ]}
      />
    ),
    actionRow: {
      secondary: {
        label: td("reject"),
        onSelect: () => onDecide("reject"),
        loading: pending === "reject",
        disabled: pending !== undefined,
      },
      primary: {
        label: td("approve"),
        onSelect: () => onDecide("approve"),
        loading: pending === "approve",
        disabled: pending !== undefined,
      },
    },
    content: (
      <Card
        title={td("title", { name })}
        actions={<StatusMark status="waiting" label={td("label")} />}
      >
        <Stack gap={8}>
          {request.note !== "" && (
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {td("note")}
              </Text>
              <Text variant="prose">{request.note}</Text>
            </Stack>
          )}
          <Text variant="small" tone="muted">
            {td("hint")}
          </Text>
          {subject.id !== null && (
            <Text>
              <Link href={`/plugins/${subject.id}`}>{td("openItem")}</Link>
            </Text>
          )}
        </Stack>
      </Card>
    ),
  };
}

/**
 * A connector setup request (org admins, ruling P4-7): the agent, the requester and the connectors
 * it still needs; 配置 opens the configure dialog (per connector: pick or create, then bind; the
 * request closes on the last bind), 驳回 sends the optional reason typed here.
 */
function setupRequestDetail({
  request,
  pending,
  reason,
  setReason,
  onConfigure,
  onReject,
  ts,
  td,
  t,
  locale,
}: {
  request: CatalogRequest;
  pending: "approve" | "reject" | undefined;
  reason: string;
  setReason(v: string): void;
  onConfigure(): void;
  onReject(): void;
  ts: Translate;
  td: Translate;
  t: Translate;
  locale: string;
}): Detail {
  const connectors = request.connectors ?? [];
  const agent = request.agent?.name ?? "—";
  return {
    inspector: (
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: td("requester"), v: directoryRequester(request) },
          { k: ts("agent"), v: agent },
          { k: ts("count"), v: String(connectors.length) },
          { k: t("requested"), v: <DateTime value={request.createdAt} /> },
        ]}
      />
    ),
    actionRow: {
      secondary: {
        label: ts("reject"),
        onSelect: onReject,
        loading: pending === "reject",
        disabled: pending !== undefined,
      },
      primary: {
        label: ts("configure"),
        onSelect: onConfigure,
        disabled: pending !== undefined || connectors.length === 0,
      },
    },
    content: (
      <Card
        title={ts("title", { agent })}
        actions={<StatusMark status="waiting" label={ts("label")} />}
      >
        <Stack gap={12}>
          <Text variant="prose">{ts("hint")}</Text>
          <ItemList
            label={ts("connectors")}
            rows={connectors.map((c) => ({
              id: c.key,
              title: c.label,
              meta:
                "template" in c.source
                  ? ts("fromTemplate", {
                      name:
                        c.source.template.displayName !== null
                          ? displayNameOf(
                              { name: c.label, displayName: c.source.template.displayName },
                              locale,
                            )
                          : c.label,
                    })
                  : ts("needs", {
                      protocol: c.source.needs.protocol,
                      endpoint: c.source.needs.endpoint,
                    }),
            }))}
          />
          <Field label={ts("reasonLabel")} optional help={ts("reasonHelp")}>
            <Textarea
              name="reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </Stack>
      </Card>
    ),
  };
}

/**
 * My connector setup request, decided (the agent's owner): every connector configured
 * (`approved`), or rejected with the reason; a link to the agent's Tools section; dismiss.
 */
function setupDecidedDetail({
  request,
  pending,
  onDismiss,
  ts,
  tdd,
  t,
}: {
  request: CatalogRequest;
  pending: boolean;
  onDismiss(): void;
  ts: Translate;
  tdd: Translate;
  t: Translate;
}): Detail {
  const approved = request.status === "approved";
  const agent = request.agent;
  const name = agent?.name ?? "—";
  return {
    inspector: (
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: tdd("status"), v: approved ? tdd("approved") : tdd("rejected") },
          { k: ts("agent"), v: name },
          { k: t("requested"), v: <DateTime value={request.createdAt} /> },
          ...(request.decidedAt !== null
            ? [{ k: tdd("decidedAt"), v: <DateTime value={request.decidedAt} /> }]
            : []),
        ]}
      />
    ),
    actionRow: {
      primary: { label: tdd("dismiss"), onSelect: onDismiss, loading: pending, disabled: pending },
    },
    content: (
      <Card
        title={ts(approved ? "titleApproved" : "titleRejected", { agent: name })}
        actions={
          <StatusMark
            status={approved ? "success" : "failed"}
            label={approved ? tdd("approved") : tdd("rejected")}
          />
        }
      >
        <Stack gap={8}>
          <Text variant="prose">{approved ? ts("hintApproved") : ts("hintRejected")}</Text>
          {!approved && request.reason !== null && request.reason !== "" && (
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {tdd("reason")}
              </Text>
              <Text variant="prose">{request.reason}</Text>
            </Stack>
          )}
          {agent !== null && agent !== undefined && !agent.deleted && (
            <Text>
              <Link href={`/agents/${encodeURIComponent(agent.id)}?s=tools`}>
                {ts("openAgent")}
              </Link>
            </Text>
          )}
        </Stack>
      </Card>
    ),
  };
}

/** My request, decided: approved (it is usable now) or rejected with the reason; dismiss. */
function decidedRequestDetail({
  request,
  pending,
  onDismiss,
  tdd,
  t,
  locale,
}: {
  request: CatalogRequest;
  pending: boolean;
  onDismiss(): void;
  tdd: Translate;
  t: Translate;
  locale: string;
}): Detail {
  const subject = requestSubject(request);
  const name = displayNameOf(subject, locale);
  const approved = request.status === "approved";
  return {
    inspector: (
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: tdd("status"), v: approved ? tdd("approved") : tdd("rejected") },
          { k: t("requested"), v: <DateTime value={request.createdAt} /> },
          ...(request.decidedAt !== null
            ? [{ k: tdd("decidedAt"), v: <DateTime value={request.decidedAt} /> }]
            : []),
        ]}
      />
    ),
    actionRow: {
      primary: { label: tdd("dismiss"), onSelect: onDismiss, loading: pending, disabled: pending },
    },
    content: (
      <Card
        title={tdd(approved ? "titleApproved" : "titleRejected", { name })}
        actions={
          <StatusMark
            status={approved ? "success" : "failed"}
            label={approved ? tdd("approved") : tdd("rejected")}
          />
        }
      >
        <Stack gap={8}>
          <Text variant="prose">{approved ? tdd("hintApproved") : tdd("hintRejected")}</Text>
          {!approved && request.reason !== null && request.reason !== "" && (
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {tdd("reason")}
              </Text>
              <Text variant="prose">{request.reason}</Text>
            </Stack>
          )}
          {subject.id !== null && (
            <Text>
              <Link href={`/plugins/${encodeURIComponent(subject.id)}`}>{tdd("openItem")}</Link>
            </Text>
          )}
        </Stack>
      </Card>
    ),
  };
}

/** A renamed skill (org admins): what happened and why; dismiss. */
function noticeDetail({
  notice,
  pending,
  onDismiss,
  tn,
  tnn,
  t,
  locale,
}: {
  locale: string;
  notice: OrgNotice;
  pending: boolean;
  onDismiss(): void;
  tn: Translate;
  tnn: Translate;
  t: Translate;
}): Detail {
  if (notice.kind !== "skill_renamed") {
    const line = noticeLine(notice, tnn, locale);
    return {
      inspector: (
        <KeyValue
          keyWidth="10ch"
          rows={[...line.rows, { k: t("requested"), v: <DateTime value={notice.createdAt} /> }]}
        />
      ),
      actionRow: {
        primary: {
          label: tnn("dismiss"),
          onSelect: onDismiss,
          loading: pending,
          disabled: pending,
        },
      },
      content: (
        <Card title={line.title}>
          <Text variant="prose">{line.hint}</Text>
        </Card>
      ),
    };
  }
  const r = notice.skillRenamed;
  return {
    inspector: (
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: tn("from"), v: r.from },
          { k: tn("to"), v: r.to },
          ...(r.plugin !== null ? [{ k: tn("plugin"), v: r.plugin }] : []),
          { k: t("requested"), v: <DateTime value={notice.createdAt} /> },
        ]}
      />
    ),
    actionRow: {
      primary: {
        label: tn("dismiss"),
        onSelect: onDismiss,
        loading: pending,
        disabled: pending,
      },
    },
    content: (
      <Card title={tn("title", { from: r.from, to: r.to })}>
        <Text variant="prose">{tn("hint", { from: r.from, to: r.to })}</Text>
      </Card>
    ),
  };
}

/**
 * The texts of an org notice other than `skill_renamed`: the row label, the item name (null for a
 * kind this app does not know), the row's second line, the detail's title, hint and key rows. A
 * kind or a detail it does not know reads generically.
 */
function noticeLine(
  notice: OrgNotice,
  tnn: Translate,
  locale: string,
): {
  label: string;
  name: string | null;
  /** The version the row shows beside the name (`v0.1.0`), null when it has none. */
  version: string | null;
  subtitle: string;
  title: string;
  hint: string;
  rows: { k: string; v: string }[];
} {
  const unknown = {
    label: tnn("unknownLabel"),
    name: null,
    version: null,
    subtitle: "",
    title: tnn("unknownTitle"),
    hint: "",
    rows: [],
  };
  const d: Record<string, unknown> =
    "detail" in notice && typeof notice.detail === "object" && notice.detail !== null
      ? (notice.detail as unknown as Record<string, unknown>)
      : {};
  const id = typeof d.name === "string" ? d.name : null;
  if (id === null) return unknown;
  const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  // A plugin is named by its display name when the notice carries one (upload notices)
  const dn = d.displayName as { zh?: unknown; en?: unknown } | null | undefined;
  const localized = dn?.[locale === "zh" ? "zh" : "en"];
  const name = typeof localized === "string" && localized !== "" ? localized : id;
  const v = (x: unknown) => (typeof x === "string" && x !== "" ? versionLabel(x) : "");
  switch (notice.kind) {
    case "item_shared": {
      const org = d.org;
      const orgName =
        org === "all_orgs"
          ? tnn("allOrgs")
          : typeof org === "object" && org !== null
            ? text((org as { name?: unknown }).name)
            : "";
      return {
        label: tnn("itemSharedLabel"),
        name,
        version: null,
        subtitle: orgName,
        title:
          org === "all_orgs"
            ? tnn("itemSharedAllTitle", { name })
            : tnn("itemSharedTitle", { name, org: orgName }),
        hint: tnn("itemSharedHint"),
        rows: [
          { k: tnn("item"), v: name },
          { k: tnn("org"), v: orgName },
        ],
      };
    }
    case "shared_item_updated": {
      const from = v(d.from);
      const to = v(d.to);
      const o = d.owner as { kind?: string; name?: string } | undefined;
      const owner = o?.kind === "org" ? text(o.name) : tnn("ownerPlatform");
      return {
        label: tnn("sharedItemUpdatedLabel"),
        name,
        version: to === "" ? null : to,
        subtitle: owner,
        title: tnn("sharedItemUpdatedTitle", { owner, name, from, to }),
        hint: tnn("sharedItemUpdatedHint"),
        rows: [
          { k: tnn("item"), v: name },
          { k: tnn("owner"), v: owner },
          { k: tnn("from"), v: from },
          { k: tnn("to"), v: to },
        ],
      };
    }
    case "upload_confirmed": {
      const version = v(d.version);
      return {
        label: tnn("uploadConfirmedLabel"),
        name,
        version: version === "" ? null : version,
        subtitle: "",
        title: tnn("uploadConfirmedTitle", { name, version }),
        hint: tnn("uploadConfirmedHint"),
        rows: [
          { k: tnn("item"), v: name },
          { k: tnn("version"), v: version },
        ],
      };
    }
    case "upload_rejected": {
      const version = v(d.version);
      // the reason is said only when the super admin gave one
      const reason = typeof d.reason === "string" && d.reason.trim() !== "" ? d.reason : null;
      return {
        label: tnn("uploadRejectedLabel"),
        name,
        version: version === "" ? null : version,
        subtitle: "",
        title: tnn("uploadRejectedTitle", { name, version }),
        hint: tnn("uploadRejectedHint"),
        rows: [
          { k: tnn("item"), v: name },
          { k: tnn("version"), v: version },
          ...(reason !== null ? [{ k: tnn("reason"), v: reason }] : []),
        ],
      };
    }
    default:
      return unknown;
  }
}
