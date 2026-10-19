import { IconButton } from "../controls/index";
import { Badge, Kbd, Logo } from "../display/index";
import { type CommandGroup, Menu, type MenuItem } from "../overlays/index";
import { useDesignLink, useDesignT } from "../provider";
import { useMediaQuery } from "./use-media-query";

export type TopBarProps = {
  /** `count`：待处理数等（>0 时在名称后以计数 Badge 显示，0 / 缺省不显示）。 */
  nav: { id: string; label: string; href: string; count?: number }[];
  activeNav: string;
  org: { name: string; menu?: MenuItem[] } | null;
  /** 名称旁的 ▾ 由 TopBar 渲染；`menu` 为空时只显示名称、不可点击。 */
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
  // <1280 搜索收成图标按钮；<960 导航只留当前项，其余进「更多 ▾」
  const compactSearch = useMediaQuery("(max-width: 1279px)");
  const compactNav = useMediaQuery("(max-width: 959px)");
  const shown = compactNav ? nav.filter((n) => n.id === activeNav) : nav;
  const overflow = compactNav ? nav.filter((n) => n.id !== activeNav) : [];
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
              <button
                type="button"
                className="cb-topbar-btn"
                aria-label={`${t("shell.org")}: ${org.name}`}
              >
                {org.name} <span aria-hidden="true">▾</span>
              </button>
            }
          />
        ) : (
          <span className="cb-topbar-org">{org.name}</span>
        )
      ) : null}
      <nav className="cb-topbar-nav" aria-label={t("shell.nav")}>
        {shown.map((n) => (
          <Link
            key={n.id}
            href={n.href}
            className="cb-topbar-link"
            {...(n.id === activeNav ? { "aria-current": "page" as const } : {})}
            {...(n.count
              ? {
                  "aria-label": t("shell.navCount")
                    .replace("{label}", n.label)
                    .replace("{n}", String(n.count)),
                }
              : {})}
          >
            {n.label}
            {n.count ? (
              <span className="cb-topbar-count">
                <Badge tone="count">{n.count > 99 ? "99+" : n.count}</Badge>
              </span>
            ) : null}
          </Link>
        ))}
        {overflow.length > 0 ? (
          <Menu
            items={overflow.map((n) => ({
              label: n.count ? `${n.label} (${n.count > 99 ? "99+" : n.count})` : n.label,
              href: n.href,
            }))}
            trigger={
              <button type="button" className="cb-topbar-link cb-topbar-more">
                {t("shell.more")} ▾
              </button>
            }
          />
        ) : null}
      </nav>
      {compactSearch ? (
        <IconButton
          label={t("shell.searchShort")}
          icon=">"
          size={24}
          variant="default"
          onClick={onOpenCommands}
        />
      ) : (
        <button type="button" className="cb-topbar-search" onClick={onOpenCommands}>
          <span aria-hidden="true">&gt;</span>
          <span className="cb-topbar-search-text">{t("shell.search")}</span>
          <Kbd>⌘K</Kbd>
        </button>
      )}
      {user.menu.length > 0 ? (
        <Menu
          items={user.menu}
          trigger={
            <button
              type="button"
              className="cb-topbar-btn"
              aria-label={`${t("shell.account")}: ${user.name}`}
            >
              {user.name} <span aria-hidden="true">▾</span>
            </button>
          }
        />
      ) : (
        // 菜单为空（如会话加载中）时不渲染可点击的空下拉
        <span className="cb-topbar-org">{user.name}</span>
      )}
    </header>
  );
}
