/**
 * The structural half of the compact rule set (mobile layout spec §11.3), next to
 * `findNestedBoxes`: rules on the rendered DOM that need no layout engine. The geometric half
 * (hit boxes, horizontal scroll, the bottom navigation covering the last item, 16 px fields) lives
 * in `apps/web/visual/compact.interaction.spec.ts`.
 */
export type CompactRule = "hover-only" | "unnamed-control" | "list-detail-back";

export type CompactViolation = {
  rule: CompactRule;
  /** The offending element, for a test's message. */
  element: Element;
};

/**
 * Marks an action that only a pointer hover reveals (or only a context menu reaches): a compact
 * window has neither. A component that needs such a control must also offer it another way and
 * must not carry the marker. Detection here is marker-based (jsdom has no cascade); a control shown
 * only by a `:hover` rule is found by the static stylesheet pass instead (`findHoverOnlyRules` in
 * the design package's test/css-rules.ts, run over every design stylesheet).
 */
const HOVER_ONLY = "[data-hover-only], [data-context-menu-only]";

const CONTROLS = "button, a[href], [role='button'], [role='link'], [role='menuitem'], summary";

function hidden(el: Element): boolean {
  return el.closest("[hidden], [aria-hidden='true'], [inert]") !== null;
}

/** The text an assistive technology would read for `el` (`title` alone is not a name). */
function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  const own = Array.from(el.querySelectorAll("*:not([aria-hidden='true'])"))
    .filter((c) => c.tagName === "IMG")
    .map((c) => c.getAttribute("alt")?.trim() ?? "")
    .join("");
  const text = Array.from(el.childNodes)
    .map((n) => (n.nodeType === 3 ? (n.textContent ?? "") : visibleText(n)))
    .join("")
    .trim();
  return text || own;
}

function visibleText(node: Node): string {
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return "";
  return Array.from(el.childNodes)
    .map((n) => (n.nodeType === 3 ? (n.textContent ?? "") : visibleText(n)))
    .join("");
}

/** A list-detail region has a back control: its own back bar's, or the shell's top bar's. */
function hasBack(region: Element): boolean {
  const own = region.querySelector("[data-part='back-bar'] :is(button, a[href], [role='button'])");
  if (own !== null && accessibleName(own) !== "") return true;
  // Inside an AppShell the top bar owns back on compact (the region's own bar is hidden there),
  // but only while the open item is a pushed page: the shell's bar must be marked pushed and
  // carry a named back. A region outside any shell has no such bar to lean on.
  const shell = region.closest(".cb-shell");
  const bar = shell?.querySelector("[data-part='top-bar'][data-pushed='true'] [data-part='back']");
  return bar != null && accessibleName(bar) !== "";
}

/**
 * Every compact violation under `root`: an action reachable only by hover or a context menu, an
 * interactive control without an accessible name (an icon-only button), and a list-detail region
 * with no back control for its stacked form.
 */
export function findCompactViolations(root: Element): CompactViolation[] {
  const out: CompactViolation[] = [];
  for (const el of Array.from(root.querySelectorAll(HOVER_ONLY))) {
    if (!hidden(el)) out.push({ rule: "hover-only", element: el });
  }
  for (const el of Array.from(root.querySelectorAll(CONTROLS))) {
    if (hidden(el) || el.matches("a:not([href])")) continue;
    if (accessibleName(el) === "") out.push({ rule: "unnamed-control", element: el });
  }
  for (const el of Array.from(root.querySelectorAll("[data-part='list-detail']"))) {
    if (!hasBack(el)) out.push({ rule: "list-detail-back", element: el });
  }
  return out;
}

/** A finding as one line: `<rule>: <tag and part of the element>`. */
export function describeCompactViolation(v: CompactViolation): string {
  const part = v.element.getAttribute("data-part");
  const text = (v.element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return `${v.rule}: <${v.element.tagName.toLowerCase()}${part ? ` data-part="${part}"` : ""}>${text ? ` ${text}` : ""}`;
}
