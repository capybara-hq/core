import { type ForcedPseudo, ReferenceBlock } from "@capybara-hq/design";
import { type ReactNode, useSyncExternalStore } from "react";

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

const noSubscribe = () => () => {};

/**
 * A `RefPending` marker until the page has hydrated. Before hydration the app shell draws both
 * sidebar panels and the drawer bar and lets CSS pick one (`data-responsive`); a busy runner can
 * still be hydrating at `networkidle`, and a spec measuring then counted the sidebar twice.
 */
export function RefHydrating() {
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  return hydrated ? null : <RefPending />;
}
