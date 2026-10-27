"use client";

import { Body, Skeleton, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { createContext, type ReactNode, useContext } from "react";
import type { Me } from "../../lib/session";

/** 已登录的会话：`GET /api/v1/me` 的结果与改动它的操作。由 (app) 布局的 AppFrame 提供。 */
export type Session = {
  me: Me;
  /** 重新读取 `/me`（例如切换组织之后）。 */
  reload(): Promise<void>;
  /** 切换当前组织（`null` 清除）并刷新会话。 */
  switchOrg(orgId: string | null): Promise<void>;
  /** 立即重读顶栏的待处理审批数（处理审批之后调用）。 */
  refreshPending?(): void;
  /** The web version (pages that draw their own status bar show it). */
  version?: string;
};

/** `null`：会话尚未加载（服务端渲染与首次读取 `/me` 期间）。 */
export const SessionContext = createContext<Session | null>(null);

/** 已加载的会话；只能在 {@link RequireSession} 之内调用。 */
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (s === null) throw new Error("useSession() must be used inside <RequireSession>");
  return s;
}

/**
 * 需要会话的页面内容：会话加载前在内容区显示「加载中」与骨架；加载后渲染 children。
 * 不需要会话的内容（如 404）不必包它，因而能在服务端直接渲染。
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const t = useTranslations("common");
  const session = useContext(SessionContext);
  if (session === null) {
    return (
      <Body layout="single" contentPadded>
        <Stack gap={12}>
          <Text tone="muted">{t("loading")}</Text>
          <Skeleton rows={6} />
        </Stack>
      </Body>
    );
  }
  return children;
}
