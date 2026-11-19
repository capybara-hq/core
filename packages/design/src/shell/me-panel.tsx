import type { ReactNode } from "react";
import { initialOf } from "../display/initial";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Menu, type MenuItem } from "../overlays/index";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import { type PreferenceBarProps, ThemeToggle } from "./preference-bar";
import { ContextBlock, OrgSwitcher, type SidebarOrg } from "./sidebar";

/**
 * One row of the Me page (design spec §6.48). A row is a link (`href`: a `chevron-right` at the
 * end, or an outward `arrow-up-right` when `external`), a button (`onSelect`), a button that opens
 * a menu (`menu`, with `value` at the end), or carries the theme toggle (`theme`). Never a
 * context-menu-only action.
 */
export type MeRow = {
  id: string;
  label: string;
  icon: IconName;
  href?: string;
  /** The row enters another context (the admin console): an outward arrow instead of the chevron. */
  external?: boolean;
  onSelect?(): void;
  /** The current value in `muted` at the end (the language). */
  value?: string;
  /** Opens this menu (the languages); the row is its trigger. */
  menu?: MenuItem[];
  /** The theme toggle at the end of the row. */
  theme?: NonNullable<PreferenceBarProps["theme"]>;
};

export type MePanelProps = {
  /** The account row: the initial avatar and the name. */
  account: { name: string };
  /** The work context's org switcher (the sidebar's); `null` in the admin context. */
  org: SidebarOrg | null;
  /**
   * The admin context: the context block takes the switcher's place, the Workspace group is not drawn
   * and `manage` lists the console's pages, `back` last.
   */
  adminContext?: boolean;
  /** The Workspace group (work context): the sidebar's primary items and Devices, then the extension pages. */
  workspace?: MeRow[];
  /** The Manage group: org admins' items and the admin entry; in the admin context the console's pages. */
  manage?: MeRow[];
  /** The admin context's way back (Back to workspace), the last row of the Manage group. */
  back?: MeRow;
  /** The Account group: personal settings, language, theme, sign out. */
  accountRows: MeRow[];
  /** The StatusBar's system line, which compact has no StatusBar for. */
  system?: string;
};

/**
 * The body of the Me tab (design spec §6.48): the compact class's home for what the sidebar holds,
 * in no box: headings, hairlines and space. A group with no row draws neither its label nor its
 * rows (hiding by role is cosmetic; the caller passes only the rows the role sees).
 */
export function MePanel({
  account,
  org,
  adminContext,
  workspace = [],
  manage = [],
  back,
  accountRows,
  system,
}: MePanelProps) {
  const t = useDesignT();
  const group = (id: string, label: string, rows: ReactNode[]) =>
    rows.length === 0 ? null : (
      <section className="cb-me-group" data-part="group" data-group={id} aria-label={label}>
        <h2 className="cb-me-label" data-part="group-label">
          {label}
        </h2>
        {rows}
      </section>
    );
  const row = (r: MeRow) => <MeRowView key={r.id} row={r} />;
  return (
    <div className="cb-me" data-part="me-panel" data-context={adminContext ? "admin" : undefined}>
      <div className="cb-me-head">
        <div className="cb-me-account" data-part="account">
          <span className="cb-me-avatar" aria-hidden="true">
            {initialOf(account.name)}
          </span>
          <span className="cb-me-ellipsis">{account.name}</span>
        </div>
        {adminContext ? (
          <ContextBlock rail={false} />
        ) : org ? (
          <OrgSwitcher org={org} rail={false} />
        ) : null}
      </div>
      {adminContext ? null : group("workspace", t("me.workspace"), workspace.map(row))}
      {group("manage", t("me.manage"), [
        ...manage.map(row),
        ...(adminContext && back ? [row(back)] : []),
      ])}
      {group("account", t("shell.account"), accountRows.map(row))}
      {system ? (
        <p className="cb-me-system" data-part="system-status">
          {system}
        </p>
      ) : null}
    </div>
  );
}

function MeRowView({ row }: { row: MeRow }) {
  const Link = useDesignLink();
  const part =
    row.id === "admin" && row.external ? "admin-entry" : row.id === "back" ? "back-row" : "row";
  const common = { className: "cb-me-row", "data-part": part, "data-id": row.id } as const;
  const lead = <Icon name={row.icon} size={16} />;
  const label = <span className="cb-me-ellipsis">{row.label}</span>;
  if (row.theme !== undefined) {
    return (
      <div {...common}>
        {lead}
        {label}
        <ThemeToggle {...row.theme} />
      </div>
    );
  }
  if (row.menu !== undefined) {
    return (
      <Menu
        items={row.menu}
        label={row.label}
        trigger={
          <button type="button" {...common}>
            {lead}
            {label}
            {row.value ? <span className="cb-me-value">{row.value}</span> : null}
          </button>
        }
      />
    );
  }
  if (row.href !== undefined) {
    return (
      <Link href={row.href} {...common}>
        {lead}
        {label}
        {row.id === "back" ? null : row.external ? (
          <Icon name="arrow-up-right" size={14} />
        ) : (
          <Icon name="chevron-right" size={12} />
        )}
        <LinkPendingMark />
      </Link>
    );
  }
  return (
    <button type="button" {...common} onClick={() => row.onSelect?.()}>
      {lead}
      {label}
      {row.value ? <span className="cb-me-value">{row.value}</span> : null}
    </button>
  );
}
