"use client";

import { Button, EmbedFrame, Skeleton, Stack, Text, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import {
  createEmbedBridge,
  type EmbedBridge,
  type EmbedFile,
  readDesignTokens,
  readTheme,
} from "../../lib/embed-bridge";
import { requestEmbedToken, uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";

type EmbedState =
  | { kind: "loading" }
  | { kind: "ready"; src: string }
  | { kind: "error"; e: unknown }
  /** 嵌入页反复导航离开、重新挂载太多次：停下来，等用户点「重试」。 */
  | { kind: "remountLimit" };

/** 在 {@link REMOUNT_WINDOW_MS} 内最多重新挂载几次 iframe；再多就停下来显示错误。 */
export const MAX_REMOUNTS = 3;
export const REMOUNT_WINDOW_MS = 10_000;

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
  file,
  failed,
}: {
  orgId: string;
  plugin: string;
  id: string;
  title: string;
  conversationId?: string;
  /** A `file-preview` embed: the file it previews, posted once after `init`. */
  file?: { id: string; read(): Promise<EmbedFile>; maxBytes: number };
  /** Renders a failure in place of the built-in one (the conversation page's frames). */
  failed?(o: { message: string; onRetry(): void }): ReactNode;
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
  /** iframe 导航离开插件页面后加 1：在原 src 上重新挂载一个新的 iframe。 */
  const [frameKey, setFrameKey] = useState(0);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const bridge = useRef<EmbedBridge | null>(null);
  // 回调用最新的 router / toast，但不因它们变化而重建消息桥（重建会换令牌、重载 iframe）
  const latest = useRef({ router, toast });
  // The file is read through a ref: a new `read` function each render must not rebuild the bridge.
  const fileRef = useRef(file);
  fileRef.current = file;
  const fileId = file?.id;
  useEffect(() => {
    latest.current = { router, toast };
  });

  useEffect(() => {
    // attempt：「重试」时重建（重新挂载的计数也清零）
    void attempt;
    // fileId: another file means another token (the bridge reads the file through a ref)
    void fileId;
    let src: string | undefined;
    let remounts: number[] = [];
    const b = createEmbedBridge({
      post: (m) => frame.current?.contentWindow?.postMessage(m, "*"),
      frameWindow: () => frame.current?.contentWindow,
      fetchToken: async () => {
        const r = await requestEmbedToken(orgId, plugin, id, {
          ...(conversationId !== undefined && { conversationId }),
          ...(fileRef.current !== undefined && { fileId: fileRef.current.id }),
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
      ...(fileRef.current !== undefined && {
        file: fileRef.current.read,
        fileMaxBytes: fileRef.current.maxBytes,
        onFileError: (e: unknown) => setState({ kind: "error", e }),
      }),
      onNavigatedAway: () => {
        const now = Date.now();
        remounts = remounts.filter((at) => now - at < REMOUNT_WINDOW_MS);
        if (remounts.length >= MAX_REMOUNTS) {
          // 嵌入页每次加载都立刻跳走：不再无限重挂（每次都会请求插件页面）
          setState({ kind: "remountLimit" });
          return;
        }
        remounts.push(now);
        setFrameKey((n) => n + 1);
      },
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
  }, [orgId, plugin, id, conversationId, locale, attempt, fileId]);

  // 每个 iframe 元素只在第一次 load 收到 init；再次 load（导航走了）由消息桥通知重新挂载。
  // 换上新元素时让消息桥回到「等第一次 load」；旧元素的 load 不再理会。
  // 开发模式的 StrictMode 会对同一个元素再调一次 ref（先 null 再 el）：每个元素只接一次 load、只 reset 一次
  const wired = useRef(new WeakSet<HTMLIFrameElement>());
  const setFrame = useCallback((el: HTMLIFrameElement | null) => {
    frame.current = el;
    if (el === null || wired.current.has(el)) return;
    wired.current.add(el);
    bridge.current?.frameReset();
    el.addEventListener("load", () => {
      if (frame.current === el) bridge.current?.loaded();
    });
  }, []);
  const onMessage = useCallback((e: MessageEvent) => {
    bridge.current?.receive({ source: e.source, data: e.data });
  }, []);

  if (state.kind === "loading") return <Skeleton rows={4} />;
  if (state.kind === "error" || state.kind === "remountLimit") {
    const message = state.kind === "error" ? errorMessage(state.e) : t("ui.embedRemountLimit");
    if (failed) return failed({ message, onRetry: () => setAttempt((n) => n + 1) });
    return (
      <Stack gap={8}>
        <FormError
          message={state.kind === "error" ? errorMessage(state.e) : t("ui.embedRemountLimit")}
        />
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
        key={frameKey}
        src={state.src}
        title={title}
        {...(height !== undefined && { height })}
        onMessage={onMessage}
        frameRef={setFrame}
      />
    </Stack>
  );
}
