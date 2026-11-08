import { type CSSProperties, type KeyboardEvent, useRef } from "react";
import { Icon } from "../icons/icon";

/** A theme's color scheme: which of the two token sets it is built on (dark or light). */
export type ThemeScheme = "dark" | "light";

export type ThemeSwatchColors = { bg: string; panel: string; ink: string; accent: string };

/**
 * The built-in theme's swatches for each scheme (spec §6.37): references to the `--cb-builtin-*`
 * values tokens.css keeps outside the token names, so a theme on the page never changes them and a
 * picker draws the built-in theme as it is.
 */
export const BUILTIN_THEME_SWATCHES: Record<ThemeScheme, ThemeSwatchColors> = {
  dark: {
    bg: "var(--cb-builtin-dark-bg)",
    panel: "var(--cb-builtin-dark-panel)",
    ink: "var(--cb-builtin-dark-ink)",
    accent: "var(--cb-builtin-dark-accent)",
  },
  light: {
    bg: "var(--cb-builtin-light-bg)",
    panel: "var(--cb-builtin-light-panel)",
    ink: "var(--cb-builtin-light-ink)",
    accent: "var(--cb-builtin-light-accent)",
  },
};

export type ThemeSwatchProps = {
  /** The theme's display name. */
  name: string;
  /** The theme's own `bg`, `panel`, `ink` and `accent` values, drawn as a small preview. */
  swatches: ThemeSwatchColors;
  scheme: ThemeScheme;
  selected?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
  /** Set by `ThemeSwatchGroup` (the roving tab stop); a lone swatch keeps the default. */
  tabIndex?: number;
};

/**
 * One choice of a theme picker (spec §6.37): a preview of the theme's four colors over its name.
 * A radio; the caller wraps the cards in a `role="radiogroup"` with a label. The colors are data
 * from the theme, applied here as custom properties on the preview, so a page never writes a
 * color.
 */
export function ThemeSwatch({
  name,
  swatches,
  scheme,
  selected = false,
  onSelect,
  disabled,
  tabIndex,
}: ThemeSwatchProps) {
  const vars = {
    "--cb-swatch-bg": swatches.bg,
    "--cb-swatch-panel": swatches.panel,
    "--cb-swatch-ink": swatches.ink,
    "--cb-swatch-accent": swatches.accent,
  } as CSSProperties;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card with a preview is a button with role=radio
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      tabIndex={tabIndex}
      className="cb-theme-swatch"
      data-part="theme-swatch"
      data-scheme={scheme}
      data-state={selected ? "selected" : "default"}
      onClick={onSelect}
    >
      <span className="cb-theme-swatch-preview" data-part="theme-swatch-preview" style={vars}>
        <span className="cb-theme-swatch-panel" />
        <span className="cb-theme-swatch-ink" />
        <span className="cb-theme-swatch-accent" />
      </span>
      <span className="cb-theme-swatch-foot">
        <span className="cb-theme-swatch-name" data-part="theme-swatch-name" title={name}>
          {name}
        </span>
        <Icon name={scheme === "dark" ? "moon" : "sun"} size={12} />
      </span>
    </button>
  );
}

/** One choice of a {@link ThemeSwatchGroup}: a theme, or a level's fallback (built-in, follow). */
export type ThemeSwatchGroupItem = {
  value: string;
  name: string;
  /** The swatches of each scheme the choice defines (`BUILTIN_THEME_SWATCHES` for the built-in). */
  swatches: Partial<Record<ThemeScheme, ThemeSwatchColors>>;
};

export type ThemeSwatchGroupProps = {
  /** The group's accessible name. */
  label: string;
  /** The selected item's value; a value no item has selects none. */
  value: string;
  items: ThemeSwatchGroupItem[];
  onChange: (value: string) => void;
  /** The page's scheme: each card is drawn in it when the item defines it, else in its own. */
  scheme: ThemeScheme;
  /** Every card disabled (a reader of a setting), the selection still shown. */
  disabled?: boolean;
};

/**
 * A theme picker (spec §6.38): `ThemeSwatch` cards in a `role="radiogroup"` grid. One tab stop
 * (the selected card, else the first); the arrow keys, Home and End move to a card and select it,
 * as a radio group does.
 */
export function ThemeSwatchGroup({
  label,
  value,
  items,
  onChange,
  scheme,
  disabled = false,
}: ThemeSwatchGroupProps) {
  const root = useRef<HTMLDivElement>(null);
  const current = items.findIndex((i) => i.value === value);
  const stop = current === -1 ? 0 : current;
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || items.length === 0) return;
    const radios = Array.from(root.current?.querySelectorAll<HTMLElement>("[role=radio]") ?? []);
    const at = radios.indexOf(e.target as HTMLElement);
    if (at === -1) return;
    const n = items.length;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (at + 1) % n
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (at - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    const item = items[next] as ThemeSwatchGroupItem;
    radios[next]?.focus();
    onChange(item.value);
  };
  return (
    <div
      ref={root}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className="cb-theme-swatch-group"
      data-part="theme-swatch-group"
      onKeyDown={move}
    >
      {items.map((item, i) => {
        const own: ThemeScheme =
          item.swatches[scheme] !== undefined
            ? scheme
            : item.swatches.dark !== undefined
              ? "dark"
              : item.swatches.light !== undefined
                ? "light"
                : scheme;
        return (
          <ThemeSwatch
            key={item.value}
            name={item.name}
            scheme={own}
            swatches={item.swatches[own] ?? BUILTIN_THEME_SWATCHES[own]}
            selected={i === current}
            disabled={disabled}
            tabIndex={i === stop ? 0 : -1}
            onSelect={() => onChange(item.value)}
          />
        );
      })}
    </div>
  );
}
