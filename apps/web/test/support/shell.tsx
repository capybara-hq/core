import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { AppFrame } from "../../src/components/shell/AppFrame";
import type { OrgReadiness } from "../../src/lib/agents";
import type { ShellData } from "../../src/lib/server/session";
import type { Me } from "../../src/lib/session";
import { Link } from "./navigation";
import { ME } from "./render";

export const READY: OrgReadiness = { modelProvider: "ready", agents: 1 };
export const NOT_READY: OrgReadiness = { modelProvider: "none", agents: 0 };
export const PROVIDER_ONLY: OrgReadiness = { modelProvider: "ready", agents: 0 };

/**
 * The shell data the `(app)` layout would read for `me` (`getShell()`): a ready org with no
 * conversations, nothing pending and no extension pages; nothing org-scoped without an org.
 */
export function shellOf(me: Me = ME, o: Partial<ShellData> = {}): ShellData {
  const org = me.memberships.find((m) => m.orgId === me.currentOrgId) ?? null;
  return {
    me,
    org,
    readiness: org === null ? null : READY,
    groups: org === null ? null : { groups: [], next: null, archivedCount: 0 },
    pending: org === null ? null : { count: 0, more: false },
    extensions: org === null ? null : [],
    ...o,
  };
}

/** The `(app)` layout's output for `initial` around `children`, inside the root providers. */
export function frameElement(
  initial: ShellData,
  children: ReactNode = <p>page body</p>,
  { locale = "zh", version = "v9.9.9" }: { locale?: "zh" | "en"; version?: string } = {},
) {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <DesignProvider locale={locale} link={Link as LinkComponent}>
        <ToastProvider>
          <AppFrame initial={initial} version={version}>
            {children}
          </AppFrame>
        </ToastProvider>
      </DesignProvider>
    </NextIntlClientProvider>
  );
}

/**
 * Renders the frame; `update(next)` stands for the server sending new props (`router.refresh()`
 * resolved), keeping the same children.
 */
export function renderFrame(
  initial: ShellData,
  children: ReactNode = <p>page body</p>,
  opts: { locale?: "zh" | "en"; version?: string } = {},
) {
  const view = render(frameElement(initial, children, opts));
  return {
    ...view,
    update: (next: ShellData, nextChildren: ReactNode = children) =>
      view.rerender(frameElement(next, nextChildren, opts)),
  };
}
