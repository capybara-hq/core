// The chat-first shell's drawer (design spec §6.53).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, type DrawerNavData, NavDrawer } from "../src/index";
import { findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const data: DrawerNavData = {
  sections: [
    { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox", badge: { count: 120 } },
    { id: "agents", label: "智能体", href: "/agents", icon: "agent" },
    { id: "schedules", label: "定时任务", href: "/schedules", icon: "clock" },
  ],
  more: [{ id: "skills", label: "技能", href: "/skills", icon: "skills" }],
  moreLabel: "技能、连接器、设备…",
  recent: {
    state: "ready",
    groups: [],
    moreGroups: false,
    onMoreGroups() {},
    onRetry() {},
    filter: { q: "", state: "all", onChange() {} },
    archived: { count: 0, open: false, onOpenChange() {} },
    onRename: async () => {},
    onArchive: async () => {},
    onDelete: async () => {},
  },
  allConversations: { label: "全部会话", href: "/conversations" },
  newConversation: { label: "新会话", href: "/" },
  onSearch() {},
  account: {
    name: "Grant",
    orgName: "Meta1",
    personalSettingsHref: "/account/profile",
    theme: null,
    status: null,
    onSignOut() {},
  },
};

const open = (pathname = "/") =>
  render(
    <DesignProvider locale="zh">
      <NavDrawer open onOpenChange={() => {}} data={data} pathname={pathname} />
    </DesignProvider>,
  );
const panel = () => document.querySelector('[data-part="drawer"]') as HTMLElement;

describe("NavDrawer", () => {
  it("marks the section the person is in as current, also on its pushed pages", () => {
    open("/agents/a1");
    const current = panel().querySelector('[aria-current="page"]');
    expect(current?.getAttribute("data-nav-section")).toBe("agents");
  });

  it("the inbox count reads 99+ above 99", () => {
    open();
    expect(panel().querySelector('[data-part="navrow-badge"]')?.textContent).toBe("99+");
  });

  it("without more entries there is no more row", () => {
    render(
      <DesignProvider locale="zh">
        <NavDrawer open onOpenChange={() => {}} data={{ ...data, more: [] }} />
      </DesignProvider>,
    );
    expect(within(panel()).queryByRole("button", { name: data.moreLabel })).toBeNull();
  });

  it("without onSearch there is no search row (the shell gives its palette's)", () => {
    const { onSearch: _, ...rest } = data;
    render(
      <DesignProvider locale="zh">
        <NavDrawer open onOpenChange={() => {}} data={rest} />
      </DesignProvider>,
    );
    expect(panel().querySelector('[data-part="drawer-search"]')).toBeNull();
  });

  it("the account row opens the account sheet over the drawer", async () => {
    open();
    await userEvent.click(within(panel()).getByRole("button", { name: /Grant/ }));
    expect(document.querySelector('[data-part="account-sheet"]')).not.toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("draws no nested box, in the list and in the more level", async () => {
    open();
    expect(findNestedBoxes(document.body)).toEqual([]);
    await userEvent.click(within(panel()).getByRole("button", { name: data.moreLabel }));
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("the spec gives NavDrawer, AccountSheet and FloatingBar their sections", () => {
    const spec = readFileSync(resolve(import.meta.dirname, "../../../docs/design/spec.md"), "utf8");
    for (const h of ["### 6.54 NavDrawer", "### 6.55 AccountSheet", "### 6.56 FloatingBar"]) {
      expect(spec).toContain(h);
    }
  });
});
