import { useEffect, useId, useState } from "react";
import { Button } from "../controls/index";
import { Input } from "../controls/inputs";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

export type SecretRevealProps = {
  /** The field's label ("令牌"). */
  label: string;
  /** The secret, shown only in this view. */
  value: string;
  /** Pins the 已复制 look (the reference blocks draw that state without a click). */
  copied?: boolean;
};

/**
 * A secret shown once (spec §6.22): a labelled read-only field holding the value, a copy button
 * that reads 已复制 for two seconds after copying, and a `warn` line saying it is shown only this
 * once. Without a usable clipboard (an insecure origin, a refused permission) the field is
 * selected instead and the line says to copy it by hand.
 */
export function SecretReveal({ label, value, copied: pinned = false }: SecretRevealProps) {
  const t = useDesignT();
  const id = useId();
  const [state, setCopied] = useState<"no" | "yes" | "manual">("no");
  const copied = pinned ? "yes" : state;
  useEffect(() => {
    if (state !== "yes") return;
    const timer = setTimeout(() => setCopied("no"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
        throw new Error("no clipboard");
      }
      await navigator.clipboard.writeText(value);
      setCopied("yes");
    } catch {
      const field = document.getElementById(id);
      if (field instanceof HTMLInputElement) {
        field.focus();
        field.select();
      }
      setCopied("manual");
    }
  };
  return (
    <div
      className="cb-secret"
      data-part="secret-reveal"
      data-state={copied === "yes" ? "copied" : undefined}
    >
      <label className="cb-secret-label" data-part="secret-label" htmlFor={id}>
        {label}
      </label>
      <div className="cb-secret-row">
        <span className="cb-secret-value">
          <Input id={id} readOnly value={value} onFocus={(e) => e.target.select()} />
        </span>
        <Button onClick={() => void copy()}>
          <Icon name={copied === "yes" ? "check" : "copy"} size={14} />
          {copied === "yes" ? t("secret.copied") : t("secret.copy")}
        </Button>
      </div>
      <span className="cb-secret-once" data-part="secret-once">
        <Icon name="circle-alert" size={14} />
        {copied === "manual" ? t("secret.copyManual") : t("secret.once")}
      </span>
    </div>
  );
}
