"use client";

import { Grid, LinkCard, OverviewPage, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { usePagePath } from "../../../components/shell/path";
import type { AdminOverview as Overview } from "../../../lib/admin";

const SECTIONS = [
  { id: "accounts", href: "/admin/accounts" },
  { id: "orgs", href: "/admin/orgs" },
  { id: "extensions", href: "/admin/extensions" },
  { id: "models", href: "/admin/models" },
  { id: "settings", href: "/admin/settings" },
] as const;

/**
 * `/admin`: the admin console overview (enterprise admins, OverviewPage). Four header
 * numbers: extensions needing action, pending catalog requests, orgs, accounts; the body links to
 * accounts, orgs, extensions, models and deployment settings. An org's own settings stay under
 * `/settings/*`. The numbers are read on the server (`page.tsx`).
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
          { label: t("overview.metrics.extensions"), value: value(data?.extensionsNeedingAction) },
          {
            label: t("overview.metrics.catalogRequests"),
            value: value(data?.catalogRequestsPending),
          },
          { label: t("overview.metrics.orgs"), value: value(data?.orgs) },
          { label: t("overview.metrics.accounts"), value: value(data?.accounts) },
        ],
      }}
    >
      <Stack gap={16}>
        <Grid columns={2} gap={16}>
          {SECTIONS.map((s) => (
            <LinkCard
              key={s.id}
              title={t(`overview.${s.id}.title`)}
              description={t(`overview.${s.id}.hint`)}
              href={s.href}
              linkLabel={t(`overview.${s.id}.open`)}
            />
          ))}
        </Grid>
      </Stack>
    </OverviewPage>
  );
}
