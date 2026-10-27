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

/**
 * Components of the reference set (every state list in docs/design/spec.md; a unit test keeps the
 * two equal). `/dev/ui/reference/<component>` renders one block per state with the reference ids,
 * for the measuring spec and the side-by-side page; it is not part of the screenshot routes.
 */
export const REFERENCE_COMPONENTS = [
  "page-header",
  "status-bar",
  "action-row",
  "template-list",
  "template-form",
  "button",
  "input",
  "switch",
  "segmented",
  "table",
  "icon",
  "sidebar",
  "stat-cards",
  "filter-chip",
  "prose",
  "thinking-row",
  "user-bubble",
  "run-divider",
] as const;

export type ReferenceComponent = (typeof REFERENCE_COMPONENTS)[number];

export const REFERENCE_ROUTES = REFERENCE_COMPONENTS.map((c) => `reference/${c}` as const);

export type CatalogRoute = (typeof CATALOG_ROUTES)[number];
export type TemplateRoute = (typeof TEMPLATE_ROUTES)[number];
export type OverlayRoute = (typeof OVERLAY_ROUTES)[number];

export function isCatalogRoute(r: string): r is CatalogRoute {
  return (CATALOG_ROUTES as readonly string[]).includes(r);
}

/** The component of a `reference/<component>` route, or null. */
export function referenceComponentOf(r: string): ReferenceComponent | null {
  const c = r.startsWith("reference/") ? r.slice("reference/".length) : "";
  return (REFERENCE_COMPONENTS as readonly string[]).includes(c) ? (c as ReferenceComponent) : null;
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
