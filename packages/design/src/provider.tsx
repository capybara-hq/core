import { type ComponentType, createContext, type ReactNode, useContext } from "react";
import { type ServerClock, ServerClockProvider } from "./clock";
import { type DesignKey, type Locale, messages } from "./i18n";

/** 框架无关的链接组件；apps/web 可传入 next-intl 的 Link。 */
export type LinkComponent = ComponentType<{
  href: string;
  className?: string;
  children: ReactNode;
  "aria-current"?: "page" | undefined;
  "aria-label"?: string;
  "aria-describedby"?: string;
  title?: string;
  target?: string;
  rel?: string;
  tabIndex?: number;
  /** The size-table part (spec §9.2) and the roving-focus key (Sidebar). */
  "data-part"?: string;
  "data-rove"?: string;
  "data-state"?: string;
  "data-optional"?: string;
}>;

const DefaultLink: LinkComponent = ({ href, children, ...rest }) => (
  <a href={href} {...rest}>
    {children}
  </a>
);

/**
 * What a theme replaces of the brand (spec §3): the logo mark as an image URL and the wordmark
 * text; a null part keeps the built-in pixel capybara or `CAPYBARA`.
 */
export type Brand = { markUrl: string | null; wordmark: string | null };

const BrandContext = createContext<Brand | null>(null);

const LocaleContext = createContext<Locale>("zh");
const LinkContext = createContext<LinkComponent>(DefaultLink);
const neverPending = () => false;
const LinkPendingContext = createContext<() => boolean>(neverPending);

export function DesignProvider({
  locale,
  link,
  useLinkPending,
  clock,
  brand,
  children,
}: {
  locale: Locale;
  link?: LinkComponent;
  /**
   * Whether the enclosing link's navigation is pending (apps/web: `() => useLinkStatus().pending`
   * from next/link). Called by `LinkPendingMark` inside each design link; it must be a hook valid
   * inside the provider's `link`. Without it nothing is ever pending.
   */
  useLinkPending?: () => boolean;
  /**
   * The server render's clock (apps/web: the root layout's time and time zone): server-rendered
   * times hydrate with it, then follow the browser's clock (`useNow`, `useTimeZone`).
   */
  clock?: ServerClock;
  /**
   * The resolved theme's brand (apps/web passes it): `Logo` draws it in the sidebar and on the
   * auth and status pages. Without it the logo is the pixel capybara and `CAPYBARA`.
   */
  brand?: Brand;
  children: ReactNode;
}) {
  return (
    <LocaleContext.Provider value={locale}>
      <LinkContext.Provider value={link ?? DefaultLink}>
        <LinkPendingContext.Provider value={useLinkPending ?? neverPending}>
          <BrandContext.Provider value={brand ?? null}>
            <ServerClockProvider clock={clock}>{children}</ServerClockProvider>
          </BrandContext.Provider>
        </LinkPendingContext.Provider>
      </LinkContext.Provider>
    </LocaleContext.Provider>
  );
}

export function useDesignT(): (key: DesignKey) => string {
  const locale = useContext(LocaleContext);
  return (key) => messages[locale][key];
}

/** The DesignProvider's locale. */
export function useDesignLocale(): Locale {
  return useContext(LocaleContext);
}

/** The DesignProvider's theme brand, null when the theme replaces nothing. */
export function useBrand(): Brand | null {
  return useContext(BrandContext);
}

export function useDesignLink(): LinkComponent {
  return useContext(LinkContext);
}

/**
 * The pending mark of a design link (spec §6.13): rendered as the link's last child, it calls the
 * provider's `useLinkPending` (so the router's link status reaches it) and, while the navigation
 * is pending, carries `data-pending` and draws a 2 px `accent` underline along the link's bottom.
 */
export function LinkPendingMark() {
  const usePending = useContext(LinkPendingContext);
  const pending = usePending();
  return (
    <span
      className="cb-link-pending"
      data-part="link-pending"
      data-pending={pending ? "true" : undefined}
      aria-hidden="true"
    />
  );
}
