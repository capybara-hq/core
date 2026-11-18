import { useEffect, useId, useState } from "react";
import { Button } from "../controls/index";
import { Input } from "../controls/inputs";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

export type CopyFieldProps = {
  /** The field's label ("链接"). */
  label: string;
  /** The value to copy (a share link). */
  value: string;
  /** Pins a look (the reference blocks draw `copied` and `manual` without a click). */
  state?: "idle" | "copied" | "manual";
};

/**
 * A value people copy and may see again (spec §6.44): a labelled read-only field and a copy button
 * that reads 已复制 for two seconds after copying. Unlike `SecretReveal` there is no "shown once"
 * line. Without a usable clipboard (an insecure origin, a refused permission) the field is selected
 * instead and a muted line says to copy it by hand.
 */
export function CopyField({ label, value, state: pinned }: CopyFieldProps) {
  const t = useDesignT();
  const id = useId();
  const [own, setOwn] = useState<"idle" | "copied" | "manual">("idle");
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
      const field = document.getElementById(id);
      if (field instanceof HTMLInputElement) {
        field.focus();
        field.select();
      }
      setOwn("manual");
    }
  };
  return (
    <div className="cb-copy-field" data-part="copy-field" data-state={state}>
      <label className="cb-copy-field-label" data-part="copy-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="cb-copy-field-row">
        <span className="cb-copy-field-value">
          <Input id={id} readOnly value={value} onFocus={(e) => e.target.select()} />
        </span>
        <Button onClick={() => void copy()}>
          <Icon name={state === "copied" ? "check" : "copy"} size={14} />
          {state === "copied" ? t("copy.copied") : t("copy.copy")}
        </Button>
      </div>
      {state === "manual" ? (
        <span className="cb-copy-field-manual" data-part="copy-field-manual" role="status">
          <Icon name="circle-alert" size={14} />
          {t("copy.manual")}
        </span>
      ) : null}
    </div>
  );
}
