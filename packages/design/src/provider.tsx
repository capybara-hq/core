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
}>;

const DefaultLink: LinkComponent = ({ href, children, ...rest }) => (
  <a href={href} {...rest}>
    {children}
  </a>
);

const LocaleContext = createContext<Locale>("zh");
const LinkContext = createContext<LinkComponent>(DefaultLink);

export function DesignProvider({
  locale,
  link,
  children,
}: {
  locale: Locale;
  link?: LinkComponent;
  children: ReactNode;
}) {
  return (
    <LocaleContext.Provider value={locale}>
      <LinkContext.Provider value={link ?? DefaultLink}>{children}</LinkContext.Provider>
    </LocaleContext.Provider>
  );
}

export function useDesignT(): (key: DesignKey) => string {
  const locale = useContext(LocaleContext);
  return (key) => messages[locale][key];
}

export function useDesignLink(): LinkComponent {
  return useContext(LinkContext);
}
