import type { ButtonHTMLAttributes, ReactNode } from "react";

type Size = 24 | 28 | 36;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "default" | "ghost" | "danger" | "danger-solid";
  size?: Size;
  loading?: boolean;
  shortcut?: string;
};

export function Button({
  variant = "default",
  size = 28,
  loading,
  shortcut,
  disabled,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className="cb-btn"
      data-variant={variant}
      data-size={size}
      data-state={loading ? "loading" : undefined}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
    >
      {loading ? (
        <span className="cb-btn-spin" aria-hidden="true">
          ⠿
        </span>
      ) : null}
      {children}
      {shortcut ? <span className="cb-btn-shortcut">{shortcut}</span> : null}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  size = 28,
  variant = "ghost",
  type = "button",
  ...rest
}: { label: string; icon: ReactNode; size?: Size } & Omit<
  ButtonProps,
  "size" | "shortcut" | "loading" | "children"
>) {
  return (
    <button
      {...rest}
      type={type}
      className="cb-btn cb-icon-btn"
      data-variant={variant}
      data-size={size}
      aria-label={label}
      title={rest.title ?? label}
    >
      {icon}
    </button>
  );
}
