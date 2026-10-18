"use client";

import { useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { type AppAuth, connectApp } from "./apps";
import { navigateBrowser } from "./browser";
import { useErrorMessage } from "./use-error-message";

/** 内核回调页放在回跳 URL `oauth_error` 里的原因码（界面只显示自己的译文，不回显任何服务器文本）。 */
const OAUTH_ERROR_CODES = new Set([
  "state_invalid",
  "session_mismatch",
  "access_denied",
  "provider_error",
  "token_exchange_failed",
  "issuer_mismatch",
  "app_unavailable",
]);

export type ConnectResult = { kind: "connected" } | { kind: "error"; code: string };

const RESULT_PARAMS = ["connected", "oauth_error"] as const;

/**
 * 读取 OAuth 回跳带回的结果（`connected=<appId>` 或 `oauth_error=<code>`），并给出去掉这些参数后的查询串。
 * 错误码不在已知集合里按 `unknown` 处理。
 */
export function parseConnectResult(search: string): {
  result: ConnectResult | null;
  cleanedSearch: string;
} {
  const params = new URLSearchParams(search);
  const error = params.get("oauth_error");
  const connected = params.get("connected");
  const result: ConnectResult | null =
    error !== null
      ? { kind: "error", code: OAUTH_ERROR_CODES.has(error) ? error : "unknown" }
      : connected !== null
        ? { kind: "connected" }
        : null;
  for (const k of RESULT_PARAMS) params.delete(k);
  const rest = params.toString();
  return { result, cleanedSearch: rest === "" ? "" : `?${rest}` };
}

/** 授权结束后回到的站内路径：当前页（带语言前缀），不含上一次的结果参数与锚点。 */
export function currentReturnPath(): string {
  const { pathname, search } = window.location;
  return `${pathname}${parseConnectResult(search).cleanedSearch}`;
}

/** 授权地址只接受 http(s)（防止被诱导跳到 javascript: 等地址）。 */
const isHttpUrl = (u: string): boolean => {
  try {
    const p = new URL(u).protocol;
    return p === "https:" || p === "http:";
  } catch {
    return false;
  }
};

/** 授权码流应用（个人凭据）走 OAuth 授权，其余认证方式填 token。 */
export const isOAuthCodeApp = (auth: AppAuth): boolean => auth.type === "oauth_code";

/**
 * 发起 OAuth 连接：请求授权地址（带回到当前页的 returnTo），再整页跳转过去
 * （内核写的浏览器绑定 Cookie 只在整页导航的回跳里随请求带回，不能用 fetch 完成）。
 */
export function useStartConnect(orgId: string): {
  start(appId: string): Promise<void>;
  starting: boolean;
} {
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const t = useTranslations("connect.result");
  const [starting, setStarting] = useState(false);
  const start = useCallback(
    async (appId: string) => {
      setStarting(true);
      try {
        const { authorizationUrl } = await connectApp(orgId, appId, currentReturnPath());
        if (!isHttpUrl(authorizationUrl)) {
          toast.error(t("unknown"));
          return;
        }
        navigateBrowser(authorizationUrl);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setStarting(false);
      }
    },
    [orgId, toast, errorMessage, t],
  );
  return { start, starting };
}

/**
 * OAuth 回跳后在任意页面提示结果（toast），并把结果参数从地址栏清掉（不新增历史记录）。
 * 在 App 外框里挂一次。
 */
export function useConnectResultToast(): void {
  const toast = useToast();
  const t = useTranslations("connect.result");
  useEffect(() => {
    const { result, cleanedSearch } = parseConnectResult(window.location.search);
    if (result === null) return;
    if (result.kind === "connected") toast.success(t("connected"));
    else toast.error(t.has(`error.${result.code}`) ? t(`error.${result.code}`) : t("unknown"));
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${cleanedSearch}${window.location.hash}`,
    );
  }, [toast, t]);
}
