"use client";

import { Callout, OverviewPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { usePagePath } from "../../../components/shell/path";
import type { AdminOverview as Overview } from "../../../lib/admin";

/**
 * `/admin`: the admin console overview (enterprise admins, OverviewPage). Four header numbers,
 * each linking to its page: extensions needing action, pending catalog requests, orgs, accounts.
 * The sidebar is the way to the other pages, so the body holds only the quiet note that
 * enterprise admins cannot read conversations. The numbers are read on the server (`page.tsx`).
 */
export default function AdminOverview({ initial }: { initial: Overview }) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin");
  const data = initial;
  const value = (n: number) => n.toLocaleString("en-US");
  return (
    <OverviewPage
      header={{
        path: [...scope],
        title: t("title"),
        description: t("overview.intro"),
        metrics: [
          {
            label: t("overview.metrics.extensions"),
            value: value(data?.extensionsNeedingAction),
            href: "/admin/extensions",
          },
          {
            label: t("overview.metrics.catalogRequests"),
            value: value(data?.catalogRequestsPending),
            href: "/admin/catalog/requests",
          },
          { label: t("overview.metrics.orgs"), value: value(data?.orgs), href: "/admin/orgs" },
          {
            label: t("overview.metrics.accounts"),
            value: value(data?.accounts),
            href: "/admin/accounts",
          },
        ],
      }}
    >
      <Callout tone="info">{t("overview.noConversations")}</Callout>
    </OverviewPage>
  );
}
