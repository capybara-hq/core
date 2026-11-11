"use client";

import { Button, DataTable, ListPage, Stack, useToast } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import type { PlatformAuditEvent, PlatformAuditPage } from "../../../../lib/admin";
import { platformAuditQuery } from "../../../../lib/query/admin";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";
import { useAuditColumns } from "../overview/AuditSection";

/**
 * `/admin/audit`: the platform-level audit log (super admins, ListPage; spec
 * 2026-11-11-admin-overview-design.md §6.4, decision D2): events with no org, newest first, in the
 * overview's table, 加载更多 by cursor, no filters. The first page comes from the query cache (the
 * layout prefetched it on a first load); later pages are read through the cache and appended.
 */
export default function AdminAuditView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminAudit />;
}

function AdminAudit() {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.audit");
  const read = usePageQuery(platformAuditQuery());
  const columns = useAuditColumns();
  const header = {
    path: [...scope, { label: "audit" }],
    title: t("title"),
    description: t("description"),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return <ListPage header={header} loading={{ table: { label: t("listLabel"), columns } }} />;
  }
  return <AuditLog header={header} first={read.data} />;
}

function AuditLog({
  header,
  first,
}: {
  header: { path: { label: string; href?: string }[]; title: string; description: string };
  first: PlatformAuditPage;
}) {
  const t = useTranslations("admin.audit");
  const qc = useQueryClient();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const columns = useAuditColumns();
  // Later pages belong to the first page they continue (a newer first page starts over).
  const [more, setMore] = useState<{ source: PlatformAuditPage; pages: PlatformAuditPage[] }>({
    source: first,
    pages: [],
  });
  const pages = more.source === first ? more.pages : [];
  const rows = [...first.events, ...pages.flatMap((p) => p.events)];
  const next = pages.length > 0 ? (pages[pages.length - 1] as PlatformAuditPage).next : first.next;
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = (after: string) => {
    setLoadingMore(true);
    qc.fetchQuery(platformAuditQuery(after))
      .then((page) => setMore({ source: first, pages: [...pages, page] }))
      .catch((e: unknown) => toast.error(errorMessage(e)))
      .finally(() => setLoadingMore(false));
  };
  return (
    <ListPage
      header={{
        path: header.path,
        title: header.title,
        description: header.description,
        count: String(rows.length) + (next === null ? "" : "+"),
      }}
      {...(rows.length === 0 ? { empty: { text: t("empty") } } : {})}
    >
      <Stack gap={12}>
        <DataTable<PlatformAuditEvent>
          label={t("listLabel")}
          columns={columns}
          rows={rows}
          rowKey={(e) => e.id}
          state="ready"
          empty={{ title: t("empty") }}
        />
        {next !== null && (
          <Stack direction="row">
            <Button loading={loadingMore} onClick={() => loadMore(next)}>
              {t("loadMore")}
            </Button>
          </Stack>
        )}
      </Stack>
    </ListPage>
  );
}
