/** A pending count on a navigation entry (the inbox): `more` marks a truncated count (`3+`). */
export interface NavBadge {
  count: number;
  more?: boolean;
}

/** The badge's text: nothing for 0, `99+` above 99, `n+` for a truncated count. */
export function badgeText(b: NavBadge | undefined): string | null {
  if (b === undefined || b.count <= 0) return null;
  if (b.count > 99) return "99+";
  return `${b.count}${b.more ? "+" : ""}`;
}
