import type { CSSProperties, ReactNode } from "react";

/** Pseudo-classes the fidelity and compare specs force with the DevTools protocol (spec §9.2). */
export type ForcedPseudo = "hover" | "focus" | "focus-visible" | "focus-within" | "active";

/**
 * One block of the reference set in `/dev/ui` (spec §9.2): `data-ref-block="<component>-<state>"`
 * with the same id and box as the reference page's block. `force` names the elements (a CSS
 * selector inside the block) whose pseudo-state the Playwright specs force, since a real hover
 * or focus can't be rendered statically. Development catalog only.
 */
export function ReferenceBlock({
  id,
  width,
  height,
  pad,
  force,
  itemWidth,
  offsetTop,
  children,
}: {
  id: string;
  width?: number;
  height?: number;
  /** Inner padding `space.4`, as the reference page's `data-pad` blocks. */
  pad?: boolean;
  force?: { pseudo: ForcedPseudo[]; selector: string };
  /** Each direct child of the content gets this width (the reference's fixed-width fields). */
  itemWidth?: number;
  /** Empty space above the content (room for a menu that opens upward, as the reference stages it). */
  offsetTop?: number;
  children?: ReactNode;
}) {
  return (
    <section
      className="cb-ref-block"
      data-ref-block={id}
      data-pad={pad ? "true" : undefined}
      data-ref-force={force ? force.pseudo.join(" ") : undefined}
      data-ref-force-selector={force?.selector}
      style={{ width, height }}
    >
      {offsetTop ? <div aria-hidden="true" style={{ height: offsetTop }} /> : null}
      {itemWidth === undefined ? (
        children
      ) : (
        <div
          className="cb-ref-block-items"
          style={{ "--cb-ref-item": `${itemWidth}px` } as CSSProperties}
        >
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * A compact screen in a reference block (the reference set's `r-screen`): `top` (the top bar),
 * the body filling the rest, then `bottom` (the bottom navigation or a sticky row), so a block
 * shows a component in the frame the shell would give it at a phone's width in any window. It
 * stands in for the shell: a ListDetail inside draws no back bar of its own (the top bar has it).
 */
export function ReferenceScreen({
  top,
  bottom,
  pad,
  children,
}: {
  top?: ReactNode;
  bottom?: ReactNode;
  /** The body padded `space.4` at the top and the sides (a page body such as the MePanel). */
  pad?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="cb-ref-screen" data-part="screen">
      {top}
      <div className="cb-ref-screen-body" data-pad={pad ? "true" : undefined}>
        {children}
      </div>
      {bottom}
    </div>
  );
}
