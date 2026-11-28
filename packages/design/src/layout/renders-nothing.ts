import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Whether `el` holds no rendered node besides `skip`: no element and no text other than
 * whitespace. A component that returns `null` (or only `null`s, `false`, empty fragments) leaves
 * its container this way; any element it draws, even an empty one, counts as content.
 */
export function rendersNothing(el: Element, skip?: (node: Element) => boolean): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 1 && !skip?.(node as Element)) return false;
    if (node.nodeType === 3 && (node.textContent ?? "").trim() !== "") return false;
  }
  return true;
}

/**
 * Watches whether the element in `ref` renders nothing (see {@link rendersNothing}) while
 * `enabled`. The first answer comes from a layout effect, so a frame that holds nothing is hidden
 * before the first paint; later changes come from a mutation observer and are flushed at once (in
 * the observer's microtask, before the browser paints), so neither an empty frame nor late
 * content flickers. `false` while disabled and on the server.
 */
export function useRendersNothing(
  ref: RefObject<Element | null>,
  enabled: boolean,
  skip?: (node: Element) => boolean,
): boolean {
  const [empty, setEmpty] = useState(false);
  const skipRef = useRef(skip);
  skipRef.current = skip;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || el === null) return;
    let last = rendersNothing(el, skipRef.current);
    setEmpty(last);
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      const next = rendersNothing(el, skipRef.current);
      if (next === last) return;
      last = next;
      flushSync(() => setEmpty(next));
    });
    // subtree: a text node's own change is a characterData record on that node
    observer.observe(el, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [ref, enabled]);
  return enabled && empty;
}
