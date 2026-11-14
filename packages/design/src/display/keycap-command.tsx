import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../controls/button";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

export type KeycapCommandProps = {
  /** The command line; its words become keycaps (`capybara-device mode auto|sandbox`). */
  command: string;
  /** A sentence above the line saying where to run it. */
  hint?: ReactNode;
  /** The copy button's accessible name; defaults to 复制 <command> / "Copy <command>". */
  copyLabel?: string;
};

/**
 * A CLI line drawn as keycaps and copyable (spec §6.42, auto mode design §4): each word of the
 * command in its own keycap, a copy button at the end that reads 已复制 for two seconds. It is the
 * only place the command appears on a page. Without a usable clipboard the keycaps are selected
 * for a manual copy and the button says so.
 */
export function KeycapCommand({ command, hint, copyLabel }: KeycapCommandProps) {
  const t = useDesignT();
  const fallback = useRef<HTMLSpanElement>(null);
  const [copied, setCopied] = useState<"no" | "yes" | "manual">("no");
  useEffect(() => {
    if (copied !== "yes") return;
    const timer = setTimeout(() => setCopied("no"), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
        throw new Error("no clipboard");
      }
      await navigator.clipboard.writeText(command);
      setCopied("yes");
    } catch {
      // The keycaps are separate inline boxes: selecting them would join the words without the
      // spaces. Select the whole command instead, so a manual copy is the command itself.
      const node = fallback.current;
      const selection = typeof window === "undefined" ? null : window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopied("manual");
    }
  };
  const words = command.trim().split(/\s+/);
  return (
    <div
      className="cb-keycap"
      data-part="keycap-command"
      data-state={copied === "yes" ? "copied" : undefined}
    >
      <span ref={fallback} className="cb-sr-only" aria-hidden="true">
        {command}
      </span>
      {hint ? (
        <p className="cb-keycap-hint" data-part="keycap-command-hint">
          {hint}
        </p>
      ) : null}
      <div className="cb-keycap-line">
        <span className="cb-keycap-caps" data-part="keycap-command-caps">
          {words.map((word, index) => (
            // Keycaps are positional, never reordered: the index is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: keycaps are positional
            <kbd key={index} className="cb-keycap-cap" data-part="keycap-command-cap">
              {word}
            </kbd>
          ))}
        </span>
        <Button
          variant="ghost"
          density="dense"
          part="keycap-command-copy"
          className="cb-keycap-copy"
          aria-label={copyLabel ?? t("keycap.copyOf").replace("{command}", command)}
          onClick={() => void copy()}
        >
          <Icon name={copied === "yes" ? "check" : "copy"} size={14} />
          {copied === "yes"
            ? t("keycap.copied")
            : copied === "manual"
              ? t("keycap.copyManual")
              : t("keycap.copy")}
        </Button>
      </div>
    </div>
  );
}
