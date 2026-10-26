import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "../icons/icon";
import { type Density, useDensity } from "./density";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "default" | "ghost" | "danger" | "danger-solid";
  /** The density step (spec §2.5); defaults to the surrounding `DensityContext`. */
  density?: Density;
  loading?: boolean;
  shortcut?: string;
};

export function Button({
  variant = "default",
  density,
  loading,
  shortcut,
  disabled,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const step = useDensity(density);
  return (
    <button
      {...rest}
      type={type}
      className="cb-btn"
      data-part="button"
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

export function IconButton({
  label,
  icon,
  density,
  variant = "ghost",
  type = "button",
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
      className="cb-btn cb-icon-btn"
      data-part="icon-button"
      data-variant={variant}
      data-density={step}
      aria-label={label}
      title={rest.title ?? label}
    >
      {icon}
    </button>
  );
}
