import { type ComponentType, createContext, type ReactNode, useContext } from "react";
import { type ServerClock, ServerClockProvider } from "./clock";
import { type DesignKey, type Locale, messages } from "./i18n";
import { NativeContext, type NativeHandlers } from "./native";

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
  /**
   * Replaces the current history entry instead of pushing one: a switch between a page's sibling
   * views (the settings sub-nav) adds no back step, so back leaves the page.
   */
  replace?: boolean;
  /** The size-table part (spec §9.2) and the roving-focus key (Sidebar). */
  "data-part"?: string;
  "data-rove"?: string;
  /** The item's id (a navigation row's). */
  "data-id"?: string;
  "data-state"?: string;
  "data-optional"?: string;
  /** What the link stands for, for the size table (a bubble's conversation chip). */
  "data-kind"?: string;
  /** A touch row's own attributes (NavRow, FloatingIconButton): current, drawer pick, section. */
  "data-current"?: string | undefined;
  "data-drawer-pick"?: string | undefined;
  "data-nav-section"?: string | undefined;
}>;

const DefaultLink: LinkComponent = ({ href, children, replace: _replace, ...rest }) => (
  <a href={href} {...rest}>
    {children}
  </a>
);

/**
 * What a theme replaces of the brand (spec §3; theme brand coverage spec §3): a null part keeps
 * the built-in graphic or text.
 */
export type Brand = {
  /** The logo mark's image URL; null keeps the pixel capybara. */
  markUrl: string | null;
  /** The wordmark text; null keeps `CAPYBARA`. */
  wordmark: string | null;
  /**
   * The empty states' illustration URL (drawn as a mask in `faint`); null falls back to
   * `markUrl`, and with both null the empty state draws the capybara line art.
   */
  illustrationUrl: string | null;
  /** The decorative dither columns (`AuthPage`): `"dither"` draws them, `"none"` leaves them out. */
  decoration: "dither" | "none";
  /** The product name (the deployment's `platform.name`, else the built-in one): the mark's `alt`. */
  productName: string | null;
};

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
  native,
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
  /**
   * A native shell's handlers (mobile app spec §6; apps/web passes them from the shell's
   * capabilities): plain menus open as the platform's action sheet on the compact class, and
   * sends, approvals, destructive confirmations and selection changes play haptics. Without
   * them (the browser) the design draws its own menus and plays nothing.
   */
  native?: NativeHandlers;
  children: ReactNode;
}) {
  return (
    <LocaleContext.Provider value={locale}>
      <LinkContext.Provider value={link ?? DefaultLink}>
        <LinkPendingContext.Provider value={useLinkPending ?? neverPending}>
          <BrandContext.Provider value={brand ?? null}>
            <NativeContext.Provider value={native ?? null}>
              <ServerClockProvider clock={clock}>{children}</ServerClockProvider>
            </NativeContext.Provider>
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
