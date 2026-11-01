"use client";

import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";
import { Link } from "../i18n/navigation";
import type { AppLocale } from "../i18n/routing";

/** Whether the enclosing next/link navigation is pending (called inside each design link). */
const useLinkPending = () => useLinkStatus().pending;

/**
 * The design system's client context: the locale, the link component (next-intl's Link, which adds
 * the locale prefix and wraps next/link), its pending navigation, and the toasts.
 */
export function DesignRoot({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  return (
    <DesignProvider locale={locale} link={Link as LinkComponent} useLinkPending={useLinkPending}>
      <ToastProvider>{children}</ToastProvider>
    </DesignProvider>
  );
}
