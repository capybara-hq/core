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
      // 作为 Menu / Popover 触发器时 Radix 会传入 data-state（open / closed），不能被覆盖掉
      data-state={loading ? "loading" : (rest as { "data-state"?: string })["data-state"]}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
    >
      {/* 加载时 ⠿ 绝对定位在内容左侧、内容整体右移半个 ⠿ 宽：按钮宽度不变（spec §6.1 保持宽度）。 */}
      <span className="cb-btn-body">
        {loading ? (
          <span className="cb-btn-spin" aria-hidden="true">
            ⠿
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
