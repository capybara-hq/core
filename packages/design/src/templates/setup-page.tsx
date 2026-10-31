import type { ReactNode } from "react";
import { Logo } from "../display/logo";
import { Icon } from "../icons/icon";
import { Menu, type MenuItem } from "../overlays/index";
import { useDesignLink, useDesignT } from "../provider";
import { PageHeader, type PageHeaderProps, StatusBar, type StatusBarProps } from "../shell/index";
import { type PreferenceBarProps, ThemeToggle } from "../shell/preference-bar";
import { initialOf } from "../shell/sidebar";

export type SetupPageProps = {
  /** The current org: name and `~/<slug> · <role>`; `menu` switches it (empty = static). */
  org?: { name: string; slug: string; role: string; menu: MenuItem[] } | null;
  /** The account: its name opens the account menu (language, personal settings, sign out). */
  account: { name: string; menu: MenuItem[] };
  theme?: PreferenceBarProps["theme"];
  status: StatusBarProps;
  /** The page head drawn at the top of the column (the setup home). */
  header?: PageHeaderProps;
  /** "← 开始之前" above a step page's own content. */
  back?: { label: string; href: string };
  /**
   * `column` (default): the 720 chat column, for the setup home; `content`: a step page that
   * brings its own template (FormPage, ListPage …) in the content width.
   */
  width?: "column" | "content";
  children?: ReactNode;
};

/**
 * T13 Setup: the guided setup layout (web-order spec §3.8), used while the org lacks what it needs
 * to run. No sidebar: a 48 px top bar (the brand; the org, the account and the theme at its right
 * end), a centered column (the setup home's head and cards, or a step page under a back link) and
 * the status bar.
 */
export function SetupPage({
  org,
  account,
  theme,
  status,
  header,
  back,
  width = "column",
  children,
}: SetupPageProps) {
  const t = useDesignT();
  const Link = useDesignLink();
  return (
    <div className="cb-setup" data-template="SetupPage">
      <header className="cb-setup-top" data-part="setup-top-bar">
        <Logo scale={2} wordmark />
        <div className="cb-setup-top-end">
          {org ? <SetupOrg org={org} /> : null}
          {account.menu.length > 0 ? (
            <Menu
              items={account.menu}
              trigger={
                <button
                  type="button"
                  className="cb-setup-account"
                  data-part="account"
                  aria-label={`${t("shell.account")}: ${account.name}`}
                  title={account.name}
                >
                  <span className="cb-sidebar-avatar" aria-hidden="true">
                    {initialOf(account.name)}
                  </span>
                  <span className="cb-setup-account-name">{account.name}</span>
                </button>
              }
            />
          ) : (
            <span className="cb-setup-account" data-part="account" data-static="true">
              <span className="cb-sidebar-avatar" aria-hidden="true">
                {initialOf(account.name)}
              </span>
              <span className="cb-setup-account-name">{account.name}</span>
            </span>
          )}
          {theme ? <ThemeToggle {...theme} /> : null}
        </div>
      </header>
      <main className="cb-setup-main">
        <div className="cb-setup-column" data-part="setup-column" data-width={width}>
          {back ? (
            <Link href={back.href} className="cb-setup-back" data-part="back">
              <Icon name="arrow-left" size={14} />
              {back.label}
            </Link>
          ) : null}
          {header ? <PageHeader {...header} /> : null}
          {children}
        </div>
      </main>
      <StatusBar {...status} />
    </div>
  );
}

function SetupOrg({ org }: { org: NonNullable<SetupPageProps["org"]> }) {
  const t = useDesignT();
  const content = (
    <>
      <span className="cb-sidebar-org-initial" aria-hidden="true">
        {initialOf(org.name)}
      </span>
      <span className="cb-setup-org-text">
        <span className="cb-setup-org-name">{org.name}</span>
        <span className="cb-setup-org-meta">
          ~/{org.slug} · {org.role}
        </span>
      </span>
      {org.menu.length > 0 ? <Icon name="chevrons-up-down" size={14} /> : null}
    </>
  );
  if (org.menu.length === 0) {
    return (
      <span className="cb-setup-org" data-part="org" data-static="true">
        {content}
      </span>
    );
  }
  return (
    <Menu
      items={org.menu}
      trigger={
        <button
          type="button"
          className="cb-setup-org"
          data-part="org"
          aria-label={t("sidebar.orgSwitch").replace("{org}", org.name)}
        >
          {content}
        </button>
      }
    />
  );
}
