export type Theme = "dark" | "light";

export const THEME_COOKIE = "cb-theme";

/** 非法值回落到默认的深色。 */
export function parseTheme(v: string | undefined): Theme {
  return v === "light" ? "light" : "dark";
}

/** 设置 `<html data-theme>` 并把选择写入 Cookie（一年），服务端首屏据此渲染。 */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  // biome-ignore lint/suspicious/noDocumentCookie: 需同步写入，Cookie Store API 为异步且支持不全
  document.cookie = `${THEME_COOKIE}=${t}; max-age=31536000; path=/; samesite=lax`;
}
