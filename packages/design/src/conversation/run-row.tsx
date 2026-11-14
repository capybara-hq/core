import { type JSX, type ReactNode, useId, useState } from "react";
import { Button, LinkButton } from "../controls/button";
import { ErrorDetail } from "../display/error-detail";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useDesignT } from "../provider";

export type RunRowStatus = "ok" | "failed" | "stopped";

export type RunRowProps = {
  status: RunRowStatus;
  /** The words before the parts; default "运行" / "Run" (a compact run names itself). */
  label?: string;
  /** What follows the label: the model, the duration, the tokens (unknown ones left out). */
  parts: string[];
  /** The status words after the mark; default 完成 / 失败 / 已停止 by status. */
  statusText?: string;
  /** Open at first; default open for a failed run only. */
  defaultOpen?: boolean;
  /** The failure: one sentence in the reader's language and the raw text (spec §6.24). */
  error?: { summary: string; detail?: string };
  /** Plain mono lines of the detail (the token split, the start time). */
  facts?: string[];
  /** Retry (a dense default button); absent, no button. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Links drawn as dense buttons (the trajectory, the fix entry). */
  links?: { label: string; href: string }[];
};

const MARK: Record<RunRowStatus, IconName> = { ok: "check", failed: "circle-x", stopped: "ban" };

/**
 * A run row (spec §6.16.23): the quiet mono line that closes a run, "运行 · <model> · <duration> ·
 * <tokens>" and its status mark, a disclosure whose detail holds the failure, facts and actions.
 */
export function RunRow({
  status,
  label,
  parts,
  statusText,
  defaultOpen,
  error,
  facts,
  onRetry,
  retryLabel,
  links,
}: RunRowProps): JSX.Element {
  const t = useDesignT();
  const [open, setOpen] = useState(defaultOpen ?? status === "failed");
  const id = useId();
  const hasActions = onRetry !== undefined || (links !== undefined && links.length > 0);
  const hasDetail = error !== undefined || (facts !== undefined && facts.length > 0) || hasActions;
  const line: ReactNode = (
    <>
      <span className="cb-tool-label">{[label ?? t("run.label"), ...parts].join(" · ")}</span>
      <span className="cb-run-status" data-part="run-status" data-status={status}>
        <span className="cb-run-mark" data-part="run-mark" aria-hidden="true">
          <Icon name={MARK[status]} size={12} />
        </span>
        {statusText ?? t(`run.${status}`)}
      </span>
      {hasDetail ? <Icon name={open ? "chevron-down" : "chevron-right"} size={12} /> : null}
    </>
  );
  return (
    <div className="cb-run-row" data-status={status}>
      {hasDetail ? (
        <button
          type="button"
          className="cb-tool-line"
          data-part="run-row"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          {line}
        </button>
      ) : (
        <div className="cb-tool-line" data-part="run-row">
          {line}
        </div>
      )}
      {open && hasDetail ? (
        <section
          id={id}
          className="cb-run-detail"
          data-part="run-detail"
          aria-label={t("run.details")}
        >
          {error !== undefined ? (
            <ErrorDetail
              summary={error.summary}
              {...(error.detail !== undefined ? { detail: error.detail } : {})}
            />
          ) : null}
          {facts?.map((f) => (
            <div key={f} className="cb-run-fact">
              {f}
            </div>
          ))}
          {hasActions ? (
            <div className="cb-run-actions">
              {onRetry !== undefined ? (
                <Button density="dense" onClick={onRetry}>
                  {retryLabel ?? t("conv.retry")}
                </Button>
              ) : null}
              {links?.map((l) => (
                <LinkButton key={l.href} href={l.href} density="dense">
                  {l.label}
                </LinkButton>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
