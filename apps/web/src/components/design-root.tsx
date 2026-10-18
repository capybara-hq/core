"use client";

import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import type { ReactNode } from "react";
import { Link } from "../i18n/navigation";
import type { AppLocale } from "../i18n/routing";

/** 设计系统的客户端上下文：语言、链接组件（next-intl 的 Link，自动补语言前缀）与 Toast。 */
export function DesignRoot({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  return (
    <DesignProvider locale={locale} link={Link as LinkComponent}>
      <ToastProvider>{children}</ToastProvider>
    </DesignProvider>
  );
}
