import { forwardRef, type JSX, type ReactNode, type TextareaHTMLAttributes } from "react";

// The composer frame (spec §6.16.2): the floating box that holds the attachment strip, the textarea
// and the control row. Task 18 of the B plan adds the control row (pickers, send / stop) on top of
// this frame; the frame and the textarea are what the attachment strip needs today.

/** The composer box: `raised`, 1px `line`, radius `md`, `shadow-float`; accent + halo on focus. */
export function ComposerFrame({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="cb-composer" data-part="composer">
      {children}
    </div>
  );
}

/** The composer textarea: no border or ground, `prose` 15 / 26, placeholder `faint`. */
export const ComposerInput = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function ComposerInput({ rows = 1, ...rest }, ref) {
  return (
    <textarea
      {...rest}
      ref={ref}
      rows={rows}
      className="cb-composer-input"
      data-part="composer-input"
    />
  );
});
