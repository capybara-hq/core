import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon } from "../icons/icon";
import { useLongPress } from "../overlays/long-press";
import type { MenuItem } from "../overlays/menus";
import { menuActions } from "../overlays/menus";
import type { Column } from "./types";

/** True when any column declares a compact role: the table then draws grouped rows below 600. */
export function declaresCompact<T>(columns: readonly Column<T>[]): boolean {
  return columns.some((c) => c.compact !== undefined);
}

/** At most one trailing column (design spec §6.6). Throws in development and tests. */
export function assertCompactColumns<T>(columns: readonly Column<T>[]): void {
  if (columns.filter((c) => c.compact === "trailing").length <= 1) return;
  const msg = "DataTable: at most one column may declare compact: 'trailing'";
  if (process.env.NODE_ENV === "production") console.error(msg);
  else throw new Error(msg);
}

/** The columns by role; the title column is the declared one, else the first column. */
export function compactRoles<T>(columns: readonly Column<T>[]) {
  const title = columns.find((c) => c.compact === "title") ?? columns[0];
  const pick = (role: "subtitle" | "meta") =>
    columns.filter((c) => c.compact === role && !c.interactive);
  return {
    title,
    subtitle: pick("subtitle"),
    meta: pick("meta"),
    trailing: columns.find((c) => c.compact === "trailing"),
  };
}

const shown = (v: ReactNode) => v != null && v !== false && v !== "";

/** Cells joined with 「 · 」, empty ones dropped; null when nothing is left. */
function joined(parts: ReactNode[]): ReactNode {
  const items = parts.filter(shown);
  if (items.length === 0) return null;
  return items.map((p, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: a static list of cells
    <Fragment key={i}>
      {i > 0 ? " · " : null}
      {p}
    </Fragment>
  ));
}

/** Explicit roles ({@link ROLE} in DataTable.tsx): spread because a linter only sees the elements. */
const ROLE = {
  rowgroup: { role: "rowgroup" },
  row: { role: "row" },
  columnheader: { role: "columnheader" },
  cell: { role: "cell" },
} as const;

export type CompactRowProps<T> = {
  row: T;
  rowKey: string;
  columns: readonly Column<T>[];
  lead?: ReactNode | undefined;
  state?: string | undefined;
  active: boolean;
  disabled: boolean;
  open?: (() => void) | undefined;
  menuItems?: MenuItem[] | undefined;
  onMenu(): void;
  extra?: ReactNode | undefined;
};

/** One grouped row: lead, text column, trailing slot, chevron (design spec §6.6 "Row mapping"). */
export function CompactRow<T>({
  row,
  rowKey,
  columns,
  lead,
  state,
  active,
  disabled,
  open,
  menuItems,
  onMenu,
  extra,
}: CompactRowProps<T>) {
  const roles = compactRoles(columns);
  const hasMenu = menuItems !== undefined && menuActions(menuItems).length > 0;
  const press = useLongPress(onMenu, { enabled: hasMenu });
  const subtitle = joined(roles.subtitle.map((c) => c.cell(row)));
  const meta = joined(roles.meta.map((c) => c.cell(row)));
  const trailing = roles.trailing ? roles.trailing.cell(row) : null;
  const activate = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest?.("[data-no-open]")) return;
    open?.();
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || !open) return;
    if (e.key === "Enter") {
      e.preventDefault();
      open();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the explicit row role is spread (ROLE)
    <div
      className="cb-table-compact-row"
      {...ROLE.row}
      data-part="compact-row"
      data-row-key={rowKey}
      data-state={state}
      data-lead={shown(lead) ? "true" : undefined}
      data-open={open ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      aria-disabled={disabled ? "true" : undefined}
      tabIndex={open ? 0 : undefined}
      onClick={open ? activate : undefined}
      onKeyDown={onKey}
      {...press}
    >
      {shown(lead) ? (
        <span className="cb-table-compact-lead" data-part="compact-lead">
          {lead}
        </span>
      ) : null}
      <div className="cb-table-compact-text" data-part="compact-text">
        <span className="cb-table-compact-title" {...ROLE.cell} data-part="compact-title">
          {roles.title?.cell(row)}
        </span>
        {subtitle ? (
          <span className="cb-table-compact-subtitle" {...ROLE.cell} data-part="compact-subtitle">
            {subtitle}
          </span>
        ) : null}
        {meta ? (
          <span className="cb-table-compact-meta" {...ROLE.cell} data-part="compact-meta">
            {meta}
          </span>
        ) : null}
      </div>
      {shown(trailing) ? (
        <span
          className="cb-table-compact-trailing"
          {...ROLE.cell}
          data-part="compact-trailing"
          data-no-open={roles.trailing?.interactive ? "true" : undefined}
        >
          {trailing}
        </span>
      ) : null}
      {open ? (
        <span className="cb-table-compact-chevron" aria-hidden="true" data-part="compact-chevron">
          <Icon name="chevron-right" size={16} />
        </span>
      ) : null}
      {extra ? (
        <div className="cb-table-compact-expand" data-no-open="true">
          {extra}
        </div>
      ) : null}
    </div>
  );
}

/** The header kept for assistive tech: plain text, no controls (visually hidden by CSS). */
export function CompactHeader<T>({ columns }: { columns: readonly Column<T>[] }) {
  const roles = compactRoles(columns);
  const drawn = [roles.title, ...roles.subtitle, ...roles.meta, roles.trailing].filter(
    (c): c is Column<T> => c !== undefined,
  );
  return (
    <div className="cb-table-compact-head" {...ROLE.rowgroup}>
      <div {...ROLE.row}>
        {drawn.map((c) => (
          <span key={c.key} {...ROLE.columnheader}>
            {c.header}
          </span>
        ))}
      </div>
    </div>
  );
}
