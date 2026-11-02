import { Fragment, type ReactNode } from "react";
import { Button, IconButton } from "../controls/index";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Menu, type MenuItem, menuActions } from "../overlays/index";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";

export type ObjectRowProps = {
  /** The 36 px mark: initials (mono) or the object's icon; `warn` when it needs attention. */
  mark: { text?: string; icon?: IconName; tone?: "neutral" | "warn" };
  name: string;
  /** The name links here. */
  href?: string;
  /** Package names and ids are mono. */
  mono?: boolean;
  /** Scope / kind chips and attention chips after the name. */
  chips?: { label: string; tone?: "neutral" | "warn" }[];
  /** One line in `muted`. */
  description?: string;
  /**
   * One mono line in `faint`; as a list, the parts are joined with " · " and a `{ label, tone:
   * "warn" }` part is drawn in `warn` (a sensitive-permission count).
   */
  meta?: string | (string | { label: string; tone: "warn" })[];
  /** A mono state label with its color. */
  state?: { label: string; tone: "ok" | "warn" | "fail" | "muted" };
  /** A short mono text at the right (last use). */
  trailing?: string;
  /**
   * The row's most common action, always a secondary (`default`) button or link: the page head
   * holds the one primary of the screen (spec §6.17); urgency is the row's `state`.
   */
  action?: { label: string; href?: string; onSelect?(): void };
  menu?: MenuItem[];
};

/** A button or link at the row's right: the row action, or a menu's lone item. */
type RowButton = { label: string; href?: string; onSelect?(): void; danger?: boolean };

/** Skeleton rows an object list shows while it loads (spec §6.17). */
const SKELETON_ROWS = 3;

/**
 * The panel of an object list: rows split by `line-soft` (spec §6.17). `loading` (true, or a row
 * count) draws skeleton rows in the 64 px row shape instead of the children, and marks the list
 * busy.
 */
export function ObjectList({
  label,
  loading,
  children,
}: {
  label: string;
  loading?: boolean | number;
  children?: ReactNode;
}) {
  const t = useDesignT();
  if (loading === undefined || loading === false) {
    return (
      <ul className="cb-object-list" aria-label={label}>
        {children}
      </ul>
    );
  }
  const rows = loading === true ? SKELETON_ROWS : loading;
  return (
    <ul className="cb-object-list" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the skeleton rows are positional
        <li key={i} className="cb-object-row" data-skeleton="true">
          <span className="cb-object-mark" aria-hidden="true" />
          <span className="cb-object-text" aria-hidden="true">
            <span className="cb-object-bar" data-line="name" />
            <span className="cb-object-bar" data-line="desc" />
          </span>
          {i === 0 ? <span className="cb-sr-only">{t("table.loading")}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** One object of an object list: mark, name and chips, description, meta, state, action, menu. */
export function ObjectRow({
  mark,
  name,
  href,
  mono,
  chips,
  description,
  meta,
  state,
  trailing,
  action,
  menu,
}: ObjectRowProps) {
  const Link = useDesignLink();
  const t = useDesignT();
  // No menu of one (spec §6.7): a lone item is drawn as a second row action; none, no menu.
  const actions = menuActions(menu ?? []);
  const lone = actions.length === 1 && actions[0]?.submenu === undefined ? actions[0] : undefined;
  const single: RowButton | undefined = lone && {
    label: lone.label,
    ...(lone.href !== undefined ? { href: lone.href } : {}),
    ...(lone.onSelect ? { onSelect: lone.onSelect } : {}),
    ...(lone.danger ? { danger: true } : {}),
  };
  const slots: (RowButton | undefined)[] = [action, single];
  return (
    <li className="cb-object-row">
      <span className="cb-object-mark" data-tone={mark.tone ?? "neutral"} aria-hidden="true">
        {mark.icon ? <Icon name={mark.icon} size={16} /> : mark.text}
      </span>
      <span className="cb-object-text">
        <span className="cb-object-line">
          {href ? (
            <Link href={href} className="cb-object-name" data-mono={mono ? "true" : undefined}>
              {name}
              <LinkPendingMark />
            </Link>
          ) : (
            <span className="cb-object-name" data-mono={mono ? "true" : undefined}>
              {name}
            </span>
          )}
          {chips?.map((c) => (
            <span key={c.label} className="cb-object-chip" data-tone={c.tone ?? "neutral"}>
              {c.label}
            </span>
          ))}
        </span>
        {description ? <span className="cb-object-desc">{description}</span> : null}
        {meta && meta.length > 0 ? (
          <span className="cb-object-meta">
            {typeof meta === "string"
              ? meta
              : meta.map((m, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional
                  <Fragment key={i}>
                    {i > 0 ? " · " : null}
                    {typeof m === "string" ? (
                      m
                    ) : (
                      <span className="cb-object-meta-part" data-tone={m.tone}>
                        {m.label}
                      </span>
                    )}
                  </Fragment>
                ))}
          </span>
        ) : null}
      </span>
      {state ? (
        <span className="cb-object-state" data-tone={state.tone}>
          {state.label}
        </span>
      ) : null}
      {trailing ? <span className="cb-object-trailing">{trailing}</span> : null}
      {slots.map((a, i) =>
        a === undefined ? null : a.href !== undefined ? (
          <Link
            // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots (the action, a lone menu item)
            key={i}
            href={a.href}
            className="cb-btn cb-btn-link cb-btn-link-default"
            data-density="dense"
          >
            <span className="cb-btn-body">{a.label}</span>
          </Link>
        ) : (
          <Button
            // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots (the action, a lone menu item)
            key={i}
            variant={a.danger ? "danger" : "default"}
            density="dense"
            {...(a.onSelect ? { onClick: a.onSelect } : {})}
          >
            {a.label}
          </Button>
        ),
      )}
      {actions.length > 0 && lone === undefined ? (
        <Menu
          items={menu ?? []}
          trigger={
            <IconButton
              label={t("shell.moreActions")}
              icon={<Icon name="more-horizontal" />}
              density="dense"
              variant="default"
            />
          }
        />
      ) : null}
    </li>
  );
}
