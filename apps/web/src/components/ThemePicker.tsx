"use client";

import {
  BUILTIN_THEME_SWATCHES,
  Grid,
  parseTheme,
  ThemeSwatch,
  type ThemeSwatchColors,
} from "@capybara-hq/design";
import { useEffect, useState } from "react";
import type { ThemeScheme } from "../lib/themes";

/** One card of a theme picker: a theme, or a level's fallback (内置主题, 跟随平台, 默认). */
export interface ThemeChoice {
  /** The value the picker reports (a theme id, or the caller's word for the fallback). */
  value: string;
  name: string;
  /** The swatches of each scheme the choice defines (`BUILTIN_THEME_SWATCHES` for the built-in). */
  swatches: Partial<Record<ThemeScheme, ThemeSwatchColors>>;
}

/**
 * The page's color scheme (`<html data-theme>`, the account row's toggle): dark while hydrating
 * (the server cannot know it), then the document's, following later toggles.
 */
function usePageScheme(): ThemeScheme {
  const [scheme, setScheme] = useState<ThemeScheme>("dark");
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setScheme(parseTheme(root.dataset.theme));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return scheme;
}

/**
 * A theme picker (themes spec §10, design spec §6.37): a radio group of `ThemeSwatch` cards named
 * by `label`, each drawn in the page's scheme when the choice defines it, else in its only one.
 * `disabled` (a member reading the org's choice) keeps the selection visible.
 */
export function ThemePicker({
  label,
  value,
  choices,
  onChange,
  disabled = false,
}: {
  label: string;
  /** The selected choice's value; one no card has selects none. */
  value: string;
  choices: ThemeChoice[];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const pageScheme = usePageScheme();
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
      <Grid columns={3} gap={12}>
        {choices.map((c) => {
          const scheme: ThemeScheme =
            c.swatches[pageScheme] !== undefined
              ? pageScheme
              : c.swatches.dark !== undefined
                ? "dark"
                : c.swatches.light !== undefined
                  ? "light"
                  : pageScheme;
          return (
            <ThemeSwatch
              key={c.value}
              name={c.name}
              scheme={scheme}
              swatches={c.swatches[scheme] ?? BUILTIN_THEME_SWATCHES[scheme]}
              selected={c.value === value}
              disabled={disabled}
              onSelect={() => onChange(c.value)}
            />
          );
        })}
      </Grid>
    </div>
  );
}

/** The built-in theme as a choice. */
export const builtinChoice = (value: string, name: string): ThemeChoice => ({
  value,
  name,
  swatches: BUILTIN_THEME_SWATCHES,
});
