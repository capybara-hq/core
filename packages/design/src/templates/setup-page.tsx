import type { ReactNode } from "react";
import { AppShell, type AppShellProps } from "../shell/app-shell";
import type { SetupStep, SidebarOrg, SidebarProps } from "../shell/sidebar";

export type SetupPageProps = {
  /** The setup sidebar (`context.kind: "setup"`): the org, the steps, the account. */
  sidebar: {
    /** The current org's switcher, as in the work context (null: none shown). */
    org: SidebarOrg | null;
    /** The setup home ("开始之前"), the first item. */
    home: { href: string };
    steps: SetupStep[];
    /** A step id or `home`. */
    activeNav: string;
    account: SidebarProps["account"];
    theme?: NonNullable<SidebarProps["theme"]>;
    /** The admin console entry (super admins). */
    adminHref?: string;
  };
  /** Draw as the rail of the medium class (the reference set and the catalog). */
  reference?: AppShellProps["reference"];
  /** A shell-wide notice row (safe mode's banner), as {@link AppShellProps.banner}. */
  banner?: ReactNode;
  /** The resolved UI theme has a single scheme, as {@link AppShellProps.singleScheme}. */
  singleScheme?: boolean;
  /** The page: a template (its own page head), in the shell's content area. */
  children?: ReactNode;
};

/**
 * T13 Setup: the guided setup layout (web-SSR spec §4), drawn by the app frame while the current
 * org cannot run yet. The shell's geometry (sidebar | content area, the same rail;
 * below 600 the steps button leads the floating row) with the setup sidebar: the setup home and the steps are its navigation; no search, no
 * inbox, no conversations, no command palette. The page brings its own template and page head.
 */
export function SetupPage({ sidebar, reference, banner, singleScheme, children }: SetupPageProps) {
  const { org, home, steps, adminHref, ...rest } = sidebar;
  return (
    <div className="cb-setup" data-template="SetupPage">
      <AppShell
        sidebar={{
          ...rest,
          context: {
            kind: "setup",
            org,
            home,
            steps,
            ...(adminHref !== undefined ? { adminHref } : {}),
          },
        }}
        {...(reference !== undefined ? { reference } : {})}
        {...(banner !== undefined ? { banner } : {})}
        {...(singleScheme !== undefined ? { singleScheme } : {})}
      >
        {children}
      </AppShell>
    </div>
  );
}
