import { type JSX, type ReactNode, useLayoutEffect, useRef } from "react";

/** What may take focus or input: never hidden from assistive tech. */
const INTERACTIVE =
  '[data-cap-interactive], a[href], button, input, select, textarea, [tabindex], [contenteditable=""], [contenteditable="true"]';

/** Marks the `aria-hidden` the layer set itself (a plugin's own is left alone). */
const HIDDEN_MARK = "data-cap-decoration-hidden";

/** Marks a span the layer added to carry a text node's text out of reach of assistive tech. */
const TEXT_MARK = "data-cap-decoration-text";

/** Each carrier span's text node (the node React owns and updates). */
const carriers = new WeakMap<Element, Text>();

/**
 * The text nodes directly under an exposed container (the root, or an element that holds an
 * interactive one) cannot take `aria-hidden`, and moving a node React owns would break React's
 * later updates. So the text node stays where it is, emptied, and an `aria-hidden` span right after
 * it shows its text; React's updates land in the text node and are carried over again. A carrier
 * whose text node is gone (or moved) is removed.
 */
function carryText(container: Element): void {
  for (const span of [...container.children]) {
    if (!span.hasAttribute(TEXT_MARK)) continue;
    const text = carriers.get(span);
    if (text === undefined || text.parentNode !== container || text.nextSibling !== span)
      span.remove();
  }
  for (const node of [...container.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    if ((text.nodeValue ?? "").trim() === "") continue;
    let span = text.nextSibling instanceof Element ? text.nextSibling : null;
    if (span === null || carriers.get(span) !== text) {
      span = document.createElement("span");
      span.setAttribute(TEXT_MARK, "");
      span.setAttribute("aria-hidden", "true");
      carriers.set(span, text);
      container.insertBefore(span, text.nextSibling);
    }
    span.textContent = text.nodeValue;
    text.nodeValue = "";
  }
}

/**
 * Hides the decoration under `root` from assistive tech without hiding anything interactive: each
 * element that neither is nor holds an interactive element gets `aria-hidden`; one that holds one
 * stays exposed, its own text is carried into hidden spans ({@link carryText}) and its children
 * are looked at in turn. An interactive element's own text (its label) stays. What the layer hid
 * before and is now interactive (or holds something that is) is exposed again.
 */
function hideDecoration(root: HTMLElement): void {
  const visit = (el: Element) => {
    if (el.hasAttribute(TEXT_MARK)) return;
    const interactive = el.matches(INTERACTIVE) || el.querySelector(INTERACTIVE) !== null;
    if (!interactive) {
      if (!el.hasAttribute("aria-hidden")) {
        el.setAttribute("aria-hidden", "true");
        el.setAttribute(HIDDEN_MARK, "");
      }
      return;
    }
    if (el.hasAttribute(HIDDEN_MARK)) {
      el.removeAttribute("aria-hidden");
      el.removeAttribute(HIDDEN_MARK);
    }
    if (el.matches(INTERACTIVE)) return;
    carryText(el);
    for (const child of el.children) visit(child);
  };
  carryText(root);
  for (const child of root.children) visit(child);
}

/**
 * The decoration layer (client extensions spec §7.4): a full-viewport layer above every other
 * layer (`z.decoration`) that holds plugin decoration. It lets every pointer event through and is
 * not a box; an element marked `data-cap-interactive` takes events again (a "skip" button of a boot
 * animation). The decoration is hidden from assistive tech, element by element, while anything
 * interactive (marked, or focusable) stays exposed: an interactive element never sits under
 * `aria-hidden`. It must not hold content a person needs.
 */
export function DecorationLayer({ children }: { children?: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // the plugins' DOM changes on its own (animations, a skip button that appears): kept up with
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    hideDecoration(root);
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => hideDecoration(root));
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-cap-interactive", "href", "tabindex", "contenteditable"],
    });
    return () => observer.disconnect();
  });
  return (
    <div ref={ref} className="cb-decoration" data-part="decoration-layer">
      {children}
    </div>
  );
}
