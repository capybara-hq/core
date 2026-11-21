import { useEffect, useRef, useState } from "react";
import { Button } from "../controls/button";
import { Icon } from "../icons/icon";
import { useInBox } from "../layout/box";
import { useDesignT } from "../provider";
import { useScrollbarRelayout } from "./scrollbar-relayout";

export type CopyCodeState = "idle" | "copied" | "manual";

export type CopyCodeProps = {
  /** The one line to copy: a command, an address, a one-time code. Empty disables the copy. */
  value: string;
  /** The block's accessible name (安装命令), when no visible label names it. */
  label?: string;
  /** The id of a visible label naming the block (CopyField passes its label's). */
  labelledBy?: string;
  /** The id of a line describing the block (CopyField passes its help's). */
  describedBy?: string;
  /** Pins a look (the reference blocks draw `copied` and `manual` without a click). */
  state?: CopyCodeState;
};

/**
 * One line people copy (spec §6.58): the value in the code font in a one-line block, a copy icon
 * button inside the block at its right. After copying the button shows a check and 已复制 for two
 * seconds. Without a usable clipboard (an insecure origin, a refused permission) the value is
 * selected and a muted line under the block says to copy it by hand. A long value scrolls
 * sideways inside the block, never past it. On the page ground it is framed (1px `line`, `panel`);
 * inside a box it draws its unframed form by itself (a `panel-2` tint, no line), as a CodeBlock.
 */
export function CopyCode({ value, label, labelledBy, describedBy, state: pinned }: CopyCodeProps) {
  const t = useDesignT();
  const inBox = useInBox() !== null;
  const pre = useRef<HTMLPreElement>(null);
  useScrollbarRelayout(pre);
  const [own, setOwn] = useState<CopyCodeState>("idle");
  const state = pinned ?? own;
  useEffect(() => {
    if (own !== "copied") return;
    const timer = setTimeout(() => setOwn("idle"), 2000);
    return () => clearTimeout(timer);
  }, [own]);
  const copy = async () => {
    try {
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
        throw new Error("no clipboard");
      }
      await navigator.clipboard.writeText(value);
      setOwn("copied");
    } catch {
      const node = pre.current;
      const selection = typeof window === "undefined" ? null : window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setOwn("manual");
    }
  };
  const copied = state === "copied";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is a form control group with its own legend layout
    <div
      className="cb-copy-code"
      data-part="copy-code"
      data-state={state === "idle" ? undefined : state}
      role="group"
      aria-label={labelledBy === undefined ? label : undefined}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      <div
        className="cb-copy-code-line"
        data-part="copy-code-line"
        data-framed={inBox ? "false" : "true"}
      >
        <pre className="cb-copy-code-value" data-part="copy-code-value" ref={pre}>
          <code>{value}</code>
        </pre>
        <Button
          variant="ghost"
          density="dense"
          part="copy-code-button"
          className="cb-copy-code-copy"
          disabled={value === ""}
          // the icon alone names nothing: the label carries the name until the text shows
          aria-label={copied ? undefined : t("copy.copy")}
          title={copied ? undefined : t("copy.copy")}
          onClick={() => void copy()}
        >
          <Icon name={copied ? "check" : "copy"} size={14} />
          {copied ? <span>{t("copy.copied")}</span> : null}
        </Button>
      </div>
      {state === "manual" ? (
        <span className="cb-copy-code-manual" data-part="copy-code-manual" role="status">
          <Icon name="circle-alert" size={14} />
          {t("copy.manual")}
        </span>
      ) : null}
    </div>
  );
}
