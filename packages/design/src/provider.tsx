import { createContext, type ReactNode, useContext } from "react";
import { type DesignKey, type Locale, messages } from "./i18n.js";

const LocaleContext = createContext<Locale>("zh");

export function DesignProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useDesignT(): (key: DesignKey) => string {
  const locale = useContext(LocaleContext);
  return (key) => messages[locale][key];
}
