"use client";

import { OverviewPage, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { adminOverviewQuery } from "../../../lib/query/admin";
import { usePageQuery } from "../../../lib/query/page-query";
import { useAdmin } from "../../../lib/query/workspace";
import NotFound from "../not-found";
import { AttentionSection } from "./overview/AttentionSection";
import { AuditSection } from "./overview/AuditSection";
import { HealthSection } from "./overview/HealthSection";

/**
 * `/admin`: the admin console overview (super admins, OverviewPage; spec
 * 2026-11-11-admin-overview-design.md §3). The header's numbers (待处理, linking to the inbox, then
 * orgs and accounts), then one section per part, each on its own read with its own loading and
 * error state, so one failing source never blanks the page: 待处理 (the inbox by type and the
 * attention lists), 运行状况 (replicas, queues, connections; polled every 30 s) and 最近的平台操作;
 * the privacy footnote last. From the query cache: the layout prefetched the numbers, the inbox
 * and the audit events on a first load; the attention lists and the health load in their section.
 */
export default function AdminOverviewView({
  pollHealth = true,
}: {
  /** Whether 运行状况 polls (off on the seeded /dev/ui page, which has no kernel behind it). */
  pollHealth?: boolean;
}) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminOverview pollHealth={pollHealth} />;
}

function AdminOverview({ pollHealth }: { pollHealth: boolean }) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin");
  const read = usePageQuery(adminOverviewQuery());
  const value = (n: number) => n.toLocaleString("en-US");
  const header = { path: [...scope], title: t("title"), description: t("overview.intro") };
  // An attention source could not be read: the 待处理 number leaves its items out.
  const partial = read.kind === "ready" && read.data.partial === true;
  // The sections read for themselves: they render while the numbers load.
  const sections = (
    <Stack gap={16}>
      {partial && (
        <Text variant="prose" tone="muted">
          {t("overview.partial")}
        </Text>
      )}
      <AttentionSection />
      <HealthSection poll={pollHealth} />
      <AuditSection />
      <Text variant="prose" tone="muted">
        {t("overview.footnote")}
      </Text>
    </Stack>
  );
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <OverviewPage header={header} loading={{ stats: 3, keep: true }}>
        {sections}
      </OverviewPage>
    );
  }
  const data = read.data;
  return (
    <OverviewPage
      header={{
        path: header.path,
        title: header.title,
        description: header.description,
        metrics: [
          {
            label: t("overview.metrics.attention"),
            value: value(data.attentionTotal),
            href: "/admin/inbox",
          },
          { label: t("overview.metrics.orgs"), value: value(data.orgs), href: "/admin/orgs" },
          {
            label: t("overview.metrics.accounts"),
            value: value(data.accounts),
            href: "/admin/accounts",
          },
        ],
      }}
    >
      {sections}
    </OverviewPage>
  );
}
