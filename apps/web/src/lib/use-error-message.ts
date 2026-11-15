"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { ApiClientError } from "./api";

/**
 * 把 API 错误翻译成界面文案：以错误码为 key 查 `errors.*`（如 `auth.invalid_credentials`
 * → `errors.auth.invalid_credentials`），未登记的错误码显示通用文案。
 * A code whose copy is an object of reasons (`skill.project_unavailable`) reads the entry named by
 * the error's first detail `reason`, else its `default`.
 * 返回的函数在语言不变时引用稳定，可放进 effect 的依赖。
 */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations("errors");
  return useCallback(
    (error: unknown) => {
      const code = error instanceof ApiClientError ? error.code : "unknown";
      if (!t.has(code)) return t("unknown");
      const copy: unknown = t.raw(code);
      if (typeof copy === "string") return t(code);
      if (copy !== null && typeof copy === "object") {
        const entries = copy as Record<string, unknown>;
        const reason = error instanceof ApiClientError ? reasonOf(error) : undefined;
        if (reason !== undefined && typeof entries[reason] === "string") {
          return t(`${code}.${reason}`);
        }
        if (typeof entries.default === "string") return t(`${code}.default`);
      }
      return t("unknown");
    },
    [t],
  );
}

/** The `reason` of an error's first detail, if any. */
function reasonOf(e: ApiClientError): string | undefined {
  const d = (e.rawDetails[0] ?? e.details[0]) as { reason?: unknown } | undefined;
  return typeof d?.reason === "string" ? d.reason : undefined;
}
