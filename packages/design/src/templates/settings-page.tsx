import type { ReactNode } from "react";
import { useDesignLink } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

/** T5 Settings: Rail (second-level navigation) + content at the form width; ActionRow on changes. */
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
    <div className="cb-template" data-template="SettingsPage" data-width="form">
      <TemplateHead header={header} width="full" />
      <Body layout="rail" rail={rail} railFlush width="form">
        {children}
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
