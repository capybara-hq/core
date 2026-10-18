"use client";

import {
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
import { useEffect, useState } from "react";
import {
  ApprovalInput,
  formatTime,
  ScopePicker,
  useDecide,
} from "../../../../components/ApprovalCard";
import { OrgGate } from "../../../../components/OrgGate";
import { useRouter } from "../../../../i18n/navigation";
import { type Approval, type ApprovalScope, listApprovals } from "../../../../lib/approvals";
import { useLoad } from "../../../../lib/use-load";

/** `/[locale]/inbox`：待我处理的工具调用审批（InboxPage：Rail 列表、内容区详情、ActionRow 决策）。 */
export default function InboxRoute() {
  return <OrgGate>{(orgId) => <Inbox orgId={orgId} />}</OrgGate>;
}

function Inbox({ orgId }: { orgId: string }) {
  const t = useTranslations("inbox");
  const ta = useTranslations("approval");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const { state, reload } = useLoad(
    () => listApprovals(orgId, "pending").then((r) => r.approvals),
    [orgId],
  );
  const rows = state.kind === "ready" ? state.data : [];
  const [activeId, setActiveId] = useState<string>();
  const [scope, setScope] = useState<ApprovalScope>("once");
  const { decide, pending } = useDecide(orgId);
  const active = rows.find((a) => a.id === activeId) ?? rows[0];
  useStatusBar(state.kind === "ready" ? `· ${t("pendingCount", { n: rows.length })}` : null);

  // 换一条审批时范围回到「仅本次」
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在选中项变化时重置
  useEffect(() => setScope("once"), [active?.id]);

  async function onDecide(decision: "approve" | "deny") {
    if (!active) return;
    const r = await decide(active.id, decision, scope);
    // 已被别人处理等错误也重读列表：那条审批不再待处理
    if (r) toast.success(decision === "approve" ? t("approved") : t("denied"));
    setActiveId(undefined);
    reload();
  }

  const columns: Column<Approval>[] = [
    {
      key: "request",
      header: t("columns.request"),
      cell: (a) => (
        <Stack gap={0}>
          <Text>{a.app ? `${a.app.name} · ${a.toolName}` : a.toolName}</Text>
          <Text variant="small" tone="muted">
            {a.agent.name}
          </Text>
        </Stack>
      ),
    },
    {
      key: "at",
      header: t("columns.time"),
      tone: "muted",
      cell: (a) => formatTime(a.createdAt, locale),
    },
  ];

  return (
    <InboxPage
      header={{
        title: t("title"),
        ...(state.kind === "ready" ? { count: String(rows.length) } : {}),
      }}
      list={
        <DataTable<Approval>
          label={t("listLabel")}
          density="compact"
          framed={false}
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          rowLabel={(a) => a.toolName}
          {...(active ? { activeKey: active.id } : {})}
          onOpen={(a) => setActiveId(a.id)}
          state={state.kind === "ready" ? "ready" : state.kind}
          {...(state.kind === "error" ? { error: { code: state.code, onRetry: reload } } : {})}
          empty={{ title: t("empty"), hint: t("emptyHint") }}
        />
      }
      {...(active
        ? {
            inspectorTitle: t("inspectorTitle"),
            inspector: (
              <Stack gap={16}>
                <KeyValue
                  keyWidth="10ch"
                  rows={[
                    { k: ta("agent"), v: active.agent.name },
                    { k: t("conversation"), v: active.conversationId },
                    { k: t("requested"), v: formatTime(active.createdAt, locale) },
                    { k: ta("expires"), v: formatTime(active.expiresAt, locale) },
                  ]}
                />
                <Stack direction="row">
                  <Button onClick={() => router.push(active.conversationPath)}>
                    {t("openConversation")}
                  </Button>
                </Stack>
              </Stack>
            ),
            actionRow: {
              secondary: {
                label: ta("deny"),
                onSelect: () => void onDecide("deny"),
                loading: pending === "deny",
                disabled: pending !== undefined,
              },
              primary: {
                label: ta("approve"),
                onSelect: () => void onDecide("approve"),
                loading: pending === "approve",
                disabled: pending !== undefined,
              },
            },
          }
        : {})}
    >
      {active ? (
        <div data-approval-id={active.id}>
          <Card
            title={active.app ? `${active.app.name} · ${active.toolName}` : active.toolName}
            actions={<StatusMark status="waiting" label={ta("waiting")} />}
          >
            <Stack gap={12}>
              <KeyValue
                keyWidth="10ch"
                rows={[
                  { k: ta("tool"), v: active.toolKey },
                  ...(active.app ? [{ k: ta("app"), v: active.app.name }] : []),
                ]}
              />
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {ta("input")}
                </Text>
                <ApprovalInput input={active.input} />
              </Stack>
              <ScopePicker
                approval={active}
                value={scope}
                onChange={setScope}
                disabled={pending !== undefined}
              />
            </Stack>
          </Card>
        </div>
      ) : state.kind === "ready" && rows.length > 0 ? (
        <Text tone="muted">{t("pick")}</Text>
      ) : null}
    </InboxPage>
  );
}
