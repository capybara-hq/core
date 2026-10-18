"use client";

import {
  Card,
  Field,
  KeyValue,
  OverviewPage,
  Select,
  Stack,
  StatusPage,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { RequireSession, useSession } from "../../../components/shell/session";

/**
 * `/[locale]`：概览——问候、当前组织（可切换）与进入 Agents 的入口；
 * 不属于任何组织时显示 StatusPage（未开通）。未登录由 (app) 布局跳转登录页。
 */
export default function HomePage() {
  return (
    <RequireSession>
      <Home />
    </RequireSession>
  );
}

function Home() {
  const t = useTranslations("home");
  const { me, switchOrg } = useSession();

  if (me.memberships.length === 0) {
    return (
      <StatusPage
        header={{ title: t("title") }}
        kind="disabled"
        title={t("noMemberships")}
        description={t("noMembershipsHint")}
      />
    );
  }

  const current = me.memberships.find((m) => m.orgId === me.currentOrgId);
  const options = [
    // 首项「选择组织」：选回它即清除当前组织（与旧版行为一致）
    { value: "", label: t("selectOrg") },
    ...me.memberships.map((m) => ({ value: m.orgId, label: m.name })),
  ];
  return (
    <OverviewPage
      header={{
        title: t("greeting", { name: me.account.displayName }),
        actions:
          current === undefined
            ? []
            : [{ label: t("openAgents"), variant: "primary", href: "/agents" }],
      }}
    >
      <Card title={t("orgCard")}>
        <Stack gap={16}>
          <Field label={t("currentOrg")}>
            <Select
              options={options}
              value={me.currentOrgId ?? ""}
              onChange={(e) => void switchOrg(e.target.value === "" ? null : e.target.value)}
            />
          </Field>
          {current === undefined ? (
            <Text tone="muted">{t("noCurrentOrg")}</Text>
          ) : (
            <KeyValue
              rows={[
                { k: t("slug"), v: current.slug },
                { k: t("role"), v: current.role },
              ]}
            />
          )}
        </Stack>
      </Card>
    </OverviewPage>
  );
}
