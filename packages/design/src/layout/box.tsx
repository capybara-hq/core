import { createContext, type ReactNode, useContext } from "react";

/**
 * The box a component is drawn in (spec §1 "One box is enough", §2.5): a Card, a form section's
 * card, a Dialog, Sheet or Popover, an inline card, a property section, the narrow properties
 * sheet, a Callout, a DangerZone or an ObjectList (every box `web-ui-box-in-box` treats as one).
 * `null` is the page ground, or a full-height pane (RightPanel), which holds content like a page.
 */
export type BoxKind =
  | "card"
  | "form-card"
  | "dialog"
  | "sheet"
  | "inline-card"
  | "property-section"
  | "properties-sheet"
  | "popover"
  | "callout"
  | "danger-zone"
  | "object-list";

const BoxContext = createContext<BoxKind | null>(null);

/**
 * Marks its children as drawn inside a box. Components that would draw a box of their own read it
 * ({@link useInBox}) and draw their unboxed form instead: a CodeBlock or EmbedFrame without its
 * line, a DataTable unframed, a Repeater's items as divided rows, a PropertySection as a heading
 * and hairline group. A full-height pane passes `kind={null}`: what it holds is on a page again.
 */
export function BoxScope({ kind, children }: { kind: BoxKind | null; children?: ReactNode }) {
  return <BoxContext.Provider value={kind}>{children}</BoxContext.Provider>;
}

/** The box this component is drawn in, or `null` on the page ground (or in a pane). */
export function useInBox(): BoxKind | null {
  return useContext(BoxContext);
}
