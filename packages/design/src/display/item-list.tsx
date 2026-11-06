import type { ReactNode } from "react";
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
 * Rows of things to look at or act on inside a Card (an agent's channels, the org chooser's orgs):
 * tag, title and meta, status, actions; rows split by `line-soft` (spec §6.12). Empty, it
 * shows `empty` as the compact empty state.
 */
export function ItemList({
  label,
  rows,
  empty,
}: {
  label: string;
  rows: ItemListRow[];
  empty?: string;
}) {
  const Link = useDesignLink();
  if (rows.length === 0) {
    return empty ? <EmptyState size="compact" text={empty} /> : null;
  }
  return (
    <ul className="cb-item-list" aria-label={label}>
      {rows.map((r) => (
        <li key={r.id} className="cb-item-list-row">
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
    </ul>
  );
}
