import type { JSX } from "react";
import { useNow } from "../clock";
import { Button } from "../controls/button";
import { Spinner } from "../conversation/prose";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useDesignLocale, useDesignT } from "../provider";
import { formatRelative } from "./date-time";

/**
 * A setup check's state as the page knows it. `ok` / `failing` / `unknown` are results (setup
 * guides v2 spec §10.1), `running` while one runs, `not_run` before the first run, `static` where
 * a check cannot run yet (no saved target: "checked after saving").
 */
export type CheckRowState = {
  status: "ok" | "failing" | "unknown" | "running" | "not_run" | "static";
  /** Why, in a sentence; plain text. */
  reason?: string;
  /** What to do; plain text, shown only when failing. */
  fix?: string;
  /** When the result was produced (ISO). */
  checkedAt?: string;
  /** Re-check is disabled until then (ISO): forced reruns are rate limited. */
  cooldownUntil?: string;
};

export type CheckRowProps = {
  label: string;
  state: CheckRowState;
  /** Shows 重新检查 / Re-check (not while running, not for a static row). */
  onRecheck?: () => void;
  /** The note of a static row; defaults to 保存后检查 / Checked after saving. */
  staticNote?: string;
};

const MARK: Record<Exclude<CheckRowState["status"], "running">, IconName> = {
  ok: "circle-check",
  failing: "circle-x",
  unknown: "circle-alert",
  not_run: "circle",
  static: "circle",
};

/**
 * One setup check as a status row (spec §6.9): the status icon, the label, the checked-at time and
 * the 重新检查 ghost button, then the reason and the fix as muted prose lines. It draws no box: it
 * sits in the page's section card (§1 "One box is enough").
 */
export function CheckRow({ label, state, onRecheck, staticNote }: CheckRowProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const now = useNow(1000);
  const { status } = state;
  const running = status === "running";
  const result = status === "ok" || status === "failing" || status === "unknown";
  const cooling = state.cooldownUntil !== undefined && Date.parse(state.cooldownUntil) > now;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is a form group; this is a status row
    <div
      className="cb-check-row"
      data-part="check-row"
      data-status={status}
      role="group"
      aria-label={label}
    >
      <span className="cb-check-row-mark" data-part="check-row-mark">
        {running ? (
          <Spinner size={16} label={t("checkRow.running")} />
        ) : (
          <Icon name={MARK[status]} />
        )}
      </span>
      <div className="cb-check-row-main">
        <div className="cb-check-row-head">
          <span className="cb-check-row-label" data-part="check-row-label">
            {label}
          </span>
          {running ? null : (
            <span className="cb-check-row-word" data-part="check-row-word">
              {t(`checkRow.status.${status}`)}
            </span>
          )}
          {result && state.checkedAt !== undefined ? (
            <time
              className="cb-check-row-time"
              data-part="check-row-time"
              dateTime={state.checkedAt}
            >
              {t("checkRow.checkedAt").replace(
                "{time}",
                formatRelative(state.checkedAt, locale, now),
              )}
            </time>
          ) : null}
          {onRecheck !== undefined && !running && status !== "static" ? (
            <Button
              variant="ghost"
              density="dense"
              part="check-row-recheck"
              className="cb-check-row-recheck"
              aria-label={t("checkRow.recheckOf").replace("{label}", label)}
              disabled={cooling}
              onClick={onRecheck}
            >
              <Icon name="refresh" size={14} />
              {t("checkRow.recheck")}
            </Button>
          ) : null}
        </div>
        {status === "static" ? (
          <p className="cb-check-row-line" data-part="check-row-note">
            {staticNote ?? t("checkRow.static")}
          </p>
        ) : null}
        {result && state.reason ? (
          <p className="cb-check-row-line" data-part="check-row-reason">
            {state.reason}
          </p>
        ) : null}
        {status === "failing" && state.fix ? (
          <p className="cb-check-row-line" data-part="check-row-fix">
            {state.fix}
          </p>
        ) : null}
      </div>
    </div>
  );
}
