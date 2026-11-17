"use client";

import { DataTable, EmptyState, LinkButton, OverviewSection } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAuditColumns } from "../../../../components/audit-log";
import type { AuditEvent } from "../../../../lib/admin";
import { platformAuditQuery } from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** How many events the overview shows (the rest are on `/admin/audit`). */
const OVERVIEW_ROWS = 10;

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
        <DataTable<AuditEvent>
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
