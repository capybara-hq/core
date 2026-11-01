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
import { useState, useTransition } from "react";
import { formatTime } from "../../../../../components/ApprovalCard";
import { FormError } from "../../../../../components/form-error";
import { usePagePath } from "../../../../../components/shell/path";
import { Link, useRouter } from "../../../../../i18n/navigation";
import { catalogTabs } from "../../../../../lib/admin-tabs";
import {
  type CatalogRequest,
  decideDeploymentRequest,
  displayNameOf,
  requesterOf,
} from "../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../lib/use-error-message";

/**
 * `/admin/catalog/requests`: deployment-stage catalog requests (enterprise admins,
 * InboxPage). Org requests to install an item that needs approval (or member requests forwarded once
 * an org admin approved them) appear here; approving grants the item to that org (for every
 * version), rejecting ends the request.
 */
export default function Requests({ initial }: { initial: CatalogRequest[] }) {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin.requests");
  const ta = useTranslations("catalog.admin");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [, startTransition] = useTransition();
  // A decision re-renders the page on the server, which reads the pending requests again.
  const reload = () => startTransition(() => router.refresh());
  const rows = initial;
  const [activeId, setActiveId] = useState<string>();
  const active = rows.find((r) => r.id === activeId) ?? rows[0];
  const [pending, setPending] = useState<"approve" | "reject">();
  const [error, setError] = useState<string>();
  const title = (r: CatalogRequest) => `${r.orgName} · ${displayNameOf(r.item, locale)}`;

  const decide = async (r: CatalogRequest, decision: "approve" | "reject") => {
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

  const columns: Column<CatalogRequest>[] = [
    {
      key: "request",
      header: t("columns.request"),
      cell: (r) => (
        <Stack gap={0}>
          <Text>{title(r)}</Text>
          <Text variant="small" tone="muted">
            {r.item.name}
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
        path: [...scope, { label: "catalog", href: "/admin/catalog" }, { label: "requests" }],
        title: ta("title"),
        tabs: catalogTabs(ta, { requests: rows.length }),
        activeTab: "requests",
      }}
      {...(rows.length === 0 ? { empty: { text: t("empty"), hint: t("emptyHint") } } : {})}
      list={
        <DataTable<CatalogRequest>
          label={t("listLabel")}
          rowHeight="dense"
          framed={false}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          rowLabel={title}
          {...(active ? { activeKey: active.id } : {})}
          onOpen={(r) => setActiveId(r.id)}
          state="ready"
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
                  { k: t("fields.requester"), v: requesterOf(active) },
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
                <Link href={`/admin/catalog/${active.item.id}`}>
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
        ) : rows.length > 0 ? (
          <Text tone="muted">{t("pick")}</Text>
        ) : null}
      </Stack>
    </InboxPage>
  );
}
