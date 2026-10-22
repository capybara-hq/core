"use client";

import {
  Card,
  type Column,
  DataTable,
  InboxPage,
  KeyValue,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../../../components/AdminGate";
import { formatTime } from "../../../../../../components/ApprovalCard";
import { useKindLabel } from "../../../../../../components/DirectoryParts";
import { FormError } from "../../../../../../components/form-error";
import { Link } from "../../../../../../i18n/navigation";
import {
  type DirectoryRequest,
  decideDeploymentRequest,
  displayNameOf,
  listDeploymentRequests,
} from "../../../../../../lib/directory";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

/**
 * `/[locale]/admin/directory/requests`：部署阶段的目录申请（企业管理员，InboxPage）。组织申请安装「需审批」的条目
 * （或组织管理员批准了成员申请后转来）出现在这里；批准后给该组织授予这个条目（跨版本有效），拒绝则结束申请。
 */
export default function RequestsPage() {
  return (
    <AdminGate>
      <Requests />
    </AdminGate>
  );
}

function Requests() {
  const t = useTranslations("directory.admin.requests");
  const ta = useTranslations("directory.admin");
  const locale = useLocale();
  const toast = useToast();
  const kindLabel = useKindLabel();
  const errorMessage = useErrorMessage();
  const { state, reload } = useLoad(listDeploymentRequests, []);
  const rows = state.kind === "ready" ? state.data.requests : [];
  const [activeId, setActiveId] = useState<string>();
  const active = rows.find((r) => r.id === activeId) ?? rows[0];
  const [pending, setPending] = useState<"approve" | "reject">();
  const [error, setError] = useState<string>();
  const title = (r: DirectoryRequest) => `${r.orgName} · ${displayNameOf(r.item, locale)}`;

  const decide = async (r: DirectoryRequest, decision: "approve" | "reject") => {
    setPending(decision);
    setError(undefined);
    try {
      await decideDeploymentRequest(r.id, decision);
      toast.success(decision === "approve" ? t("approved") : t("rejected"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(undefined);
      setActiveId(undefined);
      reload();
    }
  };

  const columns: Column<DirectoryRequest>[] = [
    {
      key: "request",
      header: t("columns.request"),
      cell: (r) => (
        <Stack gap={0}>
          <Text>{title(r)}</Text>
          <Text variant="small" tone="muted">
            {kindLabel(r.item.kind)}
          </Text>
        </Stack>
      ),
    },
    {
      key: "time",
      header: t("columns.time"),
      tone: "muted",
      cell: (r) => formatTime(r.createdAt, locale),
    },
  ];

  return (
    <InboxPage
      header={{
        parent: { label: ta("title"), href: "/admin/directory" },
        title: t("title"),
        ...(state.kind === "ready" && { count: String(rows.length) }),
      }}
      list={
        <DataTable<DirectoryRequest>
          label={t("listLabel")}
          density="compact"
          framed={false}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          rowLabel={title}
          {...(active ? { activeKey: active.id } : {})}
          onOpen={(r) => setActiveId(r.id)}
          state={state.kind === "ready" ? "ready" : state.kind}
          {...(state.kind === "error" ? { error: { code: state.code, onRetry: reload } } : {})}
          empty={{ title: t("empty"), hint: t("emptyHint") }}
        />
      }
      {...(active
        ? {
            inspectorTitle: t("inspectorTitle"),
            inspector: (
              <KeyValue
                keyWidth="12ch"
                rows={[
                  { k: t("fields.org"), v: active.orgName },
                  { k: t("fields.kind"), v: kindLabel(active.item.kind) },
                  { k: t("fields.version"), v: active.version ?? "—" },
                  { k: t("fields.requested"), v: formatTime(active.createdAt, locale) },
                  ...(active.orgDecidedAt !== null
                    ? [{ k: t("fields.orgApproved"), v: formatTime(active.orgDecidedAt, locale) }]
                    : []),
                ]}
              />
            ),
            actionRow: {
              secondary: {
                label: t("reject"),
                onSelect: () => void decide(active, "reject"),
                loading: pending === "reject",
                disabled: pending !== undefined,
              },
              primary: {
                label: t("approve"),
                onSelect: () => void decide(active, "approve"),
                loading: pending === "approve",
                disabled: pending !== undefined,
              },
            },
          }
        : {})}
    >
      <Stack gap={12}>
        {error !== undefined && <FormError message={error} />}
        {active ? (
          <Card title={title(active)}>
            <Stack gap={8}>
              <Text>
                <Link href={`/admin/directory/${active.item.id}`}>
                  {displayNameOf(active.item, locale)}
                </Link>
              </Text>
              {active.note !== "" && (
                <Stack gap={4}>
                  <Text variant="small" tone="muted">
                    {t("fields.note")}
                  </Text>
                  <Text>{active.note}</Text>
                </Stack>
              )}
              <Text variant="small" tone="muted">
                {t("hint")}
              </Text>
            </Stack>
          </Card>
        ) : state.kind === "ready" && rows.length > 0 ? (
          <Text tone="muted">{t("pick")}</Text>
        ) : null}
      </Stack>
    </InboxPage>
  );
}
