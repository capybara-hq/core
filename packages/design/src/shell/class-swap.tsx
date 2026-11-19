import type { ReactNode } from "react";

/**
 * A region that differs by size class: `compact` is drawn on the compact class, `children` on the
 * others. Both are in every render and CSS shows one (design spec §4: where a tree differs by
 * class the server renders every variant), so a page never branches on the width. The wrappers
 * take no box of their own (`display: contents`). The hidden variant is still mounted: its
 * components run their effects and queries, and duplicate ids or landmarks stay in the DOM, so keep
 * its use rare and its variants light.
 */
export function ClassSwap({ compact, children }: { compact: ReactNode; children?: ReactNode }) {
  return (
    <>
      <div className="cb-class-swap" data-part="class-swap-compact" data-for="compact">
        {compact}
      </div>
      <div className="cb-class-swap" data-part="class-swap-regular" data-for="regular">
        {children}
      </div>
    </>
  );
}
