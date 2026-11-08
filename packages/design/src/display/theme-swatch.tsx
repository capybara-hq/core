import type { CSSProperties } from "react";
import { Icon } from "../icons/icon";

/** A theme's color scheme: which of the two token sets it is built on (dark or light). */
export type ThemeScheme = "dark" | "light";

export type ThemeSwatchColors = { bg: string; panel: string; ink: string; accent: string };

export type ThemeSwatchProps = {
  /** The theme's display name. */
  name: string;
  /** The theme's own `bg`, `panel`, `ink` and `accent` values, drawn as a small preview. */
  swatches: ThemeSwatchColors;
  scheme: ThemeScheme;
  selected?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
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
