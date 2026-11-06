import type { ReactNode } from "react";
import { Button } from "../controls/index";
import { Icon } from "../icons/icon";
import { BoxScope, useInBox } from "../layout/box";
import { useDesignLink } from "../provider";

export type CalloutProps = {
  /**
   * `warn` / `fail`: something needs action (a `status`). `info`: a quiet standing fact about the
   * page (a `note`, `panel` ground, `muted` text), usually without an action.
   */
  tone: "info" | "warn" | "fail";
  children?: ReactNode;
  /** The one button that resolves it. */
  action?: { label: string; href?: string; onSelect?(): void };
};

/**
 * What needs action, above the list's tabs: a tinted bar, icon, sentence and one button; or, with
 * `tone="info"`, a quiet note under the page head (spec §6.19). Inside a box (a card, a form card,
 * a Dialog or Sheet, §1 "One box is enough") it draws its unboxed form by itself: no tint and no
 * padding, the line in its tone with its icon (`warn` / `fail`; `info` muted), the action at the
 * right, as a CodeBlock drops its line there.
 */
export function Callout({ tone, children, action }: CalloutProps) {
  const Link = useDesignLink();
  const inBox = useInBox() !== null;
  return (
    <section
      className="cb-callout"
      data-part="callout"
      role={tone === "info" ? "note" : "status"}
      data-tone={tone}
      data-framed={inBox ? "false" : undefined}
    >
      <Icon name="circle-alert" size={inBox ? 12 : 16} />
      <span className="cb-callout-text" data-part="callout-text">
        {/* Only the tinted bar is a box; the line form leaves its children in the outer box */}
        {inBox ? children : <BoxScope kind="callout">{children}</BoxScope>}
      </span>
      {action ? (
        action.href !== undefined ? (
          <Link
            href={action.href}
            className="cb-btn cb-btn-link cb-btn-link-default"
            data-density="dense"
          >
            <span className="cb-btn-body">{action.label}</span>
          </Link>
        ) : (
          <Button
            variant="default"
            density="dense"
            {...(action.onSelect ? { onClick: action.onSelect } : {})}
          >
            {action.label}
          </Button>
        )
      ) : null}
    </section>
  );
}
