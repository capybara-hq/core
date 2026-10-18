"use client";

import { createContext, useContext } from "react";
import type { Me } from "../../lib/session";

/** 已登录的会话：`GET /api/v1/me` 的结果与改动它的操作。由 (app) 布局的 {@link AppFrame} 提供。 */
export type Session = {
  me: Me;
  /** 重新读取 `/me`（例如切换组织之后）。 */
  reload(): Promise<void>;
  /** 切换当前组织并刷新会话。 */
  switchOrg(orgId: string): Promise<void>;
};

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (s === null) throw new Error("useSession() must be used inside <AppFrame>");
  return s;
}
