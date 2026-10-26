import { IconButton } from "../controls/index";
import { Badge, Kbd, Logo } from "../display/index";
import { type CommandGroup, Menu, type MenuItem } from "../overlays/index";
import { useDesignLink, useDesignT } from "../provider";
import { useMediaQuery } from "./use-media-query";

/** 计数徽标的文字：超过 99 为 `99+`，被截断（`countMore`）时加 `+`。 */
const countText = (n: { count?: number; countMore?: boolean }): string =>
  (n.count ?? 0) > 99 ? "99+" : `${n.count ?? 0}${n.countMore ? "+" : ""}`;

export type TopBarProps = {
  /**
   * `count`：待处理数等（>0 时在名称后以计数 Badge 显示，0 / 缺省不显示）；`countMore`：实际比 `count` 多
   * （列表被截断），显示为 `<count>+`。
   */
  nav: { id: string; label: string; href: string; count?: number; countMore?: boolean }[];
  activeNav: string;
  org: { name: string; menu?: MenuItem[] } | null;
  /** 名称旁的 ▾ 由 TopBar 渲染；`menu` 为空时只显示名称、不可点击。 */
  user: { name: string; menu: MenuItem[] };
  commands: CommandGroup[];
  /**
   * 插件页面的下拉入口（导航之后的「扩展 ▾」）。`items` 为空或缺省时不显示。
   * `label` 缺省取 design 的「扩展」/「Extensions」。
   */
  extensions?: { label?: string; items: MenuItem[] };
};

export function TopBar({
  nav,
  activeNav,
  org,
  user,
  extensions,
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
                    .replace("{n}", countText(n)),
                }
              : {})}
          >
            {n.label}
            {n.count ? (
              <span className="cb-topbar-count">
                <Badge tone="count">{countText(n)}</Badge>
              </span>
            ) : null}
          </Link>
        ))}
        {overflow.length > 0 ? (
          <Menu
            items={overflow.map((n) => ({
              label: n.count ? `${n.label} (${countText(n)})` : n.label,
              href: n.href,
            }))}
            trigger={
              <button type="button" className="cb-topbar-link cb-topbar-more">
                {t("shell.more")} ▾
              </button>
            }
          />
        ) : null}
        {extensions && extensions.items.length > 0 ? (
          <Menu
            items={extensions.items}
            trigger={
              <button type="button" className="cb-topbar-link cb-topbar-more">
                {extensions.label ?? t("shell.extensions")} <span aria-hidden="true">▾</span>
              </button>
            }
          />
        ) : null}
      </nav>
      {compactSearch ? (
        <IconButton
          label={t("shell.searchShort")}
          icon=">"
          density="dense"
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
