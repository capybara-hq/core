import { useId } from "react";
import { Select } from "../controls/select";
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
  /**
   * The theme: a two-choice radio (light, dark), one icon each. Absent when the UI theme defines
   * only one scheme (themes spec §10): no toggle is drawn.
   */
  theme?: {
    label: string;
    value: Theme;
    lightLabel: string;
    darkLabel: string;
    onChange(value: Theme): void;
  };
};

/**
 * Language and theme for pages without the shell (spec §6.13): the auth pages show it under their
 * card, right-aligned. Inside the shell the theme sits after the account (ThemeToggle) and the
 * language is a submenu of the account menu.
 */
export function PreferenceBar({ language, theme }: PreferenceBarProps) {
  return (
    <div className="cb-prefs" data-part="preferences">
      <Select
        density="dense"
        aria-label={language.label}
        value={language.value}
        options={language.options}
        onChange={(e) => language.onChange(e.target.value)}
      />
      {theme ? <ThemeToggle {...theme} /> : null}
    </div>
  );
}

/**
 * The theme as a two-choice native radio group drawn as icon segments (`sun` light, `moon` dark;
 * arrow keys move the choice). The sidebar puts it after the account; PreferenceBar after the
 * language.
 */
export function ThemeToggle(theme: NonNullable<PreferenceBarProps["theme"]>) {
  const name = useId();
  const choices: { value: Theme; label: string; icon: "sun" | "moon" }[] = [
    { value: "light", label: theme.lightLabel, icon: "sun" },
    { value: "dark", label: theme.darkLabel, icon: "moon" },
  ];
  return (
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
  );
}
