"use client";

import { AttachmentPreview } from "@capybara-hq/design";
import { useRef, useState } from "react";
import { ensureSession } from "../lib/api";

/**
 * 同源下载地址（`/api/...`，内核 302 到预签名地址）的文件预览：消息附件与产物共用。
 * 浏览器直接加载这类地址，走不到 apiFetch 的自动刷新：图片加载失败时先确认登录（过期则刷新一次）
 * 再带缓存参数重试一次；点开文件时先同步开新标签页（保住用户手势、断开 opener），确认登录后再导航过去。
 * 地址是否安全由 `AttachmentPreview`（`isSafeAttachmentHref`）把关。
 */
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
    ensureSession().then(
      () => setRetry(1),
      () => {
        // 登录确实失效：不再重试，显示加载失败的图片
      },
    );
  };
  const onOpen = (url: string) => {
    const target = new URL(url, window.location.href).href;
    const tab = window.open("", "_blank");
    if (!tab) {
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }
    tab.opener = null;
    const go = () => {
      tab.location.href = target;
    };
    ensureSession().then(go, go);
  };
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
