import { type JSX, type ReactNode, useLayoutEffect, useRef, useSyncExternalStore } from "react";

/** The two forms a structure may take (responsive spec §5): the compact class, or medium and expanded. */
export type ClassForm = "compact" | "wide";

/**
 * The one query both forms derive from: wide when it matches, compact otherwise, so a fractional
 * width between 599 and 600 (browser zoom), which no size-class query matches, still picks one.
 * class-forms.css spells the same query and its complement.
 */
const WIDE_QUERY = "(min-width: 600px)";

function hasMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

function subscribe(notify: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const list = window.matchMedia(WIDE_QUERY);
  list.addEventListener("change", notify);
  return () => list.removeEventListener("change", notify);
}

function currentForm(): ClassForm | null {
  if (!hasMatchMedia()) return null;
  return window.matchMedia(WIDE_QUERY).matches ? "wide" : "compact";
}

/**
 * The form for the window's size class: `null` in a server render and during hydration (the server
 * does not know the width), `"compact"` or `"wide"` afterwards, live as the window changes.
 */
export function useClassForm(): ClassForm | null {
  return useSyncExternalStore(subscribe, currentForm, () => null);
}

export interface ClassFormsProps {
  /** Drawn on the compact class (below 600). */
  compact: ReactNode;
  /** Drawn on the medium and expanded classes (from 600). */
  wide: ReactNode;
}

/**
 * The one way to draw a structure that differs by size class (responsive spec §5.2 mechanism A,
 * §5.3). Use it only when semantics, interaction or placement differ; otherwise restyle one DOM.
 *
 * Before hydration both copies are drawn, each in a box-less `data-class-form` wrapper, and the
 * stylesheet shows one (wide from 600, compact otherwise); the hydration commit marks the copy CSS
 * hides `inert`. After hydration only the matching copy stays mounted. The copies keep stable
 * keys, so the shown one keeps its DOM and React state (and focus) through the prune.
 *
 * Both copies must take their state from props, never hold competing state of their own, and
 * take ids from `useId`.
 */
export function ClassForms({ compact, wide }: ClassFormsProps): JSX.Element {
  const form = useClassForm();
  const compactRef = useRef<HTMLDivElement>(null);
  const wideRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    // Only the pre-prune commit has both copies; the re-render that follows removes the hidden one.
    if (form !== null || !hasMatchMedia()) return;
    const hidden = window.matchMedia(WIDE_QUERY).matches ? compactRef : wideRef;
    hidden.current?.setAttribute("inert", "");
  }, [form]);

  return (
    <>
      {form !== "wide" && (
        <div key="compact" ref={compactRef} className="cb-class-form" data-class-form="compact">
          {compact}
        </div>
      )}
      {form !== "compact" && (
        <div key="wide" ref={wideRef} className="cb-class-form" data-class-form="wide">
          {wide}
        </div>
      )}
    </>
  );
}
