/** spec §2.1 与 §2.5 的全部颜色 / 阴影 token 名，对应 `--cb-<name>`。 */
export const TOKEN_NAMES = [
  "bg",
  "panel",
  "hover",
  "line",
  "line-strong",
  "ink",
  "muted",
  "faint",
  "accent",
  "accent-hover",
  "accent-press",
  "on-accent",
  "accent-tint",
  "ok",
  "fail",
  "warn",
  "scrim",
  "shadow-1",
  "shadow-2",
  "shadow-sheet",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
