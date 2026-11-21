import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { LinkPendingMark, useDesignLink } from "../provider";

export type ListFabProps = {
  /** The action's label: the button's accessible name and tooltip (the button draws no text). */
  label: string;
  /** The icon (default `plus`). */
  icon?: IconName;
  href?: string;
  onSelect?(): void;
};

/**
 * The list page's floating action button (responsive system spec §2.5, plan T0.12; the minimal
 * form this line needs): the ListPage's primary at the bottom end of a compact window, a
 * `touch.prominent` square with radius `md` on the `accent` ground, `space.4` from the end edge and
 * above `--cb-inset-bottom`. It is drawn in every render and shown only below 600 by CSS, where
 * the head's primary is hidden (one primary per screen), so the first paint needs no script.
 */
export function ListFab({ label, icon = "plus", href, onSelect }: ListFabProps) {
  const Link = useDesignLink();
  const inner = <Icon name={icon} size={16} />;
  if (href !== undefined) {
    return (
      <Link
        href={href}
        className="cb-list-fab"
        data-part="list-fab"
        aria-label={label}
        title={label}
      >
        {inner}
        <LinkPendingMark />
      </Link>
    );
  }
  return (
    <button
      type="button"
      className="cb-list-fab"
      data-part="list-fab"
      aria-label={label}
      title={label}
      onClick={onSelect}
    >
      {inner}
    </button>
  );
}
