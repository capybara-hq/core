"use client";

import { Button, DataTable, SettingsPage, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useAuditColumns, useAuditPages } from "../../../../components/audit-log";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import type { AuditEvent, AuditPage } from "../../../../lib/admin";
import { usePageQuery } from "../../../../lib/query/page-query";
import { orgAuditQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/settings/audit`: the org's audit log (SettingsPage, group Organization; `org.update`, org admins): the
 * org's own events, newest first, in the admin console's audit table, Load more by cursor. The first
 * page comes from the query cache (the layout prefetched it on a first load); later pages are read
 * through the cache and appended.
 */
export default function OrgAuditView() {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <OrgAudit orgId={ws.orgId} />;
}

function OrgAudit({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("orgAudit");
  const nav = useOrgSettingsNav();
  const columns = useAuditColumns();
  const read = usePageQuery(orgAuditQuery(orgId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  return (
    <SettingsPage
      header={{
        path: [...scope, { label: "settings", href: "/settings/organization" }, { label: "audit" }],
        title: t("title"),
        description: t("description"),
      }}
      nav={nav}
      activeNav="audit"
    >
      {read.kind === "ready" ? (
        <AuditTable orgId={orgId} first={read.data} />
      ) : (
        <DataTable<AuditEvent>
          label={t("title")}
          columns={columns}
          rows={[]}
          rowKey={(e) => e.id}
          state="loading"
        />
      )}
    </SettingsPage>
  );
}

function AuditTable({ orgId, first }: { orgId: string; first: AuditPage }) {
  const t = useTranslations("orgAudit");
  const columns = useAuditColumns();
  const { rows, next, loadingMore, loadMore } = useAuditPages(first, (after) =>
    orgAuditQuery(orgId, after),
  );
  return (
    <Stack gap={12}>
      <DataTable<AuditEvent>
        label={t("title")}
        columns={columns}
        rows={rows}
        rowKey={(e) => e.id}
        state="ready"
        empty={{ title: t("empty"), hint: t("emptyHint") }}
      />
      {next !== null && (
        <Stack direction="row">
          <Button loading={loadingMore} onClick={loadMore}>
            {t("loadMore")}
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
