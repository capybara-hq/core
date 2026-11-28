/**
 * The head tabs of the sidebar's Skills · Connectors entry (maintainer decision 2026-11-29, option
 * B): the two routes are one place, so each page's head links both and neither draws a path row.
 * Guests do not browse skills: they see the connectors page alone, without a tab row.
 */
export function skillsConnectorsTabs(
  t: (key: "nav.skills" | "nav.connectors") => string,
  guest = false,
): { id: "skills" | "connectors"; label: string; href: string }[] {
  if (guest) return [];
  return [
    { id: "skills", label: t("nav.skills"), href: "/skills" },
    { id: "connectors", label: t("nav.connectors"), href: "/connectors" },
  ];
}
