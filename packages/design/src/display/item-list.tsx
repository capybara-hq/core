import { Children, type ReactNode, useId } from "react";
import { LinkPendingMark, useDesignLink } from "../provider";
import { EmptyState } from "./empty-state";

export type ItemListRow = {
  id: string;
  /** A short kind label before the title ("Tool approval"); `accent` for what waits on the viewer. */
  tag?: { label: string; tone?: "default" | "accent" };
  title: string;
  /** One muted line under the title (who, where, when). */
  meta?: string;
  /** A short state after the title ("Waiting for you"). */
  status?: { label: string; tone?: "default" | "accent" };
  /** The title links here. */
  href?: string;
  /** Buttons at the end of the row. */
  actions?: ReactNode;
};

/**
 * Where an item list sits (spec §6.12, §5.3): `card` (default) inside a padded box (a Card body, a
 * form card that holds other fields, a Sheet), the rows reaching the box's padding; `flush` alone
 * in a flush box (a `flush` FormSection), each row padded `space.4` so the hairlines run to the
 * box's edges, as a SwitchList's rows do.
 */
export type ItemListInset = "card" | "flush";

export type ItemListProps = {
  /** The list's accessible name. */
  label: string;
  /** Plain rows (tag, title, meta, status, actions); or pass `ItemListItem` children instead. */
  rows?: ItemListRow[];
  /** `ItemListItem`s: rows that hold more than one line (meta lines, fields, a review). */
  children?: ReactNode;
  /** Shown as the compact empty state when there are no rows (and no children). */
  empty?: string;
  inset?: ItemListInset;
};

/**
 * Rows of things to look at, act on or edit inside one box (spec §6.12, §1 "One box is enough"):
 * an agent's channels, the org chooser's orgs, the model purposes, a plugin's permissions. The
 * rows are split by `line-soft` hairlines, never drawn as cards. Plain rows come as `rows`; rows
 * with more in them (meta lines, fields, a warning and its code) are `ItemListItem` children.
 * Empty, it shows `empty` as the compact empty state.
 */
export function ItemList({ label, rows, children, empty, inset = "card" }: ItemListProps) {
  const Link = useDesignLink();
  const hasChildren = Children.toArray(children).length > 0;
  if ((rows ?? []).length === 0 && !hasChildren) {
    return empty ? <EmptyState size="compact" text={empty} /> : null;
  }
  return (
    <ul
      className="cb-item-list"
      data-part="item-list"
      data-inset={inset === "flush" ? "flush" : undefined}
      aria-label={label}
    >
      {(rows ?? []).map((r) => (
        <li key={r.id} className="cb-item-list-row" data-part="item-list-row">
          {r.tag ? (
            <span className="cb-item-list-tag" data-tone={r.tag.tone ?? "default"}>
              {r.tag.label}
            </span>
          ) : null}
          <span className="cb-item-list-text">
            {r.href ? (
              <Link href={r.href} className="cb-item-list-title">
                {r.title}
                <LinkPendingMark />
              </Link>
            ) : (
              <span className="cb-item-list-title">{r.title}</span>
            )}
            {r.meta ? <span className="cb-item-list-meta">{r.meta}</span> : null}
          </span>
          {r.status ? (
            <span className="cb-item-list-status" data-tone={r.status.tone ?? "default"}>
              {r.status.label}
            </span>
          ) : null}
          {r.actions ? <span className="cb-item-list-actions">{r.actions}</span> : null}
        </li>
      ))}
      {children}
    </ul>
  );
}

export type ItemListItemProps = {
  /** The row's name (`body` 500): what the old card's title said. */
  title: string;
  /** A mono id after the title (`small`, `muted`): a purpose id, a key. */
  code?: string;
  /** Marks after the title and the id on the title line: a `Badge`, a muted state word. */
  marks?: ReactNode;
  /** A short kind label before the title. */
  tag?: { label: string; tone?: "default" | "accent" };
  /** The title links here. */
  href?: string;
  /** Buttons at the end of the title line (dense). */
  actions?: ReactNode;
  /** Lines under the title line (`small` text, `space.1` apart): who declares it, a default. */
  meta?: ReactNode;
  /** A 2px `fail` bar on the row's left: something in it needs fixing. */
  invalid?: boolean;
  /** The row's body under its lines: fields, a list, a warning and its code. */
  children?: ReactNode;
};

/**
 * One row of an {@link ItemList} that holds more than a line (spec §6.12): the title line (the
 * title, its mono id, marks, and actions at the right), `meta` lines under it, then the body
 * (fields, a review), `space.3` below. With a body the row is a `group` named by its title, so its
 * fields read as that row's ("用途 eval › 模型").
 */
export function ItemListItem({
  title,
  code,
  marks,
  tag,
  href,
  actions,
  meta,
  invalid,
  children,
}: ItemListItemProps) {
  const Link = useDesignLink();
  const id = useId();
  // Empty nodes (null, false, an empty array) draw no lines and no body.
  const body = Children.toArray(children).length > 0;
  const lines = Children.toArray(meta).length > 0;
  return (
    <li
      className="cb-item-list-row"
      data-part="item-list-row"
      data-shape="item"
      data-invalid={invalid ? "true" : undefined}
    >
      <div
        className="cb-item-list-item"
        {...(body ? { role: "group", "aria-labelledby": id } : {})}
      >
        <div className="cb-item-list-head" data-part="item-list-head">
          {tag ? (
            <span className="cb-item-list-tag" data-tone={tag.tone ?? "default"}>
              {tag.label}
            </span>
          ) : null}
          <span className="cb-item-list-titles">
            {href ? (
              <Link href={href} className="cb-item-list-title" data-part="item-list-title">
                <span id={id}>{title}</span>
                <LinkPendingMark />
              </Link>
            ) : (
              <span className="cb-item-list-title" data-part="item-list-title" id={id}>
                {title}
              </span>
            )}
            {code ? (
              <span className="cb-item-list-code" data-part="item-list-code">
                {code}
              </span>
            ) : null}
            {marks}
          </span>
          {actions ? <span className="cb-item-list-actions">{actions}</span> : null}
        </div>
        {lines ? (
          <div className="cb-item-list-lines" data-part="item-list-meta">
            {meta}
          </div>
        ) : null}
        {body ? (
          <div className="cb-item-list-body" data-part="item-list-body">
            {children}
          </div>
        ) : null}
      </div>
    </li>
  );
}
