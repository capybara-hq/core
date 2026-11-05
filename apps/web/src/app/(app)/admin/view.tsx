"use client";

import { Callout, OverviewPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { adminOverviewQuery } from "../../../lib/query/admin";
import { usePageQuery } from "../../../lib/query/page-query";
import { useAdmin } from "../../../lib/query/workspace";
import NotFound from "../not-found";

/**
 * `/admin`: the admin console overview (super admins, OverviewPage). Four header numbers,
 * each linking to its page: extensions needing action, pending catalog requests, orgs, accounts.
 * The sidebar is the way to the other pages, so the body holds only the quiet note that
 * super admins cannot read conversations. From the query cache (the layout prefetched the
 * numbers on a first load); while they load the note stays and the numbers are stat slots.
 */
export default function AdminOverviewView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminOverview />;
}

function AdminOverview() {
  const scope = usePagePath("admin");
  const t = useTranslations("admin");
  const read = usePageQuery(adminOverviewQuery());
  const value = (n: number) => n.toLocaleString("en-US");
  const header = { path: [...scope], title: t("title"), description: t("overview.intro") };
  const note = <Callout tone="info">{t("overview.noConversations")}</Callout>;
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <OverviewPage header={header} loading={{ stats: 4, keep: true }}>
        {note}
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
            label: t("overview.metrics.extensions"),
            value: value(data.extensionsNeedingAction),
            href: "/admin/extensions",
          },
          {
            label: t("overview.metrics.catalogRequests"),
            value: value(data.catalogRequestsPending),
            href: "/admin/plugins/pending",
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
      {note}
    </OverviewPage>
  );
}
