import type { Page } from "@playwright/test";

/**
 * The mobile size measurements of the compact rule set (design spec §2.5 "Mobile sizes", mobile
 * layout spec §11.3; maintainer decision 2026-11-22). Under `MOBILE_SIZE_QUERY` (a compact window
 * whatever the pointer, or a touch device) every control the mobile sizes cover is a 44 x 44 tap
 * target (`touch.hit`), and a control with text pads wider than it is tall from its text.
 * `compact.interaction.spec.ts` runs them on every template page; `mobile-sizes.interaction.spec.ts`
 * proves them red on violating fixtures.
 */

/** Interactive elements a hit box applies to. */
export const INTERACTIVE =
  "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [role=radio]";

/**
 * Hit boxes the spec does not measure, each with its reason. A link inside running text is exempt
 * (its target is the text); a native control hidden under a larger styled label is measured
 * through its label instead.
 */
export const HIT_EXEMPT: { selector: string; why: string }[] = [
  { selector: "p a, li a, dd a, td a", why: "an inline link in running text" },
  { selector: ".cb-skip-link", why: "visually hidden until it has focus" },
  { selector: ".cb-visually-hidden, .cb-sr-only, [data-visually-hidden]", why: "not on screen" },
];

/**
 * The controls the mobile sizes cover: each has a 44 x 44 tap target. They fail when they do not
 * reach it; every other interactive element is only counted (the census). A text field is aimed
 * at through its bordered frame (`FIELD_FRAME`).
 */
export const GUARANTEED = [
  ".cb-float-btn",
  ".cb-btn",
  ".cb-chip",
  '[role="tab"]',
  ".cb-tab",
  ".cb-seg",
  ".cb-settings-nav-item",
  ".cb-select",
  ".cb-input input",
  ".cb-textarea textarea",
  ".cb-stepper input",
  '[data-part="title-bar-button"]',
];

/** The box a control is aimed at: a text field's bordered frame, else the element itself. */
export const FIELD_FRAME = ".cb-input, .cb-textarea, .cb-stepper";

/** The controls with text whose inline space must be greater than their block space. */
export const TEXT_CONTROLS = [
  ".cb-btn:not(.cb-icon-btn)",
  ".cb-chip",
  ".cb-tab",
  ".cb-seg",
  ".cb-settings-nav-item",
];

/** The tap target's side (`touch.hit`). */
export const HIT = 44;

/**
 * Finds the interactive elements without a 44 x 44 hit box. A control may reach it through an
 * invisible ring (getBoundingClientRect does not see one), so the box is probed: the edge midpoints
 * of the square around the element's center, and its corners pulled in to the inscribed circle (a
 * round control's corner is not a hit), must hit the element, something inside it, or the label of a
 * native control. `out` holds the guaranteed controls that fail, `census` the others.
 */
export async function findSmallTargets(page: Page): Promise<{ out: string[]; census: string[] }> {
  return page.evaluate(
    ({ interactive, exempt, guaranteed, frame, edge, corner }) => {
      const out: string[] = [];
      const census: string[] = [];
      const hits = (target: Element, el: Element, x: number, y: number) => {
        const at = document.elementFromPoint(x, y);
        if (!at) return false;
        if (target.contains(at)) return true;
        const label = at.closest("label");
        return (
          el instanceof HTMLInputElement &&
          !!el.labels &&
          Array.from(el.labels).includes(label as HTMLLabelElement)
        );
      };
      for (const el of Array.from(document.querySelectorAll(interactive))) {
        if (exempt.some((s) => el.matches(s))) continue;
        if (el.closest("[hidden], [aria-hidden='true'], [inert]")) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (el.getBoundingClientRect().width === 0) continue;
        const target = el.closest(frame) ?? el;
        target.scrollIntoView({ block: "center", inline: "center" });
        const r = target.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const points = [
          [cx - edge, cy],
          [cx + edge, cy],
          [cx, cy - edge],
          [cx, cy + edge],
          [cx - corner, cy - corner],
          [cx + corner, cy - corner],
          [cx - corner, cy + corner],
          [cx + corner, cy + corner],
        ] as const;
        if (!points.every(([x, y]) => hits(target, el, x, y))) {
          const text = (el.getAttribute("aria-label") ?? el.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 30);
          (el.matches(guaranteed) ? out : census).push(
            `<${el.tagName.toLowerCase()} ${el.getAttribute("data-part") ?? el.className}> ${text} ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
        }
      }
      window.scrollTo(0, 0);
      return { out, census };
    },
    {
      interactive: INTERACTIVE,
      exempt: HIT_EXEMPT.map((e) => e.selector),
      guaranteed: GUARANTEED.join(", "),
      frame: FIELD_FRAME,
      // half the square, less a pixel so a 44 box's own edge counts; the corners pulled in to the
      // circle of a round 44 control (14 * sqrt 2 < 22): a round control's corner is not a hit
      edge: HIT / 2 - 1,
      corner: HIT / 2 - 8,
    },
  );
}

/**
 * Finds the controls with text whose inline space is not greater than their block space: the
 * space between the border and the content (the text and its icons) at the sides against the
 * space above and below it. A control whose text is cut (an ellipsis) counts its inline padding.
 */
export async function findTallPadding(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (el.closest("[hidden], [aria-hidden='true'], [inert], .cb-sr-only")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if ((el.textContent ?? "").trim() === "") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // the content box: the text nodes' and the visible child elements' rects
      let left = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      const add = (b: DOMRect) => {
        if (b.width === 0 && b.height === 0) return;
        left = Math.min(left, b.left);
        right = Math.max(right, b.right);
        top = Math.min(top, b.top);
        bottom = Math.max(bottom, b.bottom);
      };
      const walk = (node: Node) => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            if ((child.textContent ?? "").trim() === "") continue;
            const range = document.createRange();
            range.selectNodeContents(child);
            for (const b of Array.from(range.getClientRects())) add(b);
          } else if (child instanceof HTMLElement || child instanceof SVGElement) {
            const ccs = getComputedStyle(child);
            if (ccs.display === "none" || ccs.visibility === "hidden") continue;
            if (child instanceof HTMLElement && ccs.position === "absolute") continue;
            // a child that clips (a label cut with an ellipsis) counts with its own box
            if (child instanceof HTMLElement && ccs.overflowX !== "visible") {
              add(child.getBoundingClientRect());
            } else if (ccs.display === "contents" || child instanceof HTMLElement) walk(child);
            else add(child.getBoundingClientRect());
          }
        }
      };
      walk(el);
      if (!Number.isFinite(left)) continue;
      const bl = Number.parseFloat(cs.borderLeftWidth);
      const br = Number.parseFloat(cs.borderRightWidth);
      const bt = Number.parseFloat(cs.borderTopWidth);
      const bb = Number.parseFloat(cs.borderBottomWidth);
      const cut = el.scrollWidth > el.clientWidth + 1;
      const inline = cut
        ? Math.min(Number.parseFloat(cs.paddingLeft), Number.parseFloat(cs.paddingRight))
        : Math.min(left - (r.left + bl), r.right - br - right);
      const block = Math.min(top - (r.top + bt), r.bottom - bb - bottom);
      if (inline <= block) {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
        out.push(
          `<${el.tagName.toLowerCase()} ${el.className}> ${text} inline ${inline.toFixed(1)} <= block ${block.toFixed(1)} (${Math.round(r.width)}x${Math.round(r.height)})`,
        );
      }
    }
    return out;
  }, TEXT_CONTROLS.join(", "));
}
