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
  "templates/conversation",
  "templates/trace",
  "templates/wizard",
  "templates/auth",
  "templates/status",
  "templates/onboarding",
  "templates/setup",
] as const;

export const OVERLAY_ROUTES = [
  "overlays/dialog",
  "overlays/danger",
  "overlays/sheet",
  "overlays/menu",
  "overlays/command",
  "overlays/toast",
] as const;

/**
 * Real app pages drawn from a seeded query cache in the admin console's shell (`pages.tsx`): no
 * kernel behind them. Screenshotted by their own visual specs (`visual/admin-overview.spec.ts`,
 * `visual/schedules-calendar.spec.ts`), so they are not catalog routes.
 */
export const PAGE_ROUTES = [
  "pages/admin-overview",
  "pages/schedules-calendar",
  "pages/schedules-calendar-month",
  "pages/schedules-calendar-admin",
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
  // the head rhythm across the templates (spec §4.2, acceptance item S)
  "head-rhythm",
  "status-bar",
  "action-row",
  "template-list",
  "template-form",
  "template-detail",
  "template-overview",
  "template-inbox",
  "template-trace",
  "template-settings",
  "template-wizard",
  "template-auth",
  "button",
  "input",
  "select",
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
  "tool-group",
  "tool-row",
  "diff-block",
  "approval-block",
  // what a command was refused that no card lifts (network ask spec §6.5)
  "network-facts",
  "question-block",
  "connect-block",
  "queued-message",
  "file-card",
  "file-outputs",
  "attachment-strip",
  "file-preview",
  "subagent-group",
  "title-bar",
  "composer",
  "picker-menu",
  "command-palette",
  "inline-card",
  "property-section",
  "background-task",
  "task-output-panel",
  "right-panel",
  "template-conversation",
  // the role pass
  "no-access",
  "danger-zone",
  "secret-reveal",
  // plugin and component management acceptance: the detail / review section
  "content-section",
  // unslop fixes
  "error-detail",
  "file-picker",
  "run-row",
  "working-line",
  // the new conversation page (agent profile design §4)
  "greeting",
  "agent-row",
  "quick-actions",
  // the agent map (agent map spec §9) and its entry in the composer (AC3)
  "agent-map",
  "agents-chip",
  // agent avatars (agent profile design §2.3)
  "avatar",
  // config forms
  "repeater",
  "field-row",
  "key-value-editor",
  // loading states
  "skeleton",
  // one box is enough (acceptance item AB): the groupings inside a box
  "item-list",
  "subsection",
  "callout",
  // what a change would do, in its confirmation Dialog (text-pile pass, 2026-11-07)
  "impact-preview",
  // cards on the page ground (plugin scope phase 4, ruling P4-15)
  "card-grid",
  // one section of an overview page in its own state (admin overview design §10.2)
  "overview-section",
  // the usage chart: two panels on one x-axis, never a second y-scale (admin overview design §10.1)
  "trend-chart",
  // the scheduled tasks calendar: week, month and the phone agenda (scheduled tasks calendar design §6)
  "schedule-calendar",
  // tools with their policy next to them (the agent page's 工具 section, 2026-11-08)
  "tool-policy-list",
  // skills to choose, grouped with a select-all per group (maintainer acceptance 2026-11-12)
  "check-list",
  // theme picker card (themes spec §10)
  "theme-swatch",
  // the theme picker: the cards in one radio group (themes spec §10)
  "theme-swatch-group",
] as const;

export type ReferenceComponent = (typeof REFERENCE_COMPONENTS)[number];

export const REFERENCE_ROUTES = REFERENCE_COMPONENTS.map((c) => `reference/${c}` as const);

export type CatalogRoute = (typeof CATALOG_ROUTES)[number];
export type TemplateRoute = (typeof TEMPLATE_ROUTES)[number];
export type OverlayRoute = (typeof OVERLAY_ROUTES)[number];
export type PageRoute = (typeof PAGE_ROUTES)[number];

export function isPageRoute(r: string): r is PageRoute {
  return (PAGE_ROUTES as readonly string[]).includes(r);
}

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
