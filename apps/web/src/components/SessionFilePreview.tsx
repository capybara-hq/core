"use client";

import { AttachmentPreview, useToast } from "@capybara-hq/design";
import { useCallback, useRef, useState } from "react";
import { ApiClientError, apiFetch, ensureSession } from "../lib/api";
import { useOpenExternalCapability } from "../lib/shell";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * 同源下载地址（`/api/...`，内核 302 到预签名地址）的文件预览：消息附件与产物共用。
 * 浏览器直接加载这类地址，走不到 apiFetch 的自动刷新：图片加载失败时先确认登录（过期则刷新一次）
 * 再带缓存参数重试一次；点开文件时先同步开新标签页（保住用户手势、断开 opener），确认登录后再导航过去。
 * 登录确实失效（401）时关掉新标签页、在当前页提示（按错误码翻译），不让用户看到下载地址的裸 401；
 * 其他失败（网络等）照常导航，交给浏览器显示。
 * 地址是否安全由 `AttachmentPreview`（`isSafeAttachmentHref`）把关。
 */
/**
 * Opens a same-origin download URL in a new tab after making sure the session is fresh: the tab
 * opens synchronously (keeping the user gesture, no opener), then navigates once the session is
 * confirmed; when the sign-in is really gone (401) the tab closes and the error shows here instead
 * of a bare 401. `public: true` (a share link, which needs no session) opens the URL as is.
 *
 * Inside a native shell with `openExternal@1` the file opens in the system browser instead (the
 * mobile app sends every popup to an in-app browser sheet that has none of the WebView's cookies).
 * That browser does not hold the app's session either, so a kernel download route is first asked
 * for its cookie-free form (`?as=url`: the presigned URL the 302 would send) under this page's
 * session, and that URL is opened; a share link goes as is.
 */
export function useOpenDownload(): (url: string, opts?: { public?: boolean }) => void {
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const external = useOpenExternalCapability();
  return useCallback(
    (url: string, opts: { public?: boolean } = {}) => {
      const target = new URL(url, window.location.href);
      if (external !== undefined) {
        const open = (href: string) => {
          try {
            external.open(href).catch(() => {});
          } catch {
            // the shell refused it: nothing opens
          }
        };
        if (opts.public === true) {
          open(target.href);
          return;
        }
        target.searchParams.set("as", "url");
        // query-exempt: a one-off presigned URL for the system browser, not page data
        apiFetch<{ url: string }>(`${target.pathname}${target.search}`).then(
          (r) => open(r.url),
          (e: unknown) => toast.error(errorMessage(e)),
        );
        return;
      }
      if (opts.public === true) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      const tab = window.open("", "_blank");
      if (!tab) {
        window.open(target.href, "_blank", "noopener,noreferrer");
        return;
      }
      tab.opener = null;
      const go = () => {
        tab.location.href = target.href;
      };
      // query-exempt: a session refresh before a download navigates, not a kernel read
      ensureSession().then(go, (e: unknown) => {
        if (e instanceof ApiClientError && e.status === 401) {
          tab.close();
          toast.error(errorMessage(e));
          return;
        }
        go();
      });
    },
    [toast, errorMessage, external],
  );
}

export function SessionFilePreview({
  kind,
  name,
  href,
  meta,
}: {
  kind: "image" | "file";
  name: string;
  href: string;
  meta?: string;
}) {
  const [retry, setRetry] = useState(0);
  const retried = useRef(false);
  const onImageError = () => {
    if (retried.current) return;
    retried.current = true;
    // query-exempt: a session refresh before reloading an image, not a kernel read
    ensureSession().then(
      () => setRetry(1),
      () => {
        // 登录确实失效：不再重试，显示加载失败的图片
      },
    );
  };
  const onOpen = useOpenDownload();
  return (
    <AttachmentPreview
      kind={kind}
      name={name}
      href={href}
      {...(meta !== undefined && { meta })}
      retry={retry}
      onImageError={onImageError}
      onOpen={onOpen}
    />
  );
}
