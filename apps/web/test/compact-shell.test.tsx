// The chat-first compact shell in the app frame (design spec §4.6; mobile touch plan Task 28): no
// bottom navigation and no top bar; a chat surface (the home, a conversation) leads with the menu
// button carrying the inbox count, every other page with back; the menu opens the drawer, whose
// picks pop its history entry before they navigate, and the system back closes an open drawer or
// account sheet before it leaves the page.

import { useQuery } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { membersQuery } from "../src/lib/query/members";
import { stubApi } from "./support/api";
import { pathname as currentPath, resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { frameElement, renderFrame, shellClient, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/** A compact window (390 wide); `coarse` adds the touch query (the overlays' history entries). */
function phone(coarse: boolean, windowWidth = 390) {
  vi.stubGlobal("matchMedia", (q: string) => {
    const t = q.trim();
    const width = [...t.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
    let matches: boolean;
    if (/pointer/.test(t)) {
      matches = t.includes("not (any-pointer: fine)")
        ? coarse
        : t === "(any-pointer: fine)"
          ? !coarse
          : coarse;
    } else {
      matches =
        width.length > 0 &&
        width.every(([, k, n]) =>
          k === "min" ? windowWidth >= Number(n) : windowWidth <= Number(n),
        );
    }
    return { matches, media: q, addEventListener() {}, removeEventListener() {} };
  });
}

beforeEach(() => {
  resetNavigation("/");
  window.history.replaceState(null, "", "/");
  phone(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bar = () => document.querySelector('[data-part="floating-bar"]') as HTMLElement;
const menuButton = () => within(bar()).queryByRole("button", { name: /^打开菜单/ });
const drawerEl = () => document.querySelector('[data-part="drawer"]') as HTMLElement | null;
const pending = { pending: { count: 3, more: false } };
const settled = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the floating row in the frame", () => {
  it.each(["/", "/chat/c1"])(
    "%s is a chat surface: the menu button with the inbox count",
    (path) => {
      resetNavigation(path);
      renderFrame(shellOf(ME, pending));
      const menu = menuButton() as HTMLElement;
      expect(menu.getAttribute("aria-label")).toBe("打开菜单，3 项待处理");
      expect(menu.querySelector('[data-part="float-badge"]')?.textContent).toBe("3");
      expect(within(bar()).queryByLabelText("返回")).toBeNull();
      expect(document.querySelector(".cb-shell")?.getAttribute("data-surface")).toBe("chat");
    },
  );

  it.each(["/conversations", "/inbox", "/agents", "/agents/new", "/account/profile"])(
    "%s is pushed: back, no menu button",
    (path) => {
      resetNavigation(path);
      renderFrame(shellOf(ME, pending));
      expect(menuButton()).toBeNull();
      expect(within(bar()).getByLabelText("返回")).toBeTruthy();
      expect(document.querySelector(".cb-shell")?.getAttribute("data-surface")).toBe("pushed");
    },
  );

  it.each(["/", "/chat/c1", "/inbox"])("%s: no bottom navigation, no top bar", (path) => {
    resetNavigation(path);
    renderFrame(shellOf(ME, pending));
    expect(document.querySelector('[data-part="bottom-nav"]')).toBeNull();
    expect(document.querySelector('[data-part="top-bar"]')).toBeNull();
  });

  it("the home renders no trailing floating control (no incognito button)", () => {
    renderFrame(shellOf(ME, pending));
    expect(bar().querySelectorAll("button, a")).toHaveLength(1);
  });

  it("the setup frame has no bottom navigation and no drawer", () => {
    renderFrame(
      shellOf(ME, { readiness: { modelProvider: "none", orgFixableProviders: [], agents: 0 } }),
    );
    expect(document.querySelector('[data-part="bottom-nav"]')).toBeNull();
    expect(menuButton()).toBeNull();
  });
});

describe("the drawer from the menu button", () => {
  it("holds the sections with the count, the more level, 全部会话, the account row and 新会话", async () => {
    renderFrame(shellOf(ME, pending));
    await userEvent.click(menuButton() as HTMLElement);
    const panel = drawerEl() as HTMLElement;
    const sections = [...panel.querySelectorAll("[data-nav-section]")];
    expect(sections.map((s) => s.getAttribute("data-nav-section"))).toEqual([
      "inbox",
      "agents",
      "schedules",
    ]);
    expect(sections[0]?.querySelector('[data-part="navrow-badge"]')?.textContent).toBe("3");
    expect(within(panel).getByRole("link", { name: "全部会话" }).getAttribute("href")).toBe(
      "/conversations",
    );
    expect(panel.querySelector('[data-part="drawer-new"]')?.getAttribute("href")).toBe("/");
    // no management entry anywhere in the drawer
    for (const label of ["插件", "扩展", "渠道", "评测与运行", "组织设置", "管理后台"])
      expect(within(panel).queryByRole("link", { name: label })).toBeNull();
    await userEvent.click(within(panel).getByRole("button", { name: "更多" }));
    const level = document.querySelector('[data-part="drawer-level"]') as HTMLElement;
    expect(
      within(level)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/skills", "/connectors", "/devices"]);
  });

  it("最近会话 reads my newest conversations by time, each with its agent and state", async () => {
    const now = new Date().toISOString();
    const row = (id: string, agentId: string, title: string, activity: string | null) => ({
      id,
      orgId: "o1",
      agentId,
      title,
      titleSource: null,
      deviceId: null,
      activity,
      lastSeq: 1,
      createdAt: now,
      updatedAt: now,
    });
    const calls = stubApi({
      "GET /api/v1/orgs/o1/conversations": () =>
        new Response(
          JSON.stringify({
            conversations: [
              row("c2", "ag2", "部署失败排查", "waiting"),
              row("c1", "ag1", "周报", null),
            ],
            next: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const agent = (id: string, name: string) => ({
      agent: { id, name, profile: { avatar: null, updatedAt: now } },
      latestAt: now,
      conversations: [],
      more: false,
    });
    renderFrame(
      shellOf(ME, {
        ...pending,
        groups: { groups: [agent("ag2", "运维助手"), agent("ag1", "写作助手")], next: null },
      }),
    );
    await userEvent.click(menuButton() as HTMLElement);
    const panel = drawerEl() as HTMLElement;
    const first = await within(panel).findByRole("link", { name: /部署失败排查/ });
    expect(first.textContent).toContain("运维助手");
    expect(first.querySelector('[data-part="convlist-state"]')?.textContent).toBe("等你处理");
    const titles = [...panel.querySelectorAll('[data-part="convlist-title"]')].map(
      (t) => t.textContent,
    );
    expect(titles).toEqual(["部署失败排查", "周报"]);
    expect(calls.map((c) => c.url)).toContain("/api/v1/orgs/o1/conversations?limit=30");
  });

  it("the account row opens the account sheet: the profile row, the org, status, sign out", async () => {
    renderFrame(shellOf(ME, pending));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: /Grant/ }));
    const sheet = document.querySelector('[data-part="account-sheet"]') as HTMLElement;
    // the profile row opens Personal settings (maintainer decision 2026-11-22)
    expect(within(sheet).getByRole("link", { name: /Grant/ }).getAttribute("href")).toBe(
      "/account/profile",
    );
    expect(within(sheet).getByText("Acme")).toBeTruthy();
    expect(within(sheet).getByText(/grant@acme:~/)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "退出登录" })).toBeTruthy();
    // a browser has no native profile switcher
    expect(within(sheet).queryByRole("button", { name: "切换平台" })).toBeNull();
  });

  it("the account sheet has a 语言 line: picking English switches and closes the sheet and drawer", async () => {
    renderFrame(shellOf(ME, pending));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: /Grant/ }));
    const sheet = document.querySelector('[data-part="account-sheet"]') as HTMLElement;
    const line = sheet.querySelector('[data-part="account-language"]') as HTMLElement;
    expect(line.textContent).toContain("中文");
    await userEvent.click(line);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "English" }));
    await waitFor(() => expect(document.cookie).toContain("NEXT_LOCALE=en"));
    await waitFor(() => expect(document.querySelector('[data-part="account-sheet"]')).toBeNull());
    await waitFor(() => expect(drawerEl()).toBeNull());
  });

  it("picking another org in the account sheet closes the sheet and the drawer", async () => {
    const two = {
      ...ME,
      memberships: [...ME.memberships, { orgId: "o2", slug: "beta", name: "Beta", role: "member" }],
    };
    renderFrame(shellOf(two, pending));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: /Grant/ }));
    await userEvent.click(screen.getByRole("button", { name: /组织/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Beta" }));
    await waitFor(() => expect(document.querySelector('[data-part="account-sheet"]')).toBeNull());
    await waitFor(() => expect(drawerEl()).toBeNull());
  });
});

describe("back closes the overlays first (Decision 25)", () => {
  beforeEach(() => phone(true));

  it("with the drawer open, history.back() closes it without a route change", async () => {
    renderFrame(shellOf(ME, pending));
    await userEvent.click(menuButton() as HTMLElement);
    expect(drawerEl()).not.toBeNull();
    act(() => window.history.back());
    await waitFor(() => expect(drawerEl()).toBeNull());
    await settled();
    expect(window.location.pathname).toBe("/");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a drawer pick pops its entry before navigating: one back goes to the previous page", async () => {
    window.history.replaceState(null, "", "/agents");
    window.history.pushState(null, "", "/");
    const at: { href: string; path: string; overlay: unknown }[] = [];
    router.push.mockImplementation((href: string) => {
      at.push({
        href,
        path: window.location.pathname,
        overlay: (window.history.state as Record<string, unknown> | null)?.cbOverlay,
      });
      window.history.pushState(null, "", href);
    });
    renderFrame(shellOf(ME, pending));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("link", { name: /收件箱/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(at).toEqual([{ href: "/inbox", path: "/", overlay: undefined }]);
    await waitFor(() => expect(drawerEl()).toBeNull());
    // the page's own entry lies right behind the new one, then the page before it
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
  });

  it("the account sheet over the drawer: back closes the sheet, then the drawer", async () => {
    renderFrame(shellOf(ME, pending));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: /Grant/ }));
    const sheet = () => document.querySelector('[data-part="account-sheet"]');
    expect(sheet()).not.toBeNull();
    act(() => window.history.back());
    await waitFor(() => expect(sheet()).toBeNull());
    expect(drawerEl()).not.toBeNull();
    act(() => window.history.back());
    await waitFor(() => expect(drawerEl()).toBeNull());
    await settled();
    expect(window.location.pathname).toBe("/");
    expect(currentPath.current).toBe("/");
  });
});

describe("management pages on touch (Task 29)", () => {
  const MANAGEMENT = ["插件", "扩展", "渠道", "评测与运行", "组织设置"];
  const MembersPage = () => {
    useQuery(membersQuery("o1"));
    return <p>成员页</p>;
  };

  it("the sidebar's management entries carry data-desktop-only", async () => {
    phone(false, 1440);
    renderFrame(shellOf(ME, pending));
    // the admin entry above the account row
    expect(
      document.querySelector('[data-part="admin-entry"]')?.hasAttribute("data-desktop-only"),
    ).toBe(true);
    // the More flyout: the management items are flagged, skills / connectors / devices are not
    const toggle = document.querySelector('[data-part="more-toggle"]') as HTMLElement;
    await userEvent.click(toggle);
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    for (const label of MANAGEMENT) {
      const item = within(menu).getByRole("menuitem", { name: label });
      expect(item.hasAttribute("data-desktop-only"), label).toBe(true);
    }
    for (const label of ["设备"]) {
      expect(
        within(menu).getByRole("menuitem", { name: label }).hasAttribute("data-desktop-only"),
      ).toBe(false);
    }
  });

  it("the command palette flags the management commands only", async () => {
    phone(false, 1440);
    renderFrame(shellOf(ME, pending));
    await userEvent.keyboard("{Control>}k{/Control}");
    const items = [...document.querySelectorAll('[data-part="palette-item"]')];
    const flagged = (name: string) =>
      items.find((i) => i.textContent?.includes(name))?.hasAttribute("data-desktop-only");
    for (const label of [...MANAGEMENT, "管理后台"]) expect(flagged(label), label).toBe(true);
    for (const label of ["智能体", "技能", "连接器", "设备", "收件箱"])
      expect(flagged(label), label).toBe(false);
  });

  it("the drawer has no data-desktop-only entry", async () => {
    renderFrame(shellOf(ME, pending));
    await userEvent.click(menuButton() as HTMLElement);
    expect((drawerEl() as HTMLElement).querySelector("[data-desktop-only]")).toBeNull();
  });

  it("on touch at /settings/members the notice replaces the page and no members request is made", async () => {
    phone(true);
    resetNavigation("/settings/members");
    window.history.replaceState(null, "", "/settings/members");
    const calls = stubApi({});
    renderFrame(shellOf(ME, pending), <MembersPage />);
    await act(async () => {});
    expect(screen.queryByText("成员页")).toBeNull();
    expect(screen.getAllByRole("heading", { name: "请在电脑上管理" }).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.url.includes("/members"))).toEqual([]);
    expect(within(document.body).getByRole("link", { name: "回到对话" }).getAttribute("href")).toBe(
      "/",
    );
    expect(document.querySelector('[data-part="desktop-only-url"]')?.textContent).toBe(
      window.location.href,
    );
  });

  it("with a fine pointer the page is the page (and does read its data)", async () => {
    phone(false);
    resetNavigation("/settings/members");
    const calls = stubApi({
      "GET /api/v1/orgs/o1/members": () => new Response("{}", { status: 500 }),
    });
    renderFrame(shellOf(ME, pending), <MembersPage />);
    await act(async () => {});
    expect(screen.getByText("成员页")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "请在电脑上管理" })).toBeNull();
    expect(calls.some((c) => c.url.includes("/members"))).toBe(true);
  });

  it("a chat page on touch is never gated", () => {
    phone(true);
    resetNavigation("/agents");
    renderFrame(shellOf(ME, pending));
    expect(screen.queryByRole("heading", { name: "请在电脑上管理" })).toBeNull();
  });

  it("hydrating on touch over a stale cache fires no query of the gated page", async () => {
    phone(true);
    resetNavigation("/settings/members");
    window.history.replaceState(null, "", "/settings/members");
    const calls = stubApi({});
    const initial = shellOf(ME, pending);
    // an unclassified query, stale at once, already in the cache (as the layout's prefetch left it)
    const Page = () => {
      useQuery({
        queryKey: ["gated-page"],
        queryFn: async () => {
          await fetch("/api/v1/gated-page");
          return 1;
        },
        staleTime: 0,
      });
      return <p>成员页</p>;
    };
    const client = shellClient(initial);
    client.setQueryData(["gated-page"], 0);
    const html = renderToString(frameElement(initial, <Page />, {}, client));
    expect(html).toContain("请在电脑上管理");
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(host, frameElement(initial, <Page />, {}, client));
    });
    await act(async () => {});
    expect(calls.filter((c) => c.url.includes("gated-page"))).toEqual([]);
    act(() => root?.unmount());
    host.remove();
  });

  it("on touch the palette (hardware keyboard) lists no desktop-only command", async () => {
    phone(true, 1440);
    renderFrame(shellOf(ME, pending));
    await userEvent.keyboard("{Control>}k{/Control}");
    const labels = [...document.querySelectorAll('[data-part="palette-item"]')].map(
      (i) => i.textContent,
    );
    expect(labels.some((l) => l?.includes("智能体"))).toBe(true);
    for (const l of ["插件", "扩展", "组织设置", "管理后台"])
      expect(
        labels.some((x) => x?.includes(l)),
        l,
      ).toBe(false);
  });
});
