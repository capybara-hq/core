import type { JSX, ReactNode } from "react";

/**
 * The frame of a replaceable region (client extensions spec §6): while a plugin component that
 * may replace the built-in `children` is still loading (`pending`), the frame is `visibility:
 * hidden`, so the region keeps its size and nothing jumps when the winner (or the built-in) shows.
 * It adds no box of its own (`display: contents`).
 */
export function ReplaceableFrame({
  pending,
  children,
}: {
  pending: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="cb-replaceable"
      data-part="replaceable-frame"
      data-pending={pending ? "true" : undefined}
      aria-hidden={pending ? true : undefined}
      inert={pending ? true : undefined}
    >
      {children}
    </div>
  );
}
