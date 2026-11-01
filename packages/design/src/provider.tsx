import { type ComponentType, createContext, type ReactNode, useContext } from "react";
import { type DesignKey, type Locale, messages } from "./i18n";

/** 框架无关的链接组件；apps/web 可传入 next-intl 的 Link。 */
export type LinkComponent = ComponentType<{
  href: string;
  className?: string;
  children: ReactNode;
  "aria-current"?: "page" | undefined;
  "aria-label"?: string;
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

const LocaleContext = createContext<Locale>("zh");
const LinkContext = createContext<LinkComponent>(DefaultLink);
const neverPending = () => false;
const LinkPendingContext = createContext<() => boolean>(neverPending);

export function DesignProvider({
  locale,
  link,
  useLinkPending,
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
  children: ReactNode;
}) {
  return (
    <LocaleContext.Provider value={locale}>
      <LinkContext.Provider value={link ?? DefaultLink}>
        <LinkPendingContext.Provider value={useLinkPending ?? neverPending}>
          {children}
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
