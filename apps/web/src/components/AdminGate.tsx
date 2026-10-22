"use client";

import { StatusPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { RequireSession, useSession } from "./shell/session";

/**
 * 管理后台的页面：当前账号不是企业管理员时显示 StatusPage 403（不请求 `/api/v1/admin/*`），否则渲染 children。
 * 只是界面上的拦截，最终由内核判定。会话加载前显示加载中（RequireSession）。
 */
export function AdminGate({ children }: { children: ReactNode }) {
  return (
    <RequireSession>
      <AdminGateInner>{children}</AdminGateInner>
    </RequireSession>
  );
}

function AdminGateInner({ children }: { children: ReactNode }) {
  const t = useTranslations("admin.forbidden");
  const { me } = useSession();
  if (!me.account.isEnterpriseAdmin) {
    return (
      <StatusPage
        header={{ title: t("title") }}
        kind="403"
        title={t("title")}
        description={t("hint")}
      />
    );
  }
  return children;
}
