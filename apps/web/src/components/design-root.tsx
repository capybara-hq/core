"use client";

import {
  type Brand,
  DesignProvider,
  type LinkComponent,
  type ServerClock,
  ShellReady,
  ToastProvider,
  useDesignLink,
  useDesignLocale,
} from "@capybara-hq/design";
import { useLinkStatus } from "next/link";
import { createContext, type PointerEvent, type ReactNode, useContext, useEffect } from "react";
import { Link, useRouter } from "../i18n/navigation";
import type { AppLocale } from "../i18n/routing";
import { useWarm } from "../lib/query/warm";
import { useNativeHandlers } from "../lib/shell";
import { TIME_ZONE_COOKIE } from "../lib/time";

/** Whether the enclosing next/link navigation is pending (called inside each design link). */
const useLinkPending = () => useLinkStatus().pending;

/**
 * The design link: next-intl's Link, which also warms its route on `pointerdown` (the route's
 * queries and code, mobile spec §7.3), so the page is often cached by the time the tap lands.
 */
const WarmLink: LinkComponent = (props) => {
  const router = useRouter();
  const warm = useWarm(router);
  const own = (props as { onPointerDown?: (e: PointerEvent<HTMLAnchorElement>) => void })
    .onPointerDown;
  return (
    <Link
      {...props}
      onPointerDown={(e) => {
        own?.(e);
        warm(props.href);
      }}
    />
  );
};

/** The clock `DesignRoot` was given, so `BrandRoot` can provide the same design context again. */
const ClockContext = createContext<ServerClock | undefined>(undefined);

/**
 * The design system's client context: the locale, the link component (next-intl's Link, which adds
 * the locale prefix and wraps next/link), its pending navigation, the server render's clock
 * (hydration writes times with it, then the browser's clock takes over), and the toasts. When the
 * browser's time zone is not the one the server wrote times in, it is saved in the `cb-tz` cookie,
 * so the next server render writes them in the viewer's zone. The theme's brand is set below it,
 * by {@link BrandRoot}: the root layout cannot see the viewer's theme.
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
  const native = useNativeHandlers();
  return (
    <ClockContext.Provider value={clock}>
      <DesignProvider
        locale={locale}
        native={native}
        link={WarmLink}
        useLinkPending={useLinkPending}
        {...(clock !== undefined && { clock })}
      >
        {/* once per document: the native shell drops its splash (chrome@1.ready) */}
        <ShellReady />
        <ToastProvider>{children}</ToastProvider>
      </DesignProvider>
    </ClockContext.Provider>
  );
}

/**
 * The resolved theme's brand (themes spec §8): provides the enclosing design context again (its
 * locale, link and `DesignRoot`'s clock) with `brand`, so `Logo` (sidebar, auth and status pages)
 * draws the theme's mark and wordmark. Rendered by the layouts that know the viewer's theme (the
 * root layout cannot); null keeps the built-in logo.
 */
export function BrandRoot({ brand, children }: { brand: Brand | null; children: ReactNode }) {
  const clock = useContext(ClockContext);
  const native = useNativeHandlers();
  return (
    <DesignProvider
      locale={useDesignLocale()}
      native={native}
      link={useDesignLink()}
      useLinkPending={useLinkPending}
      {...(clock !== undefined && { clock })}
      {...(brand !== null && { brand })}
    >
      {children}
    </DesignProvider>
  );
}
