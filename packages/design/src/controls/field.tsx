import { cloneElement, type ReactElement, type ReactNode, useId } from "react";
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
  action,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  help?: string;
  error?: string;
  count?: { value: number; max: number };
  onReset?: () => void;
  /**
   * A control that acts on the field's value (an 「添加」 button), drawn after the control on the
   * control's own line (spec §6.2); the help, error and count stay below both.
   */
  action?: ReactNode;
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
  const control = cloneElement(children, {
    id,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-required": required ? true : undefined,
  });
  return (
    <div className="cb-field" data-part="field" data-state={error ? "error" : undefined}>
      <div className="cb-field-head">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the label's own click; keys reach the control */}
        <label
          id={`${base}-label`}
          className="cb-field-label"
          data-part="field-label"
          htmlFor={id}
          // a Select is a button: not every browser focuses a button when its label is clicked
          onClick={(e) => {
            const control = e.currentTarget.ownerDocument.getElementById(id);
            if (control?.getAttribute("role") === "combobox" && control.tagName === "BUTTON")
              control.focus();
          }}
        >
          {label}
          {required ? (
            <span className="cb-field-req" aria-hidden="true">
              {" *"}
            </span>
          ) : null}
          {optional && !required ? (
            <span className="cb-field-opt"> {t("field.optional")}</span>
          ) : null}
        </label>
        {onReset ? (
          <button type="button" className="cb-field-reset" onClick={onReset}>
            {t("field.reset")}
          </button>
        ) : null}
      </div>
      {action ? (
        <div className="cb-field-control" data-part="field-control">
          {control}
          {action}
        </div>
      ) : (
        control
      )}
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
          {`${count.value.toLocaleString("en-US")} / ${count.max.toLocaleString("en-US")}`}
        </div>
      ) : null}
    </div>
  );
}
