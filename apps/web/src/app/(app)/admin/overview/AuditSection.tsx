"use client";

import {
  CellTitle,
  type Column,
  DataTable,
  DateTime,
  EmptyState,
  LinkButton,
  OverviewSection,
  Text,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { PlatformAuditEvent } from "../../../../lib/admin";
import { platformAuditQuery } from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { auditActionKey } from "./audit-actions";

/** How many events the overview shows (the rest are on `/admin/audit`). */
const OVERVIEW_ROWS = 10;

/**
 * The platform audit table's columns, shared by the overview and `/admin/audit` (spec §6.4): 时间,
 * 操作者 (the name, 系统 for the kernel, with 经由智能体 / 个人令牌 under it), 操作 (its label, or the
 * raw action in mono when it has none) and 对象 (mono).
 */
export function useAuditColumns(): Column<PlatformAuditEvent>[] {
  const t = useTranslations("admin.audit");
  return [
    {
      key: "at",
      header: t("columns.time"),
      tone: "muted",
      fit: true,
      cell: (e) => <DateTime value={e.at} />,
    },
    {
      key: "actor",
      header: t("columns.actor"),
      cell: (e) => {
        const name =
          e.actor === null ? t("system") : (e.actor.name ?? e.actor.email ?? t("deletedAccount"));
        const via = [
          ...(e.viaAgent ? [t("viaAgent")] : []),
          ...(e.viaToken ? [t("viaToken")] : []),
        ].join(" · ");
        return <CellTitle title={name} {...(via !== "" ? { description: via } : {})} />;
      },
    },
    {
      key: "action",
      header: t("columns.action"),
      cell: (e) => {
        const key = auditActionKey(e.action);
        return key === null ? (
          <Text variant="body">{e.action}</Text>
        ) : (
          <Text variant="prose">{t(`actions.${key}`)}</Text>
        );
      },
    },
    {
      key: "target",
      header: t("columns.target"),
      tone: "muted",
      cell: (e) => <Text variant="body">{e.target ?? "—"}</Text>,
    },
  ];
}

/**
 * 最近的平台操作 (spec §6.4): the newest ten platform-level audit events in an unframed table, and
 * 查看全部 to `/admin/audit`. Its own read (the layout prefetched it on a first load), its own
 * loading and error state.
 */
export function AuditSection() {
  const t = useTranslations("admin.overview.audit");
  const ta = useTranslations("admin.audit");
  const errorMessage = useErrorMessage();
  const q = platformAuditQuery();
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  const columns = useAuditColumns();
  const actions = (
    <LinkButton href="/admin/audit" density="dense">
      {t("viewAll")}
    </LinkButton>
  );
  if (read.data === undefined) {
    return read.error ? (
      <OverviewSection
        title={t("title")}
        actions={actions}
        state="error"
        error={{
          summary: t("failed"),
          detail: errorMessage(read.error),
          onRetry: () => void read.refetch(),
        }}
      />
    ) : (
      <OverviewSection
        title={t("title")}
        actions={actions}
        state="loading"
        loading={[{ kind: "table", label: t("title"), columns }]}
      />
    );
  }
  const rows = read.data.events.slice(0, OVERVIEW_ROWS);
  return (
    <OverviewSection title={t("title")} actions={actions} state="ready">
      {rows.length === 0 ? (
        <EmptyState size="panel" text={ta("empty")} />
      ) : (
        <DataTable<PlatformAuditEvent>
          label={t("title")}
          rowHeight="dense"
          framed={false}
          columns={columns}
          rows={rows}
          rowKey={(e) => e.id}
          state="ready"
        />
      )}
    </OverviewSection>
  );
}
