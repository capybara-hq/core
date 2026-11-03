"use client";

import {
  type ActionRowProps,
  Button,
  Card,
  type Column,
  DataTable,
  DateTime,
  InboxPage,
  KeyValue,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { ApprovalInput, ScopePicker, useDecide } from "../../../components/ApprovalCard";
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
  displayNameOf,
} from "../../../lib/catalog";
import type { InboxItem } from "../../../lib/inbox";
import { useAppMutation } from "../../../lib/query/define";
import { inboxChangeKeys, inboxQuery } from "../../../lib/query/inbox";
import { keys } from "../../../lib/query/keys";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import type { SkillChange } from "../../../lib/skills";
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
  const rows = (inbox?.items ?? []).filter((i) => !decided.has(subjectOf(i)));
  const truncated = inbox?.truncated === true;
  const [activeId, setActiveId] = useState<string>();
  const active = rows.find((a) => a.id === activeId) ?? rows[0];
  const [scope, setScope] = useState<ApprovalScope>("once");
  const approvals = useDecide(orgId);
  const changes = useDecideSkillChange(orgId);
  const td = useTranslations("catalog.inbox");
  const errorMessage = useErrorMessage();
  const [requestPending, setRequestPending] = useState<"approve" | "reject">();
  // A catalog request decision changes the catalog's view of the item (the inbox is read again by
  // `handled`, whatever the answer).
  const decideRequestMutation = useAppMutation({
    fn: (v: { id: string; decision: "approve" | "reject" }) =>
      decideOrgRequest(orgId, v.id, v.decision),
    invalidates: () => [keys.org(orgId).catalog(), keys.org(orgId).catalogItemsAll()],
  });
  useStatusBar(`· ${t("pendingCount", { n: rows.length })}`);

  // 换一项时审批范围回到「仅本次」
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在选中项变化时重置
  useEffect(() => setScope("once"), [active?.id]);

  const columns: Column<InboxItem>[] = [
    {
      key: "request",
      header: t("columns.request"),
      cell: (item) => (
        <Stack gap={0}>
          <Text>{titleOf(item, t("skillChange.label"), td("label"), locale)}</Text>
          <Text variant="small" tone="muted">
            {item.type === "tool_approval"
              ? item.approval.agent.name
              : item.type === "skill_change"
                ? item.skillChange.agent.name
                : item.request.item.name}
          </Text>
        </Stack>
      ),
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
   * hidden, the inbox is read again, and the first item is selected.
   */
  const handled = (id: string, message: string | null) => {
    if (message !== null) toast.success(message);
    setDecided((s) => new Set(s).add(id));
    setActiveId(undefined);
    for (const queryKey of inboxChangeKeys(orgId)) void qc.invalidateQueries({ queryKey });
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

  async function decideRequest(request: CatalogRequest, decision: "approve" | "reject") {
    setRequestPending(decision);
    try {
      await decideRequestMutation.mutateAsync({ id: request.id, decision });
      handled(request.id, decision === "approve" ? td("approved") : td("rejected"));
    } catch (e) {
      toast.error(errorMessage(e));
      handled(request.id, null);
    } finally {
      setRequestPending(undefined);
    }
  }

  const detail: Detail | null =
    active === undefined
      ? null
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
        loading={{
          list: "records",
          table: { label: t("listLabel"), columns, rowHeight: "dense", framed: false },
        }}
      />
    );
  }
  return (
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
          rowLabel={(a) => titleOf(a, t("skillChange.label"), td("label"), locale)}
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
  );
}

/** The id of what an item asks to decide (the approval, the skill change, the request). */
const subjectOf = (i: InboxItem): string =>
  i.type === "tool_approval"
    ? i.approval.id
    : i.type === "skill_change"
      ? i.skillChange.id
      : i.request.id;

/**
 * 列表里的一行标题：工具审批为「连接器 · 工具」，技能变更为「技能变更 · 名称」，目录申请为「目录申请 · 条目」。
 */
function titleOf(
  item: InboxItem,
  skillChangeLabel: string,
  requestLabel: string,
  locale: string,
): string {
  if (item.type === "skill_change") return `${skillChangeLabel} · ${item.skillChange.name}`;
  if (item.type === "catalog_request") {
    return `${requestLabel} · ${displayNameOf(item.request.item, locale)}`;
  }
  const a = item.approval;
  return a.connector ? `${a.connector.name} · ${a.toolName}` : a.toolName;
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
  t,
  ta,
}: {
  approval: Approval;
  scope: ApprovalScope;
  setScope(scope: ApprovalScope): void;
  pending: "approve" | "deny" | undefined;
  onDecide(decision: "approve" | "deny"): void;
  openConversation(): void;
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
          title={
            approval.connector
              ? `${approval.connector.name} · ${approval.toolName}`
              : approval.toolName
          }
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
  const name = displayNameOf(request.item, locale);
  return {
    inspector: (
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: td("requester"), v: directoryRequester(request) },
          { k: td("version"), v: request.version == null ? "—" : versionLabel(request.version) },
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
          <Text>
            <Link href={`/catalog/${request.item.id}`}>{td("openItem")}</Link>
          </Text>
        </Stack>
      </Card>
    ),
  };
}
