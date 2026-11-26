/**
 * A window drag region of the desktop's top row (desktop client spec §7.3 "The top row"): an empty
 * flex spacer a template draws between the controls of a top row. Only these and the shell's
 * controls area drag the window: a drag region swallows every mouse event over it, whatever is
 * stacked above, so it never holds or lies under a control. Outside a desktop shell it is a plain
 * spacer. Design CSS turns dragging off while an overlay is open.
 */
export function DragFill({ className }: { className?: string } = {}) {
  return (
    <span className={className ? `cb-drag-fill ${className}` : "cb-drag-fill"} aria-hidden="true" />
  );
}
