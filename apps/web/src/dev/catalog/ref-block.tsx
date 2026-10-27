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
