import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOP_BAR_FIXTURE } from "../src/fixtures/index";
import {
  AppShell,
  backTarget,
  DesignProvider,
  PageHeader,
  TopBar,
  withViewTransition,
} from "../src/index";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

describe("backTarget", () => {
  it("back without history goes up the path: the last linked segment", () => {
    expect(backTarget([{ href: "/agents" }, {}], false)).toBe("/agents");
    expect(
      backTarget([{ href: "/" }, { href: "/agents" }, { label: "x" } as { href?: string }], false),
    ).toBe("/agents");
  });

  it("back with an in-app history entry is the history", () => {
    expect(backTarget([{ href: "/agents" }, {}], true)).toBe("history");
  });

  it("the last segment is the page itself, even when it carries a link", () => {
    expect(backTarget([{ href: "/admin" }], false)).toBe("/");
    expect(backTarget([{ href: "/" }, { href: "/admin" }], false)).toBe("/");
  });

  it("a path with no link goes home", () => {
    expect(backTarget([{}], false)).toBe("/");
    expect(backTarget([], false)).toBe("/");
  });
});

describe("TopBar", () => {
  const menu = TOP_BAR_FIXTURE.overflow.map((m) => ({
    kind: "item" as const,
    id: m.id,
    label: m.label,
    onSelect: vi.fn(),
    ...(m.danger ? { tone: "fail" as const } : {}),
  }));

  it("a tab root has the title, search and no back", () => {
    zh(<TopBar title="会话" onSearch={() => {}} />);
    const bar = document.querySelector('[data-part="top-bar"]') as HTMLElement;
    expect(bar.getAttribute("data-pushed")).toBe("false");
    expect(bar.querySelector('[data-part="title"]')?.textContent).toBe("会话");
    expect(within(bar).getByRole("button", { name: "搜索" })).toBeTruthy();
    expect(within(bar).queryByRole("link", { name: "返回" })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "返回" })).toBeNull();
  });

  it("the title is not a second heading", () => {
    zh(<TopBar title="会话" />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("a pushed page with a path target shows a back link to it", () => {
    zh(<TopBar title="检索" back="/conversations" />);
    const back = screen.getByRole("link", { name: "返回" });
    expect(back.getAttribute("href")).toBe("/conversations");
    expect(back.querySelector('[data-icon="chevron-left"]')).not.toBeNull();
  });

  it("back through history goes back one entry", async () => {
    const spy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    zh(<TopBar title="检索" back="history" />);
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("draws the overflow button only when the page has menu entries, and opens the menu", async () => {
    zh(<TopBar title="会话" />);
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
    cleanup();
    zh(<TopBar title="检索" back="/conversations" menu={menu} />);
    const more = screen.getByRole("button", { name: "更多操作" });
    await userEvent.click(more);
    const list = await screen.findByRole("menu");
    expect(
      within(list)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["属性", "智能体地图", "重命名", "复制链接", "删除"]);
  });

  it("the open overflow button is pressed", () => {
    zh(<TopBar title="检索" back="/c" menu={menu} menuOpen />);
    expect(screen.getByRole("button", { name: "更多操作" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});

describe("the top bar in the shell", () => {
  const sidebar = {
    context: {
      kind: "work" as const,
      org: null,
      primary: [],
      more: [],
    },
    activeNav: "",
    account: { name: "grant", menu: [] },
  };
  const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };

  it("shows the page's name (the PageHeader's h1) and goes up the page's path", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    zh(
      <AppShell
        sidebar={sidebar}
        status={status}
        commands={[]}
        bottomNav={[
          { id: "chats", label: "会话", href: "/conversations", icon: "chats" },
          { id: "agents", label: "智能体", href: "/agents", icon: "agent" },
          { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox" },
          { id: "me", label: "我", href: "/me", icon: "user" },
        ]}
        pathname="/agents/new"
      >
        <PageHeader
          path={[
            { label: "demo", href: "/" },
            { label: "智能体", href: "/agents" },
            { label: "新建" },
          ]}
          title="新建智能体"
        />
      </AppShell>,
    );
    const bar = document.querySelector('[data-part="top-bar"]') as HTMLElement;
    expect(bar.querySelector('[data-part="title"]')?.textContent).toBe("新建智能体");
    expect(within(bar).getByRole("link", { name: "返回" }).getAttribute("href")).toBe("/agents");
    // the PageHeader's h1 is the page's heading
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("withViewTransition", () => {
  const doc = document as unknown as { startViewTransition?: unknown };
  afterEach(() => {
    delete doc.startViewTransition;
    delete document.documentElement.dataset.cbTransition;
  });

  it("runs the update at once without view transitions (an instant swap)", () => {
    const update = vi.fn();
    withViewTransition(update, "push");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("runs the update inside a view transition where there is one, naming the direction meanwhile", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const finished = Promise.resolve();
    let seen: string | undefined;
    doc.startViewTransition = vi.fn((cb: () => unknown) => {
      seen = document.documentElement.dataset.cbTransition;
      void cb();
      return { finished };
    });
    const update = vi.fn();
    withViewTransition(update, "pop");
    expect(seen).toBe("pop");
    expect(update).toHaveBeenCalledTimes(1);
    await finished;
    await Promise.resolve();
    expect(document.documentElement.dataset.cbTransition).toBeUndefined();
  });

  it("does nothing animated under prefers-reduced-motion", () => {
    window.matchMedia = ((q: string) => ({
      matches: q === "(prefers-reduced-motion: reduce)",
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const start = vi.fn();
    doc.startViewTransition = start;
    const update = vi.fn();
    withViewTransition(update, "push");
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("push and pop in the shell", () => {
  const sidebar = {
    context: { kind: "work" as const, org: null, primary: [], more: [] },
    activeNav: "",
    account: { name: "grant", menu: [] },
  };
  const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };
  const nav = [
    { id: "chats" as const, label: "会话", href: "/conversations", icon: "chats" as const },
    { id: "agents" as const, label: "智能体", href: "/agents", icon: "agent" as const },
    { id: "inbox" as const, label: "收件箱", href: "/inbox", icon: "inbox" as const },
    { id: "me" as const, label: "我", href: "/me", icon: "user" as const },
  ];
  const shell = (pathname: string) => (
    <DesignProvider locale="zh">
      <AppShell sidebar={sidebar} status={status} bottomNav={nav} pathname={pathname}>
        <div>内容</div>
      </AppShell>
    </DesignProvider>
  );
  const main = () => document.querySelector("main") as HTMLElement;

  it("a push slides in, a pop slides back, a move between tab roots does not slide", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { rerender } = render(shell("/agents"));
    expect(main().getAttribute("data-nav")).toBeNull();
    rerender(shell("/agents/new"));
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
    // once the shell has seen a navigation, back goes through the history
    expect(
      document.querySelector('[data-part="top-bar"] button[aria-label="返回"]'),
    ).not.toBeNull();
    rerender(shell("/agents"));
    expect(main().getAttribute("data-nav")).toMatch(/^pop-/);
    rerender(shell("/inbox"));
    expect(main().getAttribute("data-nav")).toBeNull();
  });

  it("two pushes in a row restart the animation (the name alternates)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { rerender } = render(shell("/agents"));
    rerender(shell("/agents/new"));
    const first = main().getAttribute("data-nav");
    rerender(shell("/agents/new/step"));
    expect(main().getAttribute("data-nav")).not.toBe(first);
    expect(main().getAttribute("data-nav")).toMatch(/^push-/);
  });
});
