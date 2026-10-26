import { createElement, type JSX } from "react";
import { ICON_NODES, type IconName } from "./paths";

export type IconSize = 16 | 14 | 12;

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * A line icon from the one site-wide set (24 grid, stroke 1.5; spec §4.2.3). Decorative by
 * default (`aria-hidden`); with `label` it is an image with that accessible name.
 */
export function Icon({
  name,
  size = 16,
  label,
}: {
  name: IconName;
  size?: IconSize;
  label?: string;
}): JSX.Element {
  return (
    <svg
      className="cb-icon"
      data-part="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      {ICON_NODES[name].map(([tag, attrs], i) =>
        createElement(tag, {
          key: i,
          ...Object.fromEntries(Object.entries(attrs).map(([k, v]) => [camel(k), v])),
        }),
      )}
    </svg>
  );
}
