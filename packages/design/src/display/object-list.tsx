import { Fragment, type ReactNode } from "react";
import { Button, IconButton, LinkButton } from "../controls/index";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { BoxScope } from "../layout/box";
import { Menu, type MenuItem, menuActions, menuLone } from "../overlays/index";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import { Avatar, type AvatarValue } from "./avatar";
import { MarkImage } from "./object-mark";
import { SkeletonBox, SkeletonText, useSkeletonAnnounces } from "./skeleton";

export type ObjectRowProps = {
  /**
   * The 36 px mark: `text` is the display name, drawn as its upper-cased first grapheme (the one
   * avatar-tile rule); `image`, for a thing a plugin brings (a channel, an extension, a model
   * provider), the plugin's declared icon at 24 on the tile, the initial when it fails to load
   * (maintainer decision 2026-11-08); `icon` only for rows that are steps, not objects; `warn`
   * when it needs attention. `avatar` (an agent's row): its `Avatar` at 28 (§6.30) in the mark's
   * 36 px place; `null` draws the initial square.
   */
  mark: {
    text?: string;
    image?: string | null;
    icon?: IconName;
    tone?: "neutral" | "warn";
    avatar?: AvatarValue;
  };
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
  action?: { label: string; href?: string; onSelect?(): void; loading?: boolean };
  menu?: MenuItem[];
  /**
   * An action of the row is running (spec §6.17): every button of the row is disabled until it
   * settles, and the menu button (or the menu's lone item drawn as a button) shows the spinner
   * unless the row action's own `loading` does.
   */
  busy?: boolean;
};

/** A button or link at the row's right: the row action, or a menu's lone item. */
type RowButton = { label: string; href?: string; onSelect?(): void; loading?: boolean };

/** Skeleton rows an object list shows while it loads (spec §6.17). */
const SKELETON_ROWS = 3;

/**
 * The panel of an object list: rows split by `line-soft` (spec §6.17). `loading` (true, or a row
 * count) draws skeleton rows in the row's shape instead of the children (a mark box and a name and
 * a description line, in the one bar look of spec §6.29), and marks the list busy. Inside a skeleton
 * group the group announces.
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
  const announces = useSkeletonAnnounces();
  if (loading === undefined || loading === false) {
    return (
      <ul className="cb-object-list" aria-label={label}>
        <BoxScope kind="object-list">{children}</BoxScope>
      </ul>
    );
  }
  const rows = loading === true ? SKELETON_ROWS : loading;
  return (
    <ul className="cb-object-list" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the skeleton rows are positional
        <li key={i} className="cb-object-row" data-skeleton="true">
          <SkeletonBox part="mark" />
          <span className="cb-object-text">
            <SkeletonText width="30%" />
            <SkeletonText width="55%" />
          </span>
          {i === 0 && announces ? <span className="cb-sr-only">{t("table.loading")}</span> : null}
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
  busy,
}: ObjectRowProps) {
  const Link = useDesignLink();
  const t = useDesignT();
  // No menu of one (spec §6.7): a lone safe item is drawn as a second row action; a lone
  // destructive one stays in the menu; none, no menu.
  const actions = menuActions(menu ?? []);
  const lone = menuLone(menu ?? []);
  const actionLoading = action?.loading === true;
  const waiting = busy === true || actionLoading;
  // The spinner goes where the running action is: the row action, else the menu (or its lone item)
  const menuLoading = busy === true && !actionLoading;
  const single: RowButton | undefined = lone && {
    label: lone.label,
    ...(menuLoading ? { loading: true } : {}),
    ...(lone.href !== undefined ? { href: lone.href } : {}),
    ...(lone.onSelect ? { onSelect: lone.onSelect } : {}),
  };
  const slots: (RowButton | undefined)[] = [action, single];
  const hasMeta = meta !== undefined && meta.length > 0;
  return (
    <li className="cb-object-row">
      {mark.avatar !== undefined ? (
        <span className="cb-object-mark" data-kind="avatar" aria-hidden="true">
          <Avatar value={mark.avatar} name={mark.text ?? name} size={28} />
        </span>
      ) : (
        <span
          className="cb-object-mark"
          data-tone={mark.tone ?? "neutral"}
          data-kind={mark.image ? "image" : undefined}
          aria-hidden="true"
        >
          {mark.icon ? (
            <Icon name={mark.icon} size={16} />
          ) : (
            <MarkImage
              {...(mark.image ? { src: mark.image } : {})}
              text={mark.text ?? ""}
              size={24}
            />
          )}
        </span>
      )}
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
        {hasMeta || state ? (
          // Below 640 the state is drawn at the end of this line (spec §4.3, §6.17): the CSS reads
          // it from `data-state` / `data-state-tone`, so the label stays one node in the DOM (the
          // row's own state label, hidden on phones). A row with a state and no meta keeps an
          // empty meta line for it, drawn only on phones.
          <span
            className="cb-object-meta"
            data-empty={hasMeta ? undefined : "true"}
            data-state={state?.label}
            data-state-tone={state?.tone}
          >
            {hasMeta && meta !== undefined ? (
              <span className="cb-object-meta-text">
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
        ) : null}
      </span>
      {state ? (
        <span className="cb-object-state" data-tone={state.tone}>
          {state.label}
        </span>
      ) : null}
      {trailing ? <span className="cb-object-trailing">{trailing}</span> : null}
      {action || single ? (
        // The row's buttons in one group: one flex item below 640 (it moves to the meta line,
        // or wraps under it as a whole), `display: contents` above, so the row lays them out.
        <span className="cb-object-actions">
          {slots.map((a, i) =>
            a === undefined ? null : a.href !== undefined ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots (the action, a lone menu item)
              <LinkButton key={i} href={a.href} variant="default" density="dense">
                {a.label}
              </LinkButton>
            ) : (
              <Button
                // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots (the action, a lone menu item)
                key={i}
                variant="default"
                density="dense"
                loading={a.loading === true}
                disabled={waiting}
                {...(a.onSelect ? { onClick: a.onSelect } : {})}
              >
                {a.label}
              </Button>
            ),
          )}
        </span>
      ) : null}
      {actions.length > 0 && lone === undefined ? (
        <Menu
          items={menu ?? []}
          trigger={
            <IconButton
              label={t("shell.moreActions")}
              icon={
                menuLoading ? (
                  <span className="cb-btn-spin" aria-hidden="true">
                    <Icon name="spinner" size={14} />
                  </span>
                ) : (
                  <Icon name="more-horizontal" />
                )
              }
              density="dense"
              variant="default"
              className="cb-object-menu"
              disabled={waiting}
              aria-busy={menuLoading ? true : undefined}
            />
          }
        />
      ) : null}
    </li>
  );
}
