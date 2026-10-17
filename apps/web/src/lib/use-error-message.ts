"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { ApiClientError } from "./api";

/**
 * 把 API 错误翻译成界面文案：以错误码为 key 查 `errors.*`（如 `auth.invalid_credentials`
 * → `errors.auth.invalid_credentials`），未登记的错误码显示通用文案。
 * 返回的函数在语言不变时引用稳定，可放进 effect 的依赖。
 */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations("errors");
  return useCallback(
    (error: unknown) => {
      const code = error instanceof ApiClientError ? error.code : "unknown";
      return t.has(code) && typeof t.raw(code) === "string" ? t(code) : t("unknown");
    },
    [t],
  );
}
