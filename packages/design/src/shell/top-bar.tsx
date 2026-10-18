import { Kbd, Logo } from "../display/index.js";
import { type CommandGroup, Menu, type MenuItem } from "../overlays/index.js";
import { useDesignLink, useDesignT } from "../provider.js";

export type TopBarProps = {
  nav: { id: string; label: string; href: string }[];
  activeNav: string;
  org: { name: string; menu?: MenuItem[] } | null;
  user: { name: string; menu: MenuItem[] };
  commands: CommandGroup[];
};

export function TopBar({
  nav,
  activeNav,
  org,
  user,
  onOpenCommands,
}: TopBarProps & { onOpenCommands?: () => void }) {
  const t = useDesignT();
  const Link = useDesignLink();
  return (
    <header className="cb-topbar">
      <span className="cb-topbar-logo">
        <Logo scale={2} wordmark />
      </span>
      {org ? (
        org.menu ? (
          <Menu
            items={org.menu}
            trigger={
              <button type="button" className="cb-topbar-btn" aria-label={t("shell.org")}>
                {org.name} ▾
              </button>
            }
          />
        ) : (
          <span className="cb-topbar-org">{org.name}</span>
        )
      ) : null}
      <nav className="cb-topbar-nav" aria-label={t("shell.nav")}>
        {nav.map((n) => (
          <Link
            key={n.id}
            href={n.href}
            className="cb-topbar-link"
            {...(n.id === activeNav ? { "aria-current": "page" as const } : {})}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <button type="button" className="cb-topbar-search" onClick={onOpenCommands}>
        <span aria-hidden="true">&gt;</span>
        <span className="cb-topbar-search-text">{t("shell.search")}</span>
        <Kbd>⌘K</Kbd>
      </button>
      <Menu
        items={user.menu}
        trigger={
          <button type="button" className="cb-topbar-btn" aria-label={t("shell.account")}>
            {user.name}
          </button>
        }
      />
    </header>
  );
}
