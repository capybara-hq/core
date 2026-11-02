import { type ReactNode, useEffect, useRef } from "react";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

export type SettingsNavGroup = {
  group: string;
  items: { id: string; label: string; href: string; count?: number }[];
};

/**
 * T5 Settings (spec §5, canvas "组织 · 设置"): the head (path, title, actions) across the full
 * content width, then a 200 px sub-nav (mono group labels, 30 px items, the current one on
 * `sidebar-active`, mono counts) beside the section content; ActionRow on changes. The header's
 * `description` opens the content column instead of the head, so the head has one height and the
 * sub-nav sits at the same y on every settings page, its top aligned with the content's. Below
 * 640 the sub-nav is a compact control: one horizontally scrolling row of its items (no group
 * labels, 40 px tap targets) above the content, the current item scrolled into view.
 */
export function SettingsPage({
  header,
  nav,
  activeNav,
  actionRow,
  children,
}: {
  header: PageHeaderProps;
  nav: SettingsNavGroup[];
  activeNav: string;
  actionRow?: ActionRowProps;
  children?: ReactNode;
}) {
  const { description, ...head } = header;
  const Link = useDesignLink();
  const t = useDesignT();
  // On phones the sub-nav is one scrolling row above the content: keep the current item in view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = current.offsetLeft - nav.offsetLeft;
  }, []);
  const rail = (
    <nav
      ref={navRef}
      className="cb-settings-nav"
      data-part="settings-nav"
      aria-label={t("settings.nav")}
    >
      {nav.map((g) => (
        <div key={g.group} className="cb-settings-nav-section">
          <span className="cb-settings-nav-group">{g.group}</span>
          {g.items.map((n) => (
            <Link
              key={n.id}
              href={n.href}
              className="cb-settings-nav-item"
              data-current={n.id === activeNav ? "true" : undefined}
              {...(n.id === activeNav ? { "aria-current": "page" as const } : {})}
            >
              <span>{n.label}</span>
              {n.count !== undefined ? (
                <span className="cb-settings-nav-count">{n.count}</span>
              ) : null}
              <LinkPendingMark />
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
  return (
    <div className="cb-template" data-template="SettingsPage" data-width="content">
      <TemplateHead header={head} />
      <Body layout="single" width="content">
        <div className="cb-settings-grid">
          {rail}
          <div className="cb-settings-content">
            {description ? (
              <p className="cb-settings-description" data-part="settings-description">
                {description}
              </p>
            ) : null}
            {children}
          </div>
        </div>
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
