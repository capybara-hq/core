import type { ReactNode } from "react";

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
  children,
}: {
  id: string;
  width?: number;
  height?: number;
  /** Inner padding `space.4`, as the reference page's `data-pad` blocks. */
  pad?: boolean;
  force?: { pseudo: ForcedPseudo[]; selector: string };
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
      {children}
    </section>
  );
}
