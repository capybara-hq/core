import { cloneElement, type ReactElement, useId } from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

export function Field({
  label,
  required,
  optional,
  help,
  error,
  count,
  onReset,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  help?: string;
  error?: string;
  count?: { value: number; max: number };
  onReset?: () => void;
  children: ReactElement<Record<string, unknown>>;
}) {
  const t = useDesignT();
  const base = useId();
  const id = (children.props.id as string | undefined) ?? `${base}-control`;
  const helpId = `${base}-help`;
  const errorId = `${base}-error`;
  const countId = `${base}-count`;
  const describedBy = [error ? errorId : help ? helpId : null, count ? countId : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="cb-field" data-state={error ? "error" : undefined}>
      <div className="cb-field-head">
        <label className="cb-field-label" data-part="field-label" htmlFor={id}>
          {label}
          {required ? (
            <span className="cb-field-req" aria-hidden="true">
              {" *"}
            </span>
          ) : null}
          {optional && !required ? (
            <span className="cb-field-opt"> ({t("field.optional")})</span>
          ) : null}
        </label>
        {onReset ? (
          <button type="button" className="cb-field-reset" onClick={onReset}>
            {t("field.reset")}
          </button>
        ) : null}
      </div>
      {cloneElement(children, {
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {error ? (
        <div className="cb-field-error" data-part="field-error" id={errorId}>
          <Icon name="circle-alert" size={12} />
          <span>{error}</span>
        </div>
      ) : help ? (
        <div className="cb-field-help" id={helpId}>
          {help}
        </div>
      ) : null}
      {count ? (
        <div className="cb-field-count" id={countId}>
          {`${count.value} / ${count.max}`}
        </div>
      ) : null}
    </div>
  );
}
