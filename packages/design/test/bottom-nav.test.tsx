import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { BOTTOM_NAV_FIXTURE } from "../src/fixtures/index";
import {
  AppShell,
  BottomNav,
  type BottomNavItem,
  bottomNavCurrent,
  DesignProvider,
  isTabRoot,
} from "../src/index";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const items: BottomNavItem[] = BOTTOM_NAV_FIXTURE.items.map((i) => ({
  ...(i as BottomNavItem),
  ...(i.id === "chats" ? { also: ["/chat", "/"] } : {}),
  ...(i.id === "me" ? { also: ["/skills", "/settings"] } : {}),
}));

const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

const sidebar = {
  context: {
    kind: "work" as const,
    org: null,
    primary: [{ id: "agents", label: "智能体", href: "/agents", icon: "agent" as const }],
    more: [],
  },
  activeNav: "agents",
  account: { name: "grant", menu: [] },
};
const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };

describe("BottomNav", () => {
  it("renders exactly four links in the fixed order, in a nav named 主导航", () => {
    zh(<BottomNav items={items} current="agents" />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/conversations",
      "/agents",
      "/inbox",
      "/me",
    ]);
    expect(links.map((l) => l.getAttribute("data-id"))).toEqual(["chats", "agents", "inbox", "me"]);
  });

  it("marks the current item with aria-current and no other", () => {
    zh(<BottomNav items={items} current="agents" />);
    const current = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    expect(current.map((l) => l.getAttribute("data-id"))).toEqual(["agents"]);
  });

  it("the inbox badge reads 99+ above 99, n+ when truncated, and names the count", () => {
    zh(
      <BottomNav
        items={items.map((i) => (i.id === "inbox" ? { ...i, count: 120 } : i))}
        current="chats"
      />,
    );
    const inbox = screen.getByRole("link", { name: "收件箱，99+ 项待处理" });
    expect(inbox.querySelector('[data-part="item-badge"]')?.textContent).toBe("99+");
    cleanup();
    zh(
      <BottomNav
        items={items.map((i) => (i.id === "inbox" ? { ...i, count: 3, countMore: true } : i))}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: "收件箱，3+ 项待处理" })
        .querySelector('[data-part="item-badge"]')?.textContent,
    ).toBe("3+");
  });

  it("draws no badge without a pending count, and keeps every item's name when the labels go", () => {
    zh(<BottomNav items={items.map((i) => ({ ...i, count: 0 }))} short />);
    expect(document.querySelector('[data-part="item-badge"]')).toBeNull();
    expect(screen.getByRole("link", { name: "收件箱" })).toBeTruthy();
    expect(document.querySelector('[data-part="bottom-nav"]')?.getAttribute("data-short")).toBe(
      "true",
    );
  });

  it("is the shell's tab roots only: tab root detection and the tab holding a pushed route", () => {
    expect(isTabRoot(items, "/agents")).toBe(true);
    expect(isTabRoot(items, "/agents/new")).toBe(false);
    expect(isTabRoot(items, "/")).toBe(false);
    expect(bottomNavCurrent(items, "/agents/new")).toBe("agents");
    expect(bottomNavCurrent(items, "/chat/abc")).toBe("chats");
    expect(bottomNavCurrent(items, "/")).toBe("chats");
    expect(bottomNavCurrent(items, "/settings/organization")).toBe("me");
    expect(bottomNavCurrent(items, "/devices")).toBeNull();
  });
});

describe("the bottom navigation in the shell", () => {
  const shell = (pathname: string, extra: Record<string, unknown> = {}) => (
    <DesignProvider locale="zh">
      <AppShell
        sidebar={sidebar}
        status={status}
        commands={[]}
        bottomNav={items}
        pathname={pathname}
        {...extra}
      >
        <div>内容</div>
      </AppShell>
    </DesignProvider>
  );

  it("is in the server markup on a tab root, and CSS hides it outside compact", () => {
    const html = renderToString(shell("/agents"));
    expect(html).toContain('data-part="bottom-nav"');
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/shell.css"), "utf8");
    expect(css).toMatch(/\.cb-shell-topbar,\s*\.cb-shell-bottomnav \{\s*display: none;/);
    expect(css).toMatch(
      /@media \(max-width: 599px\) \{[\s\S]*?\.cb-shell-bottomnav \{\s*display: block;/,
    );
    expect(css).toMatch(
      /\.cb-shell\[data-keyboard="open"\] \.cb-shell-bottomnav \{\s*display: none;/,
    );
  });

  it("is hidden on a pushed route, where the top bar shows back instead", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    zh(
      <AppShell
        sidebar={sidebar}
        status={status}
        commands={[]}
        bottomNav={items}
        pathname="/agents/new"
      >
        <div>内容</div>
      </AppShell>,
    );
    expect(document.querySelector('[data-part="bottom-nav"]')).toBeNull();
    const bar = document.querySelector('[data-part="top-bar"]') as HTMLElement;
    expect(bar.getAttribute("data-pushed")).toBe("true");
    expect(within(bar).getByRole("link", { name: "返回" })).toBeTruthy();
  });

  it("on a tab root shows the bar with the item current and no back button", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    zh(
      <AppShell
        sidebar={sidebar}
        status={status}
        commands={[]}
        bottomNav={items}
        pathname="/agents"
      >
        <div>内容</div>
      </AppShell>,
    );
    const nav = document.querySelector('[data-part="bottom-nav"]') as HTMLElement;
    expect(
      within(nav)
        .getAllByRole("link")
        .filter((l) => l.getAttribute("aria-current") === "page")
        .map((l) => l.getAttribute("data-id")),
    ).toEqual(["agents"]);
    const bar = document.querySelector('[data-part="top-bar"]') as HTMLElement;
    expect(bar.getAttribute("data-pushed")).toBe("false");
    expect(within(bar).queryByRole("button", { name: "返回" })).toBeNull();
    // the tab root's title is its item's label until the page registers its own
    expect(bar.querySelector('[data-part="title"]')?.textContent).toBe("智能体");
  });
});
