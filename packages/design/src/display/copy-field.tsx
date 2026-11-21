import { useId } from "react";
import { CopyCode, type CopyCodeState } from "./copy-code";

export type CopyFieldProps = {
  /** The field's label ("Link"). */
  label: string;
  /** The value to copy (a share link, a command). */
  value: string;
  /** A sentence under the value (what the link does, where to run the command). */
  help?: string;
  /** Pins a look (the reference blocks draw `copied` and `manual` without a click). */
  state?: CopyCodeState;
};

/**
 * A labelled value people copy and may see again (spec §6.44): the label over a `CopyCode`
 * (§6.58), and the help under it. Unlike `SecretReveal` there is no "shown once" line. It is the
 * form-field shape of CopyCode: use it where a value sits among fields or needs a visible name.
 */
export function CopyField({ label, value, help, state }: CopyFieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  return (
    <div className="cb-copy-field" data-part="copy-field">
      <span id={labelId} className="cb-copy-field-label" data-part="copy-field-label">
        {label}
      </span>
      <CopyCode
        value={value}
        labelledBy={labelId}
        {...(help === undefined ? {} : { describedBy: helpId })}
        {...(state === undefined ? {} : { state })}
      />
      {help === undefined ? null : (
        <span id={helpId} className="cb-copy-field-help" data-part="copy-field-help">
          {help}
        </span>
      )}
    </div>
  );
}
