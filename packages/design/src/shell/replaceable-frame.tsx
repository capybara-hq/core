import type { JSX, ReactNode, Ref } from "react";

/**
 * The frame of a replaceable region (client extensions spec §6): while a plugin component that
 * may replace the built-in `children` is still loading (`pending`), the frame is `visibility:
 * hidden`, so the region keeps its size and nothing jumps when the winner (or the built-in) shows.
 * CSS alone reveals it after 1 500 ms (`CLIENT_LIMITS.pendingMs`), so a pending frame the server
 * drew never stays hidden, with or without scripts. Hidden content is out of the focus order and
 * the accessibility tree by `visibility` itself (no `inert` / `aria-hidden`, which would outlast the
 * CSS reveal). It adds no box of its own (`display: contents`).
 */
export function ReplaceableFrame({
  pending,
  ref,
  children,
}: {
  pending: boolean;
  /** The frame element: the host watches what renders inside it (the composer check). */
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      ref={ref}
      className="cb-replaceable"
      data-part="replaceable-frame"
      data-pending={pending ? "true" : undefined}
    >
      {children}
    </div>
  );
}
