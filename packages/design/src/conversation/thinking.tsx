import { type JSX, useId, useState } from "react";
import { Icon } from "../icons/icon";
import { useDesignLocale, useDesignT } from "../provider";
import { Cursor, Spinner } from "./prose";

export type ThinkingRowProps = {
  /** Thinking time in seconds (rounded for display); null when unknown. */
  seconds: number | null;
  text: string;
  /** The model is thinking now: spinner, elapsed seconds, the body streams and cannot collapse. */
  live?: boolean;
  /** Starts expanded (finished rows only). */
  defaultOpen?: boolean;
};

/** A thinking row (§6.16.5): a tool line "Thought for N seconds" that opens the thinking text. */
export function ThinkingRow({ seconds, text, live, defaultOpen }: ThinkingRowProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const [open, setOpen] = useState(defaultOpen === true);
  const id = useId();
  const n = seconds === null ? null : Math.max(0, Math.round(seconds));
  if (live) {
    return (
      <div className="cb-thinking-row">
        <div className="cb-tool-line" data-part="tool-line">
          <Spinner />
          <span className="cb-tool-label">
            {t("conv.thinking")}
            {n === null ? null : (
              <span className="cb-faint">{` · ${t("conv.seconds").replace("{n}", String(n))}`}</span>
            )}
          </span>
        </div>
        <div className="cb-thinking-body" data-part="thinking-body">
          {text}
          <Cursor />
        </div>
      </div>
    );
  }
  const title =
    n === null
      ? t("conv.thoughtUnknown")
      : n === 1 && locale === "en"
        ? t("conv.thoughtFor1")
        : t("conv.thoughtFor").replace("{n}", String(n));
  if (text === "") {
    return (
      <div className="cb-thinking-row">
        <div className="cb-tool-line" data-part="tool-line">
          <span className="cb-tool-label">{title}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="cb-thinking-row">
      <button
        type="button"
        className="cb-tool-line"
        data-part="tool-line"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cb-tool-label">{title}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open ? (
        <div id={id} className="cb-thinking-body" data-part="thinking-body">
          {text}
        </div>
      ) : null}
    </div>
  );
}
