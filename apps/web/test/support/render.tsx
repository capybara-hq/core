import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { vi } from "vitest";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { type Session, SessionContext } from "../../src/components/shell/session";
import { makeQueryClient } from "../../src/lib/query/client";
import type { Me } from "../../src/lib/session";
import { Link } from "./navigation";

export const ME: Me = {
  account: { id: "a1", displayName: "Grant", email: null, isEnterpriseAdmin: true },
  via: "session",
  currentOrgId: "o1",
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "owner" }],
  canCreateOrg: true,
};

type PageOpts = {
  locale?: "zh" | "en";
  me?: Me;
  session?: Partial<Session>;
};

/**
 * A browser query client with the app's defaults, retrying without the backoff delay (the one
 * retry of a 5xx still happens, at once).
 */
export function testQueryClient(): QueryClient {
  const client = makeQueryClient();
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
  });
  return client;
}

/** The query client of the latest {@link renderPage}: its `rerender`s keep the same cache. */
let pageClient: QueryClient = testQueryClient();

/** The browser cache the latest {@link renderPage} rendered with. */
export const currentPageClient = (): QueryClient => pageClient;

/**
 * 页面测试的外层：查询缓存、next-intl、设计系统上下文与会话（代替 (app) 布局里的 AppFrame）。
 * Each call starts from an empty cache; a page that brings its own provider (a hydrated cache)
 * reads that one.
 */
export function renderPage(ui: ReactNode, opts: PageOpts = {}) {
  pageClient = testQueryClient();
  return render(pageElement(ui, opts));
}

/** `ui` inside the providers of {@link renderPage} (for `rerender`). */
export function pageElement(
  ui: ReactNode,
  { locale = "en", me = ME, session = {} }: PageOpts = {},
) {
  const value: Session = {
    me,
    reload: vi.fn(async () => {}),
    switchOrg: vi.fn(async () => {}),
    ...session,
  };
  return (
    <QueryClientProvider client={pageClient}>
      <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
        <DesignProvider locale={locale} link={Link as LinkComponent}>
          <ToastProvider>
            <SessionContext.Provider value={value}>{ui}</SessionContext.Provider>
          </ToastProvider>
        </DesignProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}
