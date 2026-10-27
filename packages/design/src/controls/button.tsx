import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon } from "../icons/icon";
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
