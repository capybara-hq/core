"use client";

import { Button, EmbedFrame, Skeleton, Stack, Text, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import {
  createEmbedBridge,
  type EmbedBridge,
  readDesignTokens,
  readTheme,
} from "../../lib/embed-bridge";
import { requestEmbedToken, uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";

type EmbedState =
  | { kind: "loading" }
  | { kind: "ready"; src: string }
  | { kind: "error"; e: unknown };

/**
 * 嵌入应用（第二档）：取嵌入令牌，在 design 的 `EmbedFrame`（沙箱 iframe）里打开插件页面，
 * 经消息桥（`lib/embed-bridge.ts`）发 `init` / 续期 `token` / `theme`，处理 iframe 的 resize / navigate / toast。
 * 对话标签（带 `conversationId`）与组织页面（不带）共用。取令牌失败只在这里显示错误与「重试」。
 */
export function EmbedTab({
  orgId,
  plugin,
  id,
  title,
  conversationId,
}: {
  orgId: string;
  plugin: string;
  id: string;
  title: string;
  conversationId?: string;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const locale = uiLocale(useLocale());
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<EmbedState>({ kind: "loading" });
  const [height, setHeight] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const bridge = useRef<EmbedBridge | null>(null);
  // 回调用最新的 router / toast，但不因它们变化而重建消息桥（重建会换令牌、重载 iframe）
  const latest = useRef({ router, toast });
  useEffect(() => {
    latest.current = { router, toast };
  });

  useEffect(() => {
    // attempt：「重试」时重建
    void attempt;
    let src: string | undefined;
    const b = createEmbedBridge({
      post: (m) => frame.current?.contentWindow?.postMessage(m, "*"),
      frameWindow: () => frame.current?.contentWindow,
      fetchToken: async () => {
        const r = await requestEmbedToken(orgId, plugin, id, {
          ...(conversationId !== undefined && { conversationId }),
        });
        src ??= r.src;
        setRefreshFailed(false);
        return r;
      },
      locale,
      context: { orgId, ...(conversationId !== undefined && { conversationId }) },
      readTheme: () => ({ theme: readTheme(document), tokens: readDesignTokens(document) }),
      onResize: setHeight,
      onNavigate: (path) => latest.current.router.push(path),
      onToast: (text) => latest.current.toast.success(text),
      onTokenError: () => setRefreshFailed(true),
    });
    bridge.current = b;
    setState({ kind: "loading" });
    b.start().then(
      () => {
        if (bridge.current === b && src !== undefined) setState({ kind: "ready", src });
      },
      (e: unknown) => {
        if (bridge.current === b) setState({ kind: "error", e });
      },
    );
    // 外层主题切换（`<html data-theme>`）→ 发 theme
    const mo = new MutationObserver(() => b.themeChanged());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mo.disconnect();
      b.dispose();
      if (bridge.current === b) bridge.current = null;
    };
  }, [orgId, plugin, id, conversationId, locale, attempt]);

  // iframe 每次加载（含其内部导航）都重新发 init
  const setFrame = useCallback((el: HTMLIFrameElement | null) => {
    frame.current = el;
    el?.addEventListener("load", () => bridge.current?.loaded());
  }, []);
  const onMessage = useCallback((e: MessageEvent) => {
    bridge.current?.receive({ source: e.source, data: e.data });
  }, []);

  if (state.kind === "loading") return <Skeleton rows={4} />;
  if (state.kind === "error") {
    return (
      <Stack gap={8}>
        <FormError message={errorMessage(state.e)} />
        <Stack direction="row" gap={8}>
          <Button onClick={() => setAttempt((n) => n + 1)}>{t("common.retry")}</Button>
        </Stack>
      </Stack>
    );
  }
  return (
    <Stack gap={8}>
      {refreshFailed && (
        <Text variant="small" tone="warn">
          {t("ui.embedRefreshFailed")}
        </Text>
      )}
      <EmbedFrame
        src={state.src}
        title={title}
        {...(height !== undefined && { height })}
        onMessage={onMessage}
        frameRef={setFrame}
      />
    </Stack>
  );
}
