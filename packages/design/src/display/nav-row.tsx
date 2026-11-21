import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { LinkPendingMark, useDesignLink } from "../provider";
import { badgeText, type NavBadge } from "./nav-badge";

export type NavRowProps = {
  icon?: IconName;
  label: string;
  /** Draws a link; without it the row is a button that calls `onSelect`. */
  href?: string;
  onSelect?: () => void;
  badge?: NavBadge;
  /** The row of the page the person is on (the `selected` ground, `aria-current`). */
  current?: boolean;
  /** A chevron after the label: the row opens a deeper level instead of going somewhere. */
  trailing?: "chevron";
  /**
   * The row keeps the page (it opens a native sheet, say): a pick that pops the overlays' history
   * entries as a close does (`data-drawer-pick="stay"`). Every other button row may navigate in the
   * same tick, so the overlays leave their entries rather than race it with a back.
   */
  stay?: boolean;
  "data-nav-section"?: string;
};

/**
 * A large navigation row (design spec §6.52): an icon, the label and an optional count, 52 high on
 * touch. A drawer's entries; a row that opens a deeper level (`trailing="chevron"`, no `href`)
 * does not close the drawer, any other row does (the drawer reads `data-drawer-pick`).
 */
export function NavRow({
  icon,
  label,
  href,
  onSelect,
  badge,
  current,
  trailing,
  stay,
  "data-nav-section": section,
}: NavRowProps) {
  const Link = useDesignLink();
  const text = badgeText(badge);
  const body = (
    <>
      {icon ? <Icon name={icon} size={16} /> : null}
      <span className="cb-navrow-label">{label}</span>
      {text === null ? null : (
        <span className="cb-navrow-badge" data-part="navrow-badge">
          {text}
        </span>
      )}
      {trailing === "chevron" ? <Icon name="chevron-right" size={16} /> : null}
    </>
  );
  const common = {
    className: "cb-navrow",
    "data-part": "nav-row",
    "data-current": current ? "true" : undefined,
    "aria-current": current ? ("page" as const) : undefined,
    "data-nav-section": section,
  };
  if (href !== undefined) {
    return (
      <Link href={href} {...common} data-drawer-pick="true">
        {body}
        <LinkPendingMark />
      </Link>
    );
  }
  return (
    <button
      type="button"
      {...common}
      onClick={onSelect}
      {...(trailing === "chevron" ? {} : { "data-drawer-pick": stay ? "stay" : "true" })}
    >
      {body}
    </button>
  );
}
