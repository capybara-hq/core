"use client";

import type { ReactNode } from "react";
import { NoAccess } from "./RoleGate";
import { RequireSession, useSession } from "./shell/session";

/**
 * 管理后台的页面：当前账号不是企业管理员时显示统一的「没有访问权限」（不请求 `/api/v1/admin/*`），否则渲染
 * children。只是界面上的拦截，最终由内核判定。会话加载前显示加载中（RequireSession）。
 */
export function AdminGate({ children }: { children: ReactNode }) {
  return (
    <RequireSession>
      <AdminGateInner>{children}</AdminGateInner>
    </RequireSession>
  );
}

function AdminGateInner({ children }: { children: ReactNode }) {
  const { me } = useSession();
  if (!me.account.isEnterpriseAdmin) return <NoAccess need="enterprise" />;
  return children;
}
