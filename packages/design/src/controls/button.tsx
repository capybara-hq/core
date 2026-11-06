import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon } from "../icons/icon";
import { useDesignLink } from "../provider";
import { type Density, useDensity } from "./density";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "default" | "ghost" | "danger" | "danger-solid";
  /** The density step (spec §2.5); defaults to the surrounding `DensityContext`. */
  density?: Density;
  loading?: boolean;
  shortcut?: string;
  /** The `data-part` the size tables measure (default `button` / `icon-button`). */
  part?: string;
  ref?: Ref<HTMLButtonElement>;
};

export function Button({
  variant = "default",
  density,
  loading,
  shortcut,
  disabled,
  type = "button",
  part = "button",
  children,
  ...rest
}: ButtonProps) {
  const step = useDensity(density);
  return (
    <button
      {...rest}
      type={type}
      className={rest.className ? `cb-btn ${rest.className}` : "cb-btn"}
      data-part={part}
      data-variant={variant}
      data-density={step}
      // As a Menu / Popover trigger, Radix passes data-state (open / closed); keep it.
      data-state={loading ? "loading" : (rest as { "data-state"?: string })["data-state"]}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
    >
      <span className="cb-btn-body">
        {loading ? (
          <span className="cb-btn-spin" aria-hidden="true">
            <Icon name="spinner" size={14} />
          </span>
        ) : null}
        {children}
        {shortcut ? <span className="cb-btn-shortcut">{shortcut}</span> : null}
      </span>
    </button>
  );
}

export type LinkButtonProps = {
  href: string;
  /** The navigating variants (spec §6.1); default `default`. */
  variant?: "primary" | "secondary" | "default";
  density?: Density;
  /** A keyboard hint after the label, as on {@link Button}. */
  shortcut?: string;
  /** Out of the tab order (`-1`) where a roving container holds the tab stop (CardGrid). */
  tabIndex?: number;
  children: ReactNode;
};

/**
 * A button that navigates (spec §6.1): a link through the DesignProvider's `link`, drawn as the
 * Button of its variant and density, never in the browser's link colors.
 */
export function LinkButton({
  href,
  variant = "default",
  density,
  shortcut,
  tabIndex,
  children,
}: LinkButtonProps) {
  const Link = useDesignLink();
  const step = useDensity(density);
  return (
    <Link
      href={href}
      className={`cb-btn cb-btn-link cb-btn-link-${variant}`}
      data-part="button"
      data-variant={variant}
      data-density={step}
      {...(tabIndex !== undefined ? { tabIndex } : {})}
    >
      <span className="cb-btn-body">
        {children}
        {shortcut ? <span className="cb-btn-shortcut">{shortcut}</span> : null}
      </span>
    </Link>
  );
}

export function IconButton({
  label,
  icon,
  density,
  variant = "ghost",
  type = "button",
  part = "icon-button",
  ...rest
}: { label: string; icon: ReactNode; density?: Density } & Omit<
  ButtonProps,
  "density" | "shortcut" | "loading" | "children"
>) {
  const step = useDensity(density);
  return (
    <button
      {...rest}
      type={type}
      className={rest.className ? `cb-btn cb-icon-btn ${rest.className}` : "cb-btn cb-icon-btn"}
      data-part={part}
      data-variant={variant}
      data-density={step}
      aria-label={label}
      title={rest.title ?? label}
    >
      {icon}
    </button>
  );
}
