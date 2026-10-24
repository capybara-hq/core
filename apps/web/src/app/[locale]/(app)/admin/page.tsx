"use client";

import { Card, Grid, OverviewPage, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { AdminGate } from "../../../../components/AdminGate";
import { FormError } from "../../../../components/form-error";
import { Link } from "../../../../i18n/navigation";
import { getAdminOverview } from "../../../../lib/admin";
import { ApiClientError } from "../../../../lib/api";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/[locale]/admin`：管理后台概览（企业管理员，OverviewPage）。页头四个数字：需要处理的插件、待处理的目录申请、
 * 组织数、账号数；正文是账号、组织、插件与部署设置的入口。组织自己的设置仍在 `/settings/*`。
 */
export default function AdminOverviewPage() {
  return (
    <AdminGate>
      <AdminOverview />
    </AdminGate>
  );
}

const SECTIONS = [
  { id: "accounts", href: "/admin/accounts" },
  { id: "orgs", href: "/admin/orgs" },
  { id: "plugins", href: "/admin/plugins" },
  { id: "models", href: "/admin/models" },
  { id: "settings", href: "/admin/settings" },
] as const;

function AdminOverview() {
  const t = useTranslations("admin");
  const errorMessage = useErrorMessage();
  const { state } = useLoad(getAdminOverview, []);
  const data = state.kind === "ready" ? state.data : undefined;
  const value = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString("en-US"));
  return (
    <OverviewPage
      header={{
        title: t("title"),
        metrics: [
          { label: t("overview.metrics.plugins"), value: value(data?.extensionsNeedingAction) },
          {
            label: t("overview.metrics.directoryRequests"),
            value: value(data?.catalogRequestsPending),
          },
          { label: t("overview.metrics.orgs"), value: value(data?.orgs) },
          { label: t("overview.metrics.accounts"), value: value(data?.accounts) },
        ],
      }}
    >
      <Stack gap={16}>
        <Text tone="muted">{t("overview.intro")}</Text>
        {state.kind === "error" && (
          <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
        )}
        <Grid columns={2} gap={16}>
          {SECTIONS.map((s) => (
            <Card key={s.id} title={t(`overview.${s.id}.title`)}>
              <Stack gap={8}>
                <Text tone="muted">{t(`overview.${s.id}.hint`)}</Text>
                <Text>
                  <Link href={s.href}>{t(`overview.${s.id}.open`)}</Link>
                </Text>
              </Stack>
            </Card>
          ))}
        </Grid>
      </Stack>
    </OverviewPage>
  );
}
