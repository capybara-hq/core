export type ControlA11y = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
};

/**
 * The fields a dialog that asks for input, or a create form, starts on: the first enabled text,
 * choice or select control (spec §6.7, §5.3); a `Select` is its `combobox` button, never its hidden
 * form copy.
 */
export const FIELDS =
  'input:not([type="hidden"]):not([type="file"]):not(:disabled), select:not(:disabled):not([aria-hidden="true"]), button[role="combobox"]:not(:disabled), textarea:not(:disabled)';
