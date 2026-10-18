import type { ReactNode } from "react";
import { useDesignLink } from "../provider";
import {
  ActionRow,
  type ActionRowProps,
  Body,
  PageHeader,
  type PageHeaderProps,
} from "../shell/index";

/** T5 设置：Rail（二级导航）+ 居中内容；有改动时出现 ActionRow。 */
export function SettingsPage({
  header,
  nav,
  activeNav,
  actionRow,
  children,
}: {
  header: PageHeaderProps;
  nav: { id: string; label: string; href: string }[];
  activeNav: string;
  actionRow?: ActionRowProps;
  children?: ReactNode;
}) {
  const Link = useDesignLink();
  const rail = (
    <nav className="cb-settings-nav">
      {nav.map((n) => (
        <Link
          key={n.id}
          href={n.href}
          className="cb-settings-nav-item"
          data-current={n.id === activeNav ? "true" : undefined}
          {...(n.id === activeNav ? { "aria-current": "page" as const } : {})}
        >
          {n.label}
        </Link>
      ))}
    </nav>
  );
  return (
    <div className="cb-template" data-template="SettingsPage">
      <PageHeader {...header} />
      <Body layout="rail" rail={rail} railFlush>
        <div className="cb-settings-content">{children}</div>
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
