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
import { type ReactNode, useEffect, useState } from "react";
import {
  ApprovalInput,
  formatTime,
  ScopePicker,
  useDecide,
} from "../../../../components/ApprovalCard";
import { OrgGate } from "../../../../components/OrgGate";
import {
  requesterOf,
  SkillChangeReview,
  useDecideSkillChange,
} from "../../../../components/SkillChangeReview";
import { useRouter } from "../../../../i18n/navigation";
import type { Approval, ApprovalScope } from "../../../../lib/approvals";
import { type InboxItem, listInbox } from "../../../../lib/inbox";
import type { SkillChange } from "../../../../lib/skills";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/[locale]/inbox`：待我处理的事项（`GET /inbox` 按类型汇总）——工具调用审批，以及我负责的共享 agent 的
 * 技能变更（InboxPage：Rail 列表、内容区详情、ActionRow 决策）。
 */
export default function InboxRoute() {
  return <OrgGate>{(orgId) => <Inbox orgId={orgId} />}</OrgGate>;
}

function Inbox({ orgId }: { orgId: string }) {
  const t = useTranslations("inbox");
  const locale = useLocale();
  const toast = useToast();
  const ta = useTranslations("approval");
  const router = useRouter();
  const { state, reload } = useLoad(() => listInbox(orgId), [orgId]);
  const rows = state.kind === "ready" ? state.data.items : [];
  const truncated = state.kind === "ready" && state.data.truncated;
  const [activeId, setActiveId] = useState<string>();
  const active = rows.find((a) => a.id === activeId) ?? rows[0];
  const [scope, setScope] = useState<ApprovalScope>("once");
  const approvals = useDecide(orgId);
  const changes = useDecideSkillChange(orgId);
  useStatusBar(state.kind === "ready" ? `· ${t("pendingCount", { n: rows.length })}` : null);

  // 换一项时审批范围回到「仅本次」
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在选中项变化时重置
  useEffect(() => setScope("once"), [active?.id]);

  const columns: Column<InboxItem>[] = [
    {
      key: "request",
      header: t("columns.request"),
      cell: (item) => (
        <Stack gap={0}>
          <Text>{titleOf(item, t("skillChange.label"))}</Text>
          <Text variant="small" tone="muted">
            {item.type === "tool_approval" ? item.approval.agent.name : item.skillChange.agent.name}
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

  /** 处理完一项（含已被别人处理等错误：那一项不再待处理）：重读列表，回到第一项。 */
  const handled = (message: string | null) => {
    if (message !== null) toast.success(message);
    setActiveId(undefined);
    reload();
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

  const detail: Detail | null =
    active === undefined
      ? null
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
            pending: changes.pending,
            onDecide: (d) => void decideChange(active.skillChange, d),
            t,
            locale,
          });

  return (
    <InboxPage
      header={{
        title: t("title"),
        ...(state.kind === "ready" ? { count: `${rows.length}${truncated ? "+" : ""}` } : {}),
      }}
      list={
        <DataTable<InboxItem>
          label={t("listLabel")}
          density="compact"
          framed={false}
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          rowLabel={(a) => titleOf(a, t("skillChange.label"))}
          {...(active ? { activeKey: active.id } : {})}
          onOpen={(a) => setActiveId(a.id)}
          state={state.kind === "ready" ? "ready" : state.kind}
          {...(state.kind === "error" ? { error: { code: state.code, onRetry: reload } } : {})}
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
        {detail ? (
          detail.content
        ) : state.kind === "ready" && rows.length > 0 ? (
          <Text tone="muted">{t("pick")}</Text>
        ) : null}
      </Stack>
    </InboxPage>
  );
}

/** 列表里的一行标题：工具审批为「应用 · 工具」，技能变更为「技能变更 · 名称」。 */
function titleOf(item: InboxItem, skillChangeLabel: string): string {
  if (item.type === "skill_change") return `${skillChangeLabel} · ${item.skillChange.name}`;
  const a = item.approval;
  return a.app ? `${a.app.name} · ${a.toolName}` : a.toolName;
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
          title={approval.app ? `${approval.app.name} · ${approval.toolName}` : approval.toolName}
          actions={<StatusMark status="waiting" label={ta("waiting")} />}
        >
          <Stack gap={12}>
            <KeyValue
              keyWidth="10ch"
              rows={[
                { k: ta("tool"), v: approval.toolKey },
                ...(approval.app ? [{ k: ta("app"), v: approval.app.name }] : []),
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
  locale,
}: {
  orgId: string;
  change: SkillChange;
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
    content: <SkillChangeReview key={change.id} orgId={orgId} change={change} />,
  };
}
