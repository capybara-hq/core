import { useEffect, useId, useState } from "react";
import { Button } from "../controls/index";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

export type SecretRevealProps = {
  /** The field's label ("令牌"). */
  label: string;
  /** The secret, shown only in this view. */
  value: string;
};

/**
 * A secret shown once (spec §6.22): a labelled read-only field in mono holding the value, a copy
 * button that reads 已复制 for two seconds after copying, and a `warn` line saying it is shown only
 * this once.
 */
export function SecretReveal({ label, value }: SecretRevealProps) {
  const t = useDesignT();
  const id = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="cb-secret" data-part="secret-reveal">
      <label className="cb-secret-label" htmlFor={id}>
        {label}
      </label>
      <div className="cb-secret-row">
        <input
          id={id}
          className="cb-input cb-secret-value"
          readOnly
          value={value}
          onFocus={(e) => e.target.select()}
        />
        <Button
          density="default"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={14} />
          {copied ? t("secret.copied") : t("secret.copy")}
        </Button>
      </div>
      <span className="cb-secret-once" data-part="secret-once">
        <Icon name="circle-alert" size={14} />
        {t("secret.once")}
      </span>
    </div>
  );
}
