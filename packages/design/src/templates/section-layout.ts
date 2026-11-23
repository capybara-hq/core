/**
 * Columns by count (spec §5.3): the two-column section layout (the title and description in a
 * 240 column beside the fields card) is for pages with more than two sections. With one or two
 * sections in a page, or in the tab's panel on show, every section is stacked: its head above its
 * card across the full width. The template decides, never the page: the stylesheet switches the
 * sections of a template to columns when it holds {@link SECTION_COLUMNS_MIN} or more sibling
 * `FormSection`s (`.cb-form-section ~ .cb-form-section ~ .cb-form-section` under `:has()`, so the
 * server render is right without JS), and a SettingsPage never does (its sub-nav is the title
 * column). This module is the same rule in script, for tests and the development guard.
 */
export const SECTION_COLUMNS_MIN = 3;

const SECTION = ".cb-form-section";

/** The template's sections grouped by their parent element, in document order. */
function sectionGroups(root: Element): Element[][] {
  const groups = new Map<Element, Element[]>();
  for (const s of root.querySelectorAll(SECTION)) {
    const parent = s.parentElement;
    if (parent === null) continue;
    const g = groups.get(parent);
    if (g) g.push(s);
    else groups.set(parent, [s]);
  }
  return [...groups.values()];
}

/**
 * How a template's sections stand (the stylesheet's rule, before the width rules): `columns` when
 * the template (`.cb-template`, or the element given) is not a SettingsPage and holds
 * {@link SECTION_COLUMNS_MIN} or more sibling sections, else `stacked`. A section passed
 * `layout="stacked"` is stacked either way; below the label column's room every section is.
 */
export function formSectionLayout(root: Element): "columns" | "stacked" {
  const template = root.closest(".cb-template") ?? root;
  if (template.getAttribute("data-template") === "SettingsPage") return "stacked";
  return sectionGroups(template).some((g) => g.length >= SECTION_COLUMNS_MIN)
    ? "columns"
    : "stacked";
}

/**
 * The count is only right when a page's sections are siblings (the stylesheet counts siblings):
 * three or more sections split across wrappers would read as fewer. Throws, naming the fix; the
 * template frame runs it after each render in development and tests, never in production.
 */
export function assertSectionGroups(root: Element): void {
  if (root.getAttribute("data-template") === "SettingsPage") return;
  const groups = sectionGroups(root);
  const total = groups.reduce((n, g) => n + g.length, 0);
  if (total < SECTION_COLUMNS_MIN || groups.some((g) => g.length >= SECTION_COLUMNS_MIN)) return;
  throw new Error(
    `FormSection: the page's ${total} sections stand in ${groups.length} wrappers; render them as siblings so the template counts them (spec §5.3 "Columns by count")`,
  );
}
