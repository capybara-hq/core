import type { JSX, ReactNode } from "react";
import { useDesignT } from "../provider";

export type DividerKind = "stopped" | "failed" | "compacted" | "fallback" | "hook-denied";

export type RunDividerProps = {
  kind: DividerKind;
  /** The divider's sentence (the caller fills names, times and reasons). */
  text: string;
  /**
   * The link button after the text: Retry for `failed`, the summary toggle for `compacted`
   * (`expanded` sets aria-expanded and the default label). The label defaults by kind.
   */
  action?: { label?: string; onClick(): void; expanded?: boolean };
  /** The compacted summary, shown below the divider while it is given. */
  children?: ReactNode;
};

const FAIL: ReadonlySet<DividerKind> = new Set(["failed", "hook-denied"]);

/** A run divider (§6.16.7): a centered `small` line between two rules, `role="status"`. */
export function RunDivider({ kind, text, action, children }: RunDividerProps): JSX.Element {
  const t = useDesignT();
  const fail = FAIL.has(kind);
  const label =
    action?.label ??
    (kind === "compacted"
      ? t(action?.expanded ? "conv.hideSummary" : "conv.viewSummary")
      : t("conv.retry"));
  return (
    <div className="cb-run-divider-wrap">
      <div
        className="cb-run-divider"
        data-part="run-divider"
        data-kind={kind}
        data-tone={fail ? "fail" : undefined}
        role="status"
      >
        <span className="cb-divider-rule" data-part="divider-rule" />
        <span className="cb-run-divider-text">
          {text}
          {action ? (
            <>
              {" ·"}
              <button
                type="button"
                className="cb-link-btn"
                data-tone={fail ? "fail" : undefined}
                aria-expanded={action.expanded}
                onClick={action.onClick}
              >
                {label}
              </button>
            </>
          ) : null}
        </span>
        <span className="cb-divider-rule" data-part="divider-rule" />
      </div>
      {children !== undefined && children !== null ? (
        <div className="cb-divider-summary" data-part="divider-summary">
          {children}
        </div>
      ) : null}
    </div>
  );
}
