import { useId } from "react";
import { Select } from "../controls/inputs";
import { Icon } from "../icons/icon";
import type { Theme } from "../theme";

export type PreferenceBarProps = {
  /** The UI language: a dropdown of the languages, each named in its own language. */
  language: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange(value: string): void;
  };
  /** The theme: a two-choice radio (light, dark), one icon each. */
  theme: {
    label: string;
    value: Theme;
    lightLabel: string;
    darkLabel: string;
    onChange(value: Theme): void;
  };
};

/**
 * Language and theme, always one click away (spec §6.13): the sidebar's foot shows it above the
 * account (the rail folds it into the account menu instead), and the auth pages show it under
 * their card. The theme is a native radio group (arrow keys move the choice).
 */
export function PreferenceBar({ language, theme }: PreferenceBarProps) {
  const name = useId();
  const choices: { value: Theme; label: string; icon: "sun" | "moon" }[] = [
    { value: "light", label: theme.lightLabel, icon: "sun" },
    { value: "dark", label: theme.darkLabel, icon: "moon" },
  ];
  return (
    <div className="cb-prefs" data-part="preferences">
      <Select
        density="dense"
        aria-label={language.label}
        value={language.value}
        options={language.options}
        onChange={(e) => language.onChange(e.target.value)}
      />
      <div className="cb-prefs-theme" role="radiogroup" aria-label={theme.label}>
        {choices.map((c) => {
          const checked = c.value === theme.value;
          return (
            <label
              key={c.value}
              className="cb-prefs-theme-option"
              data-state={checked ? "checked" : "unchecked"}
              title={c.label}
            >
              <input
                type="radio"
                name={name}
                value={c.value}
                checked={checked}
                aria-label={c.label}
                onChange={() => theme.onChange(c.value)}
              />
              <Icon name={c.icon} size={14} />
            </label>
          );
        })}
      </div>
    </div>
  );
}
