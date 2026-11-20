import { type JSX, useId } from "react";
import { Input, Textarea } from "../controls/inputs";

// A person field row (platform web parity spec §4.2): one secret value the person types into an
// approval card, so the agent never sees it. Always masked, no reveal toggle, never prefilled.

export type PersonFieldRowProps = {
  label: string;
  description?: string | undefined;
  /** A multi-line value (a private key, a certificate): a masked textarea instead of an input. */
  multiline: boolean;
  value: string;
  /** Why the value was refused; shown under the field. */
  error?: string | undefined;
  onChange(v: string): void;
  disabled?: boolean | undefined;
};

export function PersonFieldRow(p: PersonFieldRowProps): JSX.Element {
  const id = useId();
  const descId = `${id}-desc`;
  const errId = `${id}-err`;
  const described = [p.description ? descId : "", p.error ? errId : ""].filter(Boolean).join(" ");
  const common = {
    id,
    "aria-label": p.label,
    "aria-describedby": described === "" ? undefined : described,
    "aria-invalid": p.error ? true : undefined,
    autoComplete: "off",
    spellCheck: false,
    value: p.value,
    disabled: p.disabled,
  } as const;
  return (
    <div className="cb-person-field" data-part="person-field">
      <label className="cb-person-field-label cb-small" htmlFor={id} data-part="person-field-label">
        {p.label}
      </label>
      {p.description ? (
        <span className="cb-muted cb-small" id={descId} data-part="person-field-description">
          {p.description}
        </span>
      ) : null}
      {p.multiline ? (
        <Textarea
          {...common}
          rows={4}
          data-masked="true"
          onChange={(e) => p.onChange(e.target.value)}
        />
      ) : (
        <Input {...common} type="password" onChange={(e) => p.onChange(e.target.value)} />
      )}
      {p.error ? (
        <span
          className="cb-person-field-error cb-small"
          id={errId}
          role="alert"
          data-part="person-field-error"
        >
          {p.error}
        </span>
      ) : null}
    </div>
  );
}
