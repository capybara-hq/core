import { useId, useState } from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

export type ErrorDetailProps = {
  /** One sentence in the reader's language (never the raw English text). */
  summary: string;
  /** The system's raw text (a kernel message, a network error), kept behind the toggle. */
  detail?: string;
  /** The toggle's words; default the design i18n 「原始错误」 / "Raw error". */
  label?: string;
  /** Open on first render (default closed; the reference blocks draw the open state). */
  defaultOpen?: boolean;
};

/**
 * A failure read first as one sentence, the raw text one click away (spec §6.24): the sentence in
 * `fail` led by `circle-x`, then a small muted toggle (`aria-expanded`, a faint chevron after the
 * words) that shows the raw text in mono, line breaks kept, under a 1px guide. No `detail`, no
 * toggle.
 */
export function ErrorDetail({ summary, detail, label, defaultOpen = false }: ErrorDetailProps) {
  const t = useDesignT();
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const raw = detail !== undefined && detail !== "";
  return (
    <div className="cb-error-detail" data-part="error-detail">
      <span className="cb-error-detail-summary" data-part="error-detail-summary">
        <span className="cb-error-detail-icon" aria-hidden="true">
          <Icon name="circle-x" size={14} />
        </span>
        <span>{summary}</span>
      </span>
      {raw ? (
        <>
          <button
            type="button"
            className="cb-error-detail-toggle"
            data-part="error-detail-toggle"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            {label ?? t("errorDetail.raw")}
            <span className="cb-error-detail-caret" aria-hidden="true">
              <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
            </span>
          </button>
          {open ? (
            <pre id={id} className="cb-error-detail-raw" data-part="error-detail-raw">
              {detail}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
