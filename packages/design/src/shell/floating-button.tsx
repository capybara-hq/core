import { badgeText, type NavBadge } from "../display/nav-badge";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { LinkPendingMark, useDesignLink } from "../provider";

export type FloatingIconButtonProps = {
  icon: IconName;
  /** The accessible name (the button draws no text); a pending count belongs in it. */
  label: string;
  /** A count drawn on the button's top-right corner while above 0. */
  badge?: NavBadge;
  onClick?: () => void;
  /** Draws a link instead of a button (a floating back button of a pushed page). */
  href?: string;
};

/**
 * A round floating icon button over the page (design spec §6.51): the chat-first shell's menu
 * button, the back button of a pushed page. A translucent ground with a hairline and a soft shadow.
 */
export function FloatingIconButton({ icon, label, badge, onClick, href }: FloatingIconButtonProps) {
  const Link = useDesignLink();
  const text = badgeText(badge);
  const inner = (
    <>
      <Icon name={icon} size={16} />
      {text === null ? null : (
        <span className="cb-float-badge" data-part="float-badge" aria-hidden="true">
          {text}
        </span>
      )}
    </>
  );
  if (href !== undefined) {
    return (
      <Link href={href} className="cb-float-btn" data-part="float-btn" aria-label={label}>
        {inner}
        <LinkPendingMark />
      </Link>
    );
  }
  return (
    <button
      type="button"
      className="cb-float-btn"
      data-part="float-btn"
      aria-label={label}
      onClick={onClick}
    >
      {inner}
    </button>
  );
}
