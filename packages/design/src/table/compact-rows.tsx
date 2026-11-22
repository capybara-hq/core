import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { IconButton } from "../controls/button";
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

/**
 * The columns by role. The title column is the declared one, else the first column without a
 * role that is not `interactive` (never a column that declares another role); columns without a
 * role are not drawn.
 */
export function compactRoles<T>(columns: readonly Column<T>[]) {
  const title =
    columns.find((c) => c.compact === "title") ??
    columns.find((c) => c.compact === undefined && !c.interactive);
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

/** Cells joined with a middle dot, empty ones dropped; null when nothing is left. */
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

/** The drawn slots in order; a slot of several columns is one cell (and one header). */
function compactSlots<T>(columns: readonly Column<T>[]) {
  const roles = compactRoles(columns);
  return [
    { part: "title", cols: roles.title ? [roles.title] : [] },
    { part: "subtitle", cols: roles.subtitle },
    { part: "meta", cols: roles.meta },
    { part: "trailing", cols: roles.trailing ? [roles.trailing] : [] },
  ].filter((s) => s.cols.length > 0);
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
  /** The table has a `rowMenu`: every row draws the actions cell (a ⋯ button when it opens nothing). */
  menuColumn: boolean;
  menuLabel: string;
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
  menuColumn,
  menuLabel,
  onMenu,
  extra,
}: CompactRowProps<T>) {
  const slots = compactSlots(columns);
  const hasMenu = menuItems !== undefined && menuActions(menuItems).length > 0;
  const press = useLongPress(onMenu, { enabled: hasMenu });
  const value = (cols: readonly Column<T>[]) =>
    cols.length === 1 ? (cols[0] as Column<T>).cell(row) : joined(cols.map((c) => c.cell(row)));
  // Every declared slot draws its cell, empty or not, so each cell sits under its header.
  const cell = (part: string, cols: readonly Column<T>[]) => {
    const v = value(cols);
    return (
      <span
        key={part}
        className={`cb-table-compact-${part}`}
        {...ROLE.cell}
        data-part={`compact-${part}`}
        data-no-open={cols.length === 1 && cols[0]?.interactive ? "true" : undefined}
      >
        {shown(v) ? v : null}
      </span>
    );
  };
  const textSlots = slots.filter((s) => s.part !== "trailing");
  const trailingSlot = slots.find((s) => s.part === "trailing");
  const activate = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest?.("[data-no-open]")) return;
    open?.();
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || !open) return;
    if (e.key === "Enter" || e.key === " ") {
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
        {textSlots.map((s) => cell(s.part, s.cols))}
      </div>
      {trailingSlot ? cell(trailingSlot.part, trailingSlot.cols) : null}
      {menuColumn ? (
        // A row that opens nothing keeps its actions reachable by keyboard: one ⋯ button
        <span className="cb-table-compact-menu" {...ROLE.cell} data-no-open="true">
          {!open && hasMenu ? (
            <IconButton
              label={menuLabel}
              icon={<Icon name="more-horizontal" size={16} />}
              onClick={onMenu}
            />
          ) : null}
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

/**
 * The header kept for assistive tech: plain text, no controls (visually hidden by CSS). One
 * header per drawn slot (a slot of several columns names them joined with a middle dot), and the
 * actions header when the table has a row menu, so every row cell sits under its header.
 */
export function CompactHeader<T>({
  columns,
  menuLabel,
}: {
  columns: readonly Column<T>[];
  menuLabel?: string | undefined;
}) {
  return (
    <div className="cb-table-compact-head" {...ROLE.rowgroup}>
      <div {...ROLE.row}>
        {compactSlots(columns).map((s) => (
          <span key={s.part} {...ROLE.columnheader}>
            {s.cols.map((c) => c.header).join(" · ")}
          </span>
        ))}
        {menuLabel === undefined ? null : <span {...ROLE.columnheader}>{menuLabel}</span>}
      </div>
    </div>
  );
}
