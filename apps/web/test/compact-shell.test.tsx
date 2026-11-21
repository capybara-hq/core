// The chat-first compact shell in the app frame (design spec §4.6; mobile touch plan Task 28): no
// bottom navigation and no top bar; a chat surface (the home, a conversation) leads with the menu
// button carrying the inbox count, every other page with back; the menu opens the drawer, whose
// picks pop its history entry before they navigate, and the system back closes an open drawer or
// account sheet before it leaves the page.
import { act, cleanup, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathname as currentPath, resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/** A compact window (390 wide); `coarse` adds the touch query (the overlays' history entries). */
function phone(coarse: boolean) {
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
        width.every(([, k, n]) => (k === "min" ? 390 >= Number(n) : 390 <= Number(n)));
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
    await userEvent.click(within(panel).getByRole("button", { name: "技能、连接器、设备…" }));
    const level = document.querySelector('[data-part="drawer-level"]') as HTMLElement;
    expect(
      within(level)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/skills", "/connectors", "/devices"]);
  });

  it("the account row opens the account sheet: 个人设置, appearance, status, sign out", async () => {
    renderFrame(shellOf(ME, pending));
    await userEvent.click(menuButton() as HTMLElement);
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: /Grant/ }));
    const sheet = document.querySelector('[data-part="account-sheet"]') as HTMLElement;
    expect(within(sheet).getByRole("link", { name: "个人设置" }).getAttribute("href")).toBe(
      "/account/profile",
    );
    expect(within(sheet).getByText("Acme")).toBeTruthy();
    expect(within(sheet).getByText(/grant@acme:~/)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "退出登录" })).toBeTruthy();
    // a browser has no native profile switcher
    expect(within(sheet).queryByRole("button", { name: "切换平台" })).toBeNull();
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
