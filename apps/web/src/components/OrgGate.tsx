"use client";

import { Button, StatusPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useRouter } from "../i18n/navigation";
import { RequireSession, useSession } from "./shell/session";

/**
 * 需要当前组织的页面：会话没有当前组织时显示 StatusPage（未开通），否则渲染 `children(orgId)`。
 * 会话加载前显示加载中（RequireSession）；未登录时 (app) 布局已跳转登录页。
 */
export function OrgGate({ children }: { children: (orgId: string) => ReactNode }) {
  return (
    <RequireSession>
      <OrgGateInner>{children}</OrgGateInner>
    </RequireSession>
  );
}

function OrgGateInner({ children }: { children: (orgId: string) => ReactNode }) {
  const t = useTranslations();
  const router = useRouter();
  const { me } = useSession();
  if (me.currentOrgId === null) {
    const none = me.memberships.length === 0;
    return (
      <StatusPage
        header={{ title: none ? t("home.noMemberships") : t("agents.noOrg") }}
        kind="disabled"
        title={none ? t("home.noMemberships") : t("agents.noOrg")}
        description={none ? t("home.noMembershipsHint") : t("agents.noOrgHint")}
        action={
          <Button variant="primary" onClick={() => router.push("/")}>
            {t("agents.backHome")}
          </Button>
        }
      />
    );
  }
  return children(me.currentOrgId);
}
