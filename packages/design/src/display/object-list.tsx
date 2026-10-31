import type { ReactNode } from "react";
import { Button, IconButton } from "../controls/index";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Menu, type MenuItem } from "../overlays/index";
import { useDesignLink, useDesignT } from "../provider";

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
  /** One mono line in `faint`. */
  meta?: string;
  /** A mono state label with its color. */
  state?: { label: string; tone: "ok" | "warn" | "fail" | "muted" };
  /** A short mono text at the right (last use). */
  trailing?: string;
  /** The row's most common action. */
  action?: { label: string; primary?: boolean; href?: string; onSelect?(): void };
  menu?: MenuItem[];
};

/** The panel of an object list: rows split by `line-soft` (spec §6.17). */
export function ObjectList({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <ul className="cb-object-list" aria-label={label}>
      {children}
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
  const variant = action?.primary ? "primary" : "default";
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
        {meta ? <span className="cb-object-meta">{meta}</span> : null}
      </span>
      {state ? (
        <span className="cb-object-state" data-tone={state.tone}>
          {state.label}
        </span>
      ) : null}
      {trailing ? <span className="cb-object-trailing">{trailing}</span> : null}
      {action ? (
        action.href !== undefined ? (
          <Link
            href={action.href}
            className={`cb-btn cb-btn-link cb-btn-link-${variant}`}
            data-density="dense"
          >
            <span className="cb-btn-body">{action.label}</span>
          </Link>
        ) : (
          <Button
            variant={variant}
            density="dense"
            {...(action.onSelect ? { onClick: action.onSelect } : {})}
          >
            {action.label}
          </Button>
        )
      ) : null}
      {menu && menu.length > 0 ? (
        <Menu
          items={menu}
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
