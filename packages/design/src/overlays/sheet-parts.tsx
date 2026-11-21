import type { ComponentPropsWithRef, ReactNode } from "react";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { LinkPendingMark, useDesignLink } from "../provider";

// The bottom sheet's body parts (design spec §6.59, maintainer decision 2026-11-22): grouped rows
// on grounds over the sheet's own surface, `touch.sheet-inset` from its edges and apart, and a
// footnote. Every bottom sheet composes these; none draws its own rows.

/**
 * A group of rows on the `hover` ground (`radius.sm`; a ground, not a box: no border), the rows
 * split by `line-soft` separators inset to the text column.
 */
export function SheetGroup({
  label,
  part,
  children,
}: {
  /** The group's accessible name (drawn nowhere). */
  label?: string;
  part?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="cb-sheet-group"
      data-part={part ?? "sheet-group"}
      {...(label ? { role: "group", "aria-label": label } : {})}
    >
      {children}
    </div>
  );
}

type RowLook = {
  /** The leading icon (the icon column; a row without one keeps the column empty). */
  icon?: IconName;
  label: ReactNode;
  /** A muted line under the label (the profile row's). */
  description?: string;
  /** A muted value at the end (the current org, the language). */
  value?: string;
  /** A control at the end instead of a value (the theme switch). */
  control?: ReactNode;
  /** A chevron at the end: the row opens something (a page, a menu). */
  chevron?: boolean;
  /** A leading node instead of the icon (the profile row's avatar). */
  lead?: ReactNode;
  /** Centred text in the row (sign out). */
  centered?: boolean;
  /** The row's text in `fail` (sign out). */
  danger?: boolean;
  part?: string;
};

function RowBody({ icon, lead, label, description, value, control, chevron }: RowLook) {
  return (
    <>
      {lead ?? (
        <span className="cb-sheet-row-icon" aria-hidden="true">
          {icon ? <Icon name={icon} size={16} /> : null}
        </span>
      )}
      <span className="cb-sheet-row-text">
        <span className="cb-sheet-row-label">{label}</span>
        {description ? <span className="cb-sheet-row-desc">{description}</span> : null}
      </span>
      {value !== undefined ? <span className="cb-sheet-row-value">{value}</span> : null}
      {control ?? null}
      {chevron ? <Icon name="chevron-right" size={16} /> : null}
    </>
  );
}

const rowAttrs = (look: RowLook) => ({
  className: "cb-sheet-row",
  "data-part": look.part ?? "sheet-row",
  "data-centered": look.centered ? "true" : undefined,
  "data-danger": look.danger ? "true" : undefined,
  "data-lead": look.lead ? "true" : undefined,
});

/**
 * One row of a SheetGroup, `touch.row` high: the icon column, the label (and an optional muted
 * line), then a value, a control or a chevron. With `href` a link (a pick: it closes the sheet);
 * `static` draws text, `control` a row around its control; otherwise a button (`onSelect`, or a
 * menu's trigger, which passes its own props and ref; a chevron row without `onSelect` opens
 * something in place and is no pick).
 */
export function SheetRow({
  href,
  onSelect,
  stay,
  icon,
  label,
  description,
  value,
  control,
  chevron,
  lead,
  centered,
  danger,
  part,
  static: isStatic,
  ...rest
}: RowLook & {
  href?: string;
  onSelect?: () => void;
  /** A button row that keeps the page (a native sheet): `data-drawer-pick="stay"`. */
  stay?: boolean;
  /** Static text, not a control (one org: its name, no chevron). */
  static?: boolean;
} & Omit<ComponentPropsWithRef<"button">, "children" | "type">) {
  const Link = useDesignLink();
  const look: RowLook = {
    ...(icon ? { icon } : {}),
    label,
    ...(description ? { description } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(control ? { control } : {}),
    ...(chevron ? { chevron } : {}),
    ...(lead ? { lead } : {}),
    ...(centered ? { centered } : {}),
    ...(danger ? { danger } : {}),
    ...(part ? { part } : {}),
  };
  if (href !== undefined) {
    return (
      <Link href={href} {...rowAttrs(look)} data-drawer-pick="true">
        <RowBody {...look} />
        <LinkPendingMark />
      </Link>
    );
  }
  if (isStatic) {
    return (
      <div {...rowAttrs(look)} data-static="true">
        <RowBody {...look} />
      </div>
    );
  }
  if (control) {
    // a row holding its own control is not a button itself
    return (
      <div {...rowAttrs(look)}>
        <RowBody {...look} />
      </div>
    );
  }
  return (
    <button
      type="button"
      {...rest}
      {...rowAttrs(look)}
      onClick={(e) => {
        rest.onClick?.(e);
        onSelect?.();
      }}
      {...(chevron && onSelect === undefined ? {} : { "data-drawer-pick": stay ? "stay" : "true" })}
    >
      <RowBody {...look} />
    </button>
  );
}

/** A small, faint, centred line under the groups (the account sheet's status line); it wraps. */
export function SheetFootnote({ children, part }: { children: ReactNode; part?: string }) {
  return (
    <p className="cb-sheet-footnote" data-part={part ?? "sheet-footnote"}>
      {children}
    </p>
  );
}
