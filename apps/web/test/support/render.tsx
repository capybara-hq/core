import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { vi } from "vitest";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { type Session, SessionContext } from "../../src/components/shell/session";
import type { Me } from "../../src/lib/session";
import { Link } from "./navigation";

export const ME: Me = {
  account: { id: "a1", displayName: "Grant", email: null, isEnterpriseAdmin: true },
  via: "session",
  currentOrgId: "o1",
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "owner" }],
};

/** 页面测试的外层：next-intl、设计系统上下文与会话（代替 (app) 布局里的 AppFrame）。 */
export function renderPage(
  ui: ReactNode,
  {
    locale = "en",
    me = ME,
    session = {},
  }: {
    locale?: "zh" | "en";
    me?: Me;
    session?: Partial<Session>;
  } = {},
) {
  const value: Session = {
    me,
    reload: vi.fn(async () => {}),
    switchOrg: vi.fn(async () => {}),
    ...session,
  };
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <DesignProvider locale={locale} link={Link as LinkComponent}>
        <ToastProvider>
          <SessionContext.Provider value={value}>{ui}</SessionContext.Provider>
        </ToastProvider>
      </DesignProvider>
    </NextIntlClientProvider>,
  );
}
