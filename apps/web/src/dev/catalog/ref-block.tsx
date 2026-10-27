import { type ForcedPseudo, ReferenceBlock } from "@capybara-hq/design";
import type { ReactNode } from "react";

/**
 * A reference-set block in `/dev/ui/reference/<component>`: `id` is `<component>-<state>`, the
 * same id (and box) as the block in docs/design/reference/src. Pseudo-states (`*-hover`,
 * `*-focus`) name the elements to force with `force`.
 */
export function RefBlock(props: {
  id: string;
  width?: number;
  height?: number;
  pad?: boolean;
  force?: { pseudo: ForcedPseudo[]; selector: string };
  itemWidth?: number;
  offsetTop?: number;
  children?: ReactNode;
}) {
  return <ReferenceBlock {...props} />;
}

/**
 * Marks content a block draws later (an image made on a canvas, handed out as a `blob:` URL):
 * the reference specs wait until no marker is left before they force states, measure or take
 * screenshots, so a slow machine never finds the block empty.
 */
export function RefPending() {
  return <span data-ref-pending="true" hidden />;
}
