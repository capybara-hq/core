"use client";

import {
  DesignProvider,
  type LinkComponent,
  type ServerClock,
  ToastProvider,
} from "@capybara-hq/design";
import { useLinkStatus } from "next/link";
import { type ReactNode, useEffect } from "react";
import { Link } from "../i18n/navigation";
import type { AppLocale } from "../i18n/routing";
import { TIME_ZONE_COOKIE } from "../lib/time";

/** Whether the enclosing next/link navigation is pending (called inside each design link). */
const useLinkPending = () => useLinkStatus().pending;

/**
 * The design system's client context: the locale, the link component (next-intl's Link, which adds
 * the locale prefix and wraps next/link), its pending navigation, the server render's clock
 * (hydration writes times with it, then the browser's clock takes over), and the toasts. When the
 * browser's time zone is not the one the server wrote times in, it is saved in the `cb-tz` cookie,
 * so the next server render writes them in the viewer's zone.
 */
export function DesignRoot({
  locale,
  clock,
  children,
}: {
  locale: AppLocale;
  clock?: ServerClock;
  children: ReactNode;
}) {
  const serverZone = clock?.timeZone;
  useEffect(() => {
    if (serverZone === undefined) return;
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone === serverZone) return;
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is async and not everywhere
    document.cookie = `${TIME_ZONE_COOKIE}=${zone}; max-age=31536000; path=/; samesite=lax`;
  }, [serverZone]);
  return (
    <DesignProvider
      locale={locale}
      link={Link as LinkComponent}
      useLinkPending={useLinkPending}
      {...(clock !== undefined && { clock })}
    >
      <ToastProvider>{children}</ToastProvider>
    </DesignProvider>
  );
}
