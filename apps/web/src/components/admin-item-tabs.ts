import type { PageHeaderProps } from "@capybara-hq/design";

/**
 * The header tabs of the admin 智能体 / 连接器 pages (spec §3.1): the live items and their 模板, as
 * links. `labels` are the translated tab names; `active` is the open one.
 */
export function adminItemTabs(
  kind: "agents" | "connectors",
  active: "items" | "templates",
  labels: { items: string; templates: string },
): { tabs: NonNullable<PageHeaderProps["tabs"]>; activeTab: "items" | "templates" } {
  return {
    tabs: [
      { id: "items", label: labels.items, href: `/admin/${kind}` },
      { id: "templates", label: labels.templates, href: `/admin/${kind}/templates` },
    ],
    activeTab: active,
  };
}
