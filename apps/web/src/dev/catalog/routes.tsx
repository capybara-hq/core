/**
 * `/dev/ui` 目录页的路由表（纯数据：服务端页面、jsdom 单测与 Playwright 截图共用，不得引入 React 组件）。
 * 模板路由与 `PAGE_TEMPLATES` 一一对应（单测核对），名称为组件名去掉 `Page` 后的 kebab 形式。
 */
export const TEMPLATE_ROUTES = [
  "templates/overview",
  "templates/list",
  "templates/detail",
  "templates/form",
  "templates/settings",
  "templates/inbox",
  "templates/playground",
  "templates/trace",
  "templates/wizard",
  "templates/auth",
  "templates/status",
  "templates/onboarding",
] as const;

export const OVERLAY_ROUTES = [
  "overlays/dialog",
  "overlays/danger",
  "overlays/sheet",
  "overlays/menu",
  "overlays/command",
  "overlays/toast",
] as const;

export const CATALOG_ROUTES = [
  "components",
  "table",
  ...OVERLAY_ROUTES,
  ...TEMPLATE_ROUTES,
  "stress",
] as const;

export type CatalogRoute = (typeof CATALOG_ROUTES)[number];
export type TemplateRoute = (typeof TEMPLATE_ROUTES)[number];
export type OverlayRoute = (typeof OVERLAY_ROUTES)[number];

export function isCatalogRoute(r: string): r is CatalogRoute {
  return (CATALOG_ROUTES as readonly string[]).includes(r);
}

export function isOverlayRoute(r: string): r is OverlayRoute {
  return (OVERLAY_ROUTES as readonly string[]).includes(r);
}

export function isTemplateRoute(r: string): r is TemplateRoute {
  return (TEMPLATE_ROUTES as readonly string[]).includes(r);
}

/** 生产构建默认关闭目录页；截图回归用 `CAPYBARA_DEV_UI=1` 打开。 */
export function devUiEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.CAPYBARA_DEV_UI === "1";
}
