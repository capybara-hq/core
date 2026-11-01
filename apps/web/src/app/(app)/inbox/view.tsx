"use client";

import {
  type ActionRowProps,
  Button,
  Card,
  type Column,
  DataTable,
  InboxPage,
  KeyValue,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import {
  ApprovalInput,
  formatTime,
  ScopePicker,
  useDecide,
} from "../../../components/ApprovalCard";
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
import type { InboxItem, listInbox } from "../../../lib/inbox";
import type { SkillChange, SkillChangeDetail } from "../../../lib/skills";
import { useErrorMessage } from "../../../lib/use-error-message";

type InboxList = Awaited<ReturnType<typeof listInbox>>;

/** What the server read for the first paint: the inbox and the first item's skill change detail. */
export interface InboxData {
  inbox: InboxList;
  /** The detail of the first item when it is a skill change (it shows at once); else null. */
  firstChange: SkillChangeDetail | null;
}

/**
 * `/inbox`: what waits on me (`GET /inbox` by type): tool call approvals, skill changes of the
 * shared agents I own and catalog requests (InboxPage: the list, the detail, the ActionRow). Read
 * on the server (`page.tsx`); a decision re-renders the page there (`router.refresh()`).
 */
export default function InboxView({ orgId, initial }: { orgId: string; initial: InboxData }) {
  const here = usePagePath("org");
  const t = useTranslations("inbox");
  const locale = useLocale();
  const toast = useToast();
  const ta = useTranslations("approval");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const rows = initial.inbox.items;
  const truncated = initial.inbox.truncated === true;
  const [activeId, setActiveId] = useState<string>();
  const active = rows.find((a) => a.id === activeId) ?? rows[0];
  const [scope, setScope] = useState<ApprovalScope>("once");
  const approvals = useDecide(orgId);
  const changes = useDecideSkillChange(orgId);
  const td = useTranslations("catalog.inbox");
  const errorMessage = useErrorMessage();
  const [requestPending, setRequestPending] = useState<"approve" | "reject">();
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
      cell: (item) => formatTime(item.createdAt, locale),
    },
  ];

  /**
   * An item was handled (or failed as already handled elsewhere: it is no longer pending): the
   * server reads the page again, and the first item is selected.
   */
  const handled = (message: string | null) => {
    if (message !== null) toast.success(message);
    setActiveId(undefined);
    startTransition(() => router.refresh());
  };

  async function decideApproval(approval: Approval, decision: "approve" | "deny") {
    // 顶栏待处理数的刷新由 useDecide 负责
    const r = await approvals.decide(approval.id, decision, scope);
    handled(r ? (decision === "approve" ? t("approved") : t("denied")) : null);
  }

  async function decideChange(change: SkillChange, decision: "approve" | "reject") {
    const ok = await changes.decide(change.id, decision);
    handled(
      ok ? (decision === "approve" ? t("skillChange.approved") : t("skillChange.rejected")) : null,
    );
  }

  async function decideRequest(request: CatalogRequest, decision: "approve" | "reject") {
    setRequestPending(decision);
    try {
      await decideOrgRequest(orgId, request.id, decision);
      handled(decision === "approve" ? td("approved") : td("rejected"));
    } catch (e) {
      toast.error(errorMessage(e));
      handled(null);
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
              locale,
            })
          : skillChangeDetail({
              orgId,
              change: active.skillChange,
              initial:
                initial.firstChange?.id === active.skillChange.id ? initial.firstChange : undefined,
              pending: changes.pending,
              onDecide: (d) => void decideChange(active.skillChange, d),
              t,
              locale,
            });

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
  locale,
}: {
  approval: Approval;
  scope: ApprovalScope;
  setScope(scope: ApprovalScope): void;
  pending: "approve" | "deny" | undefined;
  onDecide(decision: "approve" | "deny"): void;
  openConversation(): void;
  t: Translate;
  ta: Translate;
  locale: string;
}): Detail {
  return {
    inspector: (
      <Stack gap={16}>
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: ta("agent"), v: approval.agent.name },
            { k: t("conversation"), v: approval.conversationId },
            { k: t("requested"), v: formatTime(approval.createdAt, locale) },
            { k: ta("expires"), v: formatTime(approval.expiresAt, locale) },
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
  initial,
  pending,
  onDecide,
  t,
  locale,
}: {
  orgId: string;
  change: SkillChange;
  initial: SkillChangeDetail | undefined;
  pending: "approve" | "reject" | undefined;
  onDecide(decision: "approve" | "reject"): void;
  t: Translate;
  locale: string;
}): Detail {
  return {
    inspector: (
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: t("skillChange.agent"), v: change.agent.name },
          { k: t("skillChange.requester"), v: requesterOf(change) },
          { k: t("conversation"), v: change.requestedInConversation },
          { k: t("requested"), v: formatTime(change.createdAt, locale) },
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
    content: <SkillChangeReview key={change.id} orgId={orgId} change={change} initial={initial} />,
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
          { k: td("version"), v: request.version ?? "—" },
          { k: t("requested"), v: formatTime(request.createdAt, locale) },
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
              <Text>{request.note}</Text>
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
