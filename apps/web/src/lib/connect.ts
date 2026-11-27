"use client";

import { useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { navigateBrowser } from "./browser";
import { type ConnectorAuth, connectConnector } from "./connectors";
import { useExternalAuth } from "./external-auth";
import { handoffRequest, isHttpUrl, useBrowserHandoff } from "./handoff";
import { useErrorMessage } from "./use-error-message";

/** 内核回调页放在回跳 URL `oauth_error` 里的原因码（界面只显示自己的译文，不回显任何服务器文本）。 */
const OAUTH_ERROR_CODES = new Set([
  "state_invalid",
  "session_mismatch",
  "access_denied",
  "provider_error",
  "token_exchange_failed",
  "issuer_mismatch",
  "connector_unavailable",
]);

export type ConnectResult = { kind: "connected" } | { kind: "error"; code: string };

const RESULT_PARAMS = ["connected", "oauth_error"] as const;

/**
 * 读取 OAuth 回跳带回的结果（`connected=<connectorId>` 或 `oauth_error=<code>`），并给出去掉这些参数后的查询串。
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

/** 授权码流连接器（个人凭据）走 OAuth 授权，其余认证方式填 token。 */
export const isOAuthCodeConnector = (auth: ConnectorAuth): boolean => auth.type === "oauth_code";

/**
 * Starts OAuth for a connector with the current page as `returnTo`. In a browser the page then
 * navigates to the authorization address (the binding cookie the kernel set comes back only on a
 * full-page navigation's callback, never through fetch). In a shell with `openExternal@1` it asks
 * for a browser handoff instead, opens it in the system browser and waits in the external
 * authorization dialog (spec 2026-11-28-shell-external-authorization-design.md §4).
 */
export function useStartConnect(orgId: string): {
  start(connectorId: string): Promise<void>;
  starting: boolean;
} {
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const t = useTranslations("connect.result");
  const handoff = useBrowserHandoff();
  const externalAuth = useExternalAuth();
  const [starting, setStarting] = useState(false);
  const start = useCallback(
    async (connectorId: string) => {
      setStarting(true);
      try {
        const answer = await connectConnector(
          orgId,
          connectorId,
          currentReturnPath(),
          ...(handoff === undefined ? [] : [handoffRequest(handoff)]),
        );
        if ("handoffUrl" in answer) {
          if (handoff === undefined || !isHttpUrl(answer.handoffUrl)) {
            toast.error(t("unknown"));
            return;
          }
          // the click's own work: the shell opens the browser only from event-driven code
          externalAuth.open(answer.handoffUrl, { kind: "connector", orgId, connectorId });
          void handoff.openExternal(answer.handoffUrl).catch(() => {
            // refused or failed: the dialog's Copy link still gets the person there
          });
          return;
        }
        if (!isHttpUrl(answer.authorizationUrl)) {
          toast.error(t("unknown"));
          return;
        }
        navigateBrowser(answer.authorizationUrl);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setStarting(false);
      }
    },
    [orgId, toast, errorMessage, t, handoff, externalAuth],
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
