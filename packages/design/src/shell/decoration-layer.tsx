import type { JSX, ReactNode } from "react";

/**
 * The decoration layer (client extensions spec §7.4): a full-viewport layer above every other
 * layer (`z.decoration`) that holds plugin decoration. It is `aria-hidden`, lets every pointer
 * event through and is not a box; an element marked `data-cap-interactive` takes events again
 * (a "skip" button of a boot animation). It must not hold content a person needs.
 */
export function DecorationLayer({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="cb-decoration" data-part="decoration-layer" aria-hidden="true">
      {children}
    </div>
  );
}
