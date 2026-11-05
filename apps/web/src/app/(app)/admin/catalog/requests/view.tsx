"use client";

import {
  Card,
  type Column,
  DataTable,
  DateTime,
  InboxPage,
  KeyValue,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { FormError } from "../../../../../components/form-error";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { Link } from "../../../../../i18n/navigation";
import { catalogTabs } from "../../../../../lib/admin-tabs";
import {
  type CatalogRequest,
  decideDeploymentRequest,
  displayNameOf,
  requesterOf,
} from "../../../../../lib/catalog";
import { deploymentRequestsQuery } from "../../../../../lib/query/admin";
import { keys } from "../../../../../lib/query/keys";
import { useAppMutation } from "../../../../../lib/query/mutation";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import NotFound from "../../../not-found";

/**
 * `/admin/catalog/requests`: deployment-stage catalog requests (enterprise admins,
 * InboxPage). Org requests to install an item that needs approval (or member requests forwarded once
 * an org admin approved them) appear here; approving grants the item to that org (for every
 * version), rejecting ends the request. From the query cache (the layout prefetched the requests
 * on a first load); a decision reads the pending requests (and the overview's count) again.
 */
export default function RequestsView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <RequestsRead />;
}

type T = ReturnType<typeof useTranslations<"catalog.admin.requests">>;

/** The list's columns (the loading table draws the same header). */
const requestColumns = (t: T, title: (r: CatalogRequest) => string): Column<CatalogRequest>[] => [
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
    cell: (r) => <DateTime value={r.createdAt} />,
  },
];

function RequestsRead() {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin.requests");
  const ta = useTranslations("catalog.admin");
  const read = usePageQuery(deploymentRequestsQuery());
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <InboxPage
        header={{
          path: [...scope, { label: "catalog", href: "/admin/catalog" }, { label: "requests" }],
          title: ta("title"),
          tabs: catalogTabs(ta, { requests: 0 }),
          activeTab: "requests",
        }}
        loading={{
          list: "records",
          table: {
            label: t("listLabel"),
            columns: requestColumns(t, () => "") as Column<never>[],
            rowHeight: "dense",
            framed: false,
          },
          inspector: { rows: 4, keyWidth: "12ch" },
        }}
        // The loaded page opens its first request: the inspector (its facts) and the decision row
        inspectorTitle={t("inspectorTitle")}
        actionRow={{
          secondary: { label: t("reject"), onSelect: () => {} },
          primary: { label: t("approve"), onSelect: () => {} },
        }}
      />
    );
  }
  return <Requests rows={read.data.requests} />;
}

function Requests({ rows }: { rows: CatalogRequest[] }) {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin.requests");
  const ta = useTranslations("catalog.admin");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  // A decision ends the request (or forwards it): the pending requests and the overview's count
  // are read again.
  const decision = useAppMutation({
    fn: (v: { id: string; decision: "approve" | "reject" }) =>
      decideDeploymentRequest(v.id, v.decision),
    invalidates: () => [keys.deployment().catalogRequests(), keys.deployment().adminOverview()],
  });
  const [activeId, setActiveId] = useState<string>();
  const active = rows.find((r) => r.id === activeId) ?? rows[0];
  const [pending, setPending] = useState<"approve" | "reject">();
  const [error, setError] = useState<string>();
  const title = (r: CatalogRequest) => `${r.orgName} · ${displayNameOf(r.item, locale)}`;

  const decide = async (r: CatalogRequest, d: "approve" | "reject") => {
    setPending(d);
    setError(undefined);
    try {
      await decision.mutateAsync({ id: r.id, decision: d });
      toast.success(d === "approve" ? t("approved") : t("rejected"));
    } catch (e) {
      setError(errorMessage(e));
      // Decided elsewhere meanwhile, say: the list as it is now.
      void qc.invalidateQueries({ queryKey: keys.deployment().catalogRequests() });
    } finally {
      setPending(undefined);
      setActiveId(undefined);
    }
  };

  const columns = requestColumns(t, title);

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
                  {
                    k: t("fields.version"),
                    v: active.version == null ? "—" : versionLabel(active.version),
                  },
                  { k: t("fields.requested"), v: <DateTime value={active.createdAt} /> },
                  ...(active.orgDecidedAt !== null
                    ? [{ k: t("fields.orgApproved"), v: <DateTime value={active.orgDecidedAt} /> }]
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
                  <Text variant="prose">{active.note}</Text>
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
