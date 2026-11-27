// The chat-first shell's drawer (design spec §6.53).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, type DrawerNavData, NavDrawer } from "../src/index";
import { findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const data: DrawerNavData = {
  sections: [
    { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox", badge: { count: 120 } },
    { id: "agents", label: "智能体", href: "/agents", icon: "agent" },
    { id: "automations", label: "自动化", href: "/automations", icon: "clock" },
  ],
  more: [{ id: "skills", label: "技能", href: "/skills", icon: "skills" }],
  moreLabel: "技能、连接器、设备…",
  recent: { state: "ready", items: [], onRetry() {} },
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
    expect(within(panel()).queryByRole("button", { name: "更多" })).toBeNull();
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
    await userEvent.click(within(panel()).getByRole("button", { name: "更多" }));
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("the top row holds the search field and the 新会话 button", () => {
    open();
    const top = panel().querySelector('[data-part="drawer-top"]') as HTMLElement;
    expect(within(top).getByRole("button", { name: "搜索" })).toBeTruthy();
    const add = within(top).getByRole("link", { name: "新会话" });
    expect(add.getAttribute("href")).toBe("/");
    // no round compose button at the foot any more
    expect(panel().querySelector('[data-part="drawer-foot"] a')).toBeNull();
  });

  it("the navigation is one card: 收件箱 with its count, 智能体, 自动化, 更多", () => {
    open();
    const card = panel().querySelector('[data-part="drawer-nav-card"]') as HTMLElement;
    const rows = [...card.querySelectorAll('[data-part="nav-row"]')].map(
      (r) => r.querySelector(".cb-navrow-label")?.textContent,
    );
    expect(rows).toEqual(["收件箱", "智能体", "自动化", "更多"]);
    expect(card.querySelector('[data-part="navrow-badge"]')?.textContent).toBe("99+");
  });

  it("最近会话 lists the recent conversations by time with their state, and 全部 opens the page", () => {
    const now = new Date();
    const recent = {
      state: "ready" as const,
      onRetry() {},
      items: [
        {
          id: "c1",
          title: "部署失败排查",
          startedAt: now,
          updatedAt: now.toISOString(),
          href: "/chat/c1",
          agent: { name: "运维助手" },
          activity: "waiting" as const,
        },
        {
          id: "c2",
          title: "周报",
          startedAt: now,
          updatedAt: now.toISOString(),
          href: "/chat/c2",
          agent: { name: "写作助手" },
          activity: null,
        },
      ],
    };
    render(
      <DesignProvider locale="zh">
        <NavDrawer open onOpenChange={() => {}} data={{ ...data, recent }} />
      </DesignProvider>,
    );
    expect(panel().querySelector('[data-part="drawer-recent-label"]')?.textContent).toBe(
      "最近会话",
    );
    const all = within(panel()).getByRole("link", { name: "全部会话" });
    expect(all.getAttribute("href")).toBe("/conversations");
    expect(all.textContent).toBe("全部");
    const rows = [...panel().querySelectorAll('[data-part="convlist-row"]')];
    expect(rows.map((r) => r.querySelector('[data-part="convlist-title"]')?.textContent)).toEqual([
      "部署失败排查",
      "周报",
    ]);
    const state = rows[0]?.querySelector('[data-part="convlist-state"]');
    expect(state?.textContent).toBe("等你处理");
    expect(state?.getAttribute("data-tone")).toBe("warn");
    expect(rows[1]?.querySelector('[data-part="convlist-state"]')).toBeNull();
    // not grouped by agent, not sectioned: one card
    expect(panel().querySelectorAll('[data-part="convlist-card"]')).toHaveLength(1);
    expect(panel().querySelector('[data-part="convlist-section-label"]')).toBeNull();
  });

  it("lists at most 20 recent conversations", () => {
    const now = new Date().toISOString();
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`,
      title: `会话 ${i}`,
      startedAt: new Date(now),
      updatedAt: now,
      href: `/chat/c${i}`,
      agent: { name: "助手" },
      activity: null,
    }));
    render(
      <DesignProvider locale="zh">
        <NavDrawer
          open
          onOpenChange={() => {}}
          data={{ ...data, recent: { state: "ready", items, onRetry() {} } }}
        />
      </DesignProvider>,
    );
    expect(panel().querySelectorAll('[data-part="convlist-row"]')).toHaveLength(20);
  });

  it("a recent row's right click opens its actions over the drawer", async () => {
    const now = new Date().toISOString();
    const recent = {
      state: "ready" as const,
      onRetry() {},
      items: [
        {
          id: "c1",
          title: "部署失败排查",
          startedAt: new Date(now),
          updatedAt: now,
          href: "/chat/c1",
          agent: { name: "运维助手" },
          activity: null,
        },
      ],
      actions: {
        onRename: async () => {},
        onArchive: async () => {},
        onDelete: async () => {},
      },
    };
    render(
      <DesignProvider locale="zh">
        <NavDrawer open onOpenChange={() => {}} data={{ ...data, recent }} />
      </DesignProvider>,
    );
    fireEvent.contextMenu(within(panel()).getByRole("link", { name: /部署失败排查/ }));
    await waitFor(() =>
      expect(document.querySelector('[data-part="action-sheet"]')).not.toBeNull(),
    );
    expect(panel()).not.toBeNull();
  });

  it("the account row: avatar, name, org and a chevron; it opens the account sheet", async () => {
    open();
    const row = within(panel()).getByRole("button", { name: /Grant/ });
    expect(row.querySelector(".cb-account-org")?.textContent).toBe("Meta1");
    expect(row.querySelector('[data-icon="chevron-right"]')).not.toBeNull();
    await userEvent.click(row);
    expect(document.querySelector('[data-part="account-sheet"]')).not.toBeNull();
  });

  it("the spec gives NavDrawer, AccountSheet and FloatingBar their sections", () => {
    const spec = readFileSync(resolve(import.meta.dirname, "../../../docs/design/spec.md"), "utf8");
    for (const h of ["### 6.54 NavDrawer", "### 6.55 AccountSheet", "### 6.56 FloatingBar"]) {
      expect(spec).toContain(h);
    }
  });
});
