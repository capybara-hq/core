"use client";

import {
  BUILTIN_THEME_SWATCHES,
  parseTheme,
  ThemeSwatchGroup,
  type ThemeSwatchGroupItem,
} from "@capybara-hq/design";
import { useEffect, useState } from "react";
import type { ThemeScheme } from "../lib/themes";

/** One card of a theme picker: a theme, or a level's fallback (内置主题, 跟随平台, 默认). */
export type ThemeChoice = ThemeSwatchGroupItem;

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
 * A theme picker (themes spec §10): the design `ThemeSwatchGroup` (§6.38) drawn in the page's
 * scheme. `disabled` (a member reading the org's choice) keeps the selection visible.
 */
export function ThemePicker({
  label,
  value,
  choices,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  choices: ThemeChoice[];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  return (
    <ThemeSwatchGroup
      label={label}
      value={value}
      items={choices}
      onChange={onChange}
      scheme={usePageScheme()}
      disabled={disabled}
    />
  );
}

/** The built-in theme as a choice. */
export const builtinChoice = (value: string, name: string): ThemeChoice => ({
  value,
  name,
  swatches: BUILTIN_THEME_SWATCHES,
});
