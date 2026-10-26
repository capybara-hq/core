import type { ReactNode } from "react";
import { useDesignLink, useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

/**
 * T5 Settings: the second-level navigation rail beside one content column that holds the header
 * and the content at the form width (the title lines up with the content); ActionRow on changes.
 */
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
  const t = useDesignT();
  const rail = (
    <nav className="cb-settings-nav" aria-label={t("settings.nav")}>
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
      <Body
        layout="rail"
        rail={rail}
        railFlush
        railCollapsible={false}
        head={<TemplateHead header={header} width="form" />}
        width="form"
      >
        {children}
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
