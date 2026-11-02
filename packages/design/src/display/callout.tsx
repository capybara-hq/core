import type { ReactNode } from "react";
import { Button } from "../controls/index";
import { Icon } from "../icons/icon";
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
 * `tone="info"`, a quiet note under the page head (spec §6.19).
 */
export function Callout({ tone, children, action }: CalloutProps) {
  const Link = useDesignLink();
  return (
    <section className="cb-callout" role={tone === "info" ? "note" : "status"} data-tone={tone}>
      <Icon name="circle-alert" size={16} />
      <span className="cb-callout-text">{children}</span>
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
