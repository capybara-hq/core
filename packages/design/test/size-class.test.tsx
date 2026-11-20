import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  DesignProvider,
  INLINE_RIGHT_AREA_QUERY,
  SHORT_WINDOW_QUERY,
  SIZE_CLASS_QUERIES,
  type SidebarProps,
  sizeClassOf,
  useSizeClass,
} from "../src/index";
import { matchMediaFor } from "./width";

const real = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = real;
});

function Probe() {
  return <p data-testid="class">{String(useSizeClass())}</p>;
}

const sidebar: Omit<SidebarProps, "onOpenCommands"> = {
  context: {
    kind: "work",
    org: null,
    primary: [{ id: "agents", label: "Agents", href: "/agents", icon: "agent" }],
    more: [],
  },
  newConversation: { href: "/" },
  activeNav: "agents",
  conversations: {
    state: "ready",
    groups: [],
    moreGroups: false,
    onMoreGroups: () => {},
    onRetry: () => {},
    filter: { q: "", state: "all", onChange: () => {} },
    archived: { count: 0, open: false, onOpenChange: () => {} },
    onRename: async () => {},
    onArchive: async () => {},
    onDelete: async () => {},
  },
  account: { name: "Ada", menu: [] },
};

const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };

const shell = (extra: Partial<React.ComponentProps<typeof AppShell>> = {}) => (
  <DesignProvider locale="zh">
    <AppShell sidebar={sidebar} status={status} commands={[]} {...extra} />
  </DesignProvider>
);
const shellEl = (c: HTMLElement) => c.querySelector('[data-cap-part~="shell"]') as HTMLElement;

describe("size classes", () => {
  it("sizeClassOf: 599 compact, 600 and 840 medium, 841 expanded", () => {
    expect(sizeClassOf(0)).toBe("compact");
    expect(sizeClassOf(599)).toBe("compact");
    expect(sizeClassOf(600)).toBe("medium");
    expect(sizeClassOf(840)).toBe("medium");
    expect(sizeClassOf(841)).toBe("expanded");
    expect(sizeClassOf(2560)).toBe("expanded");
  });

  it("the queries are exactly the ones the spec names", () => {
    expect(SIZE_CLASS_QUERIES).toEqual({
      compact: "(max-width: 599px)",
      medium: "(min-width: 600px) and (max-width: 840px)",
      expanded: "(min-width: 841px)",
    });
    expect(INLINE_RIGHT_AREA_QUERY).toBe("(min-width: 1280px)");
    expect(SHORT_WINDOW_QUERY).toBe("(max-height: 479px)");
  });

  it("the queries agree with sizeClassOf at every edge", () => {
    for (const w of [320, 599, 600, 700, 840, 841, 1000, 1280, 1920]) {
      window.matchMedia = matchMediaFor(w).matchMedia;
      const matching = (
        Object.keys(SIZE_CLASS_QUERIES) as (keyof typeof SIZE_CLASS_QUERIES)[]
      ).filter((c) => window.matchMedia(SIZE_CLASS_QUERIES[c]).matches);
      expect(matching).toEqual([sizeClassOf(w)]);
    }
  });

  it("useSizeClass is null in a server render", () => {
    window.matchMedia = matchMediaFor(700).matchMedia;
    const html = renderToString(
      <DesignProvider locale="zh">
        <Probe />
      </DesignProvider>,
    );
    expect(html).toContain(">null<");
  });

  it("useSizeClass is the matching class after mount and follows the window live", () => {
    const win = matchMediaFor(700);
    window.matchMedia = win.matchMedia;
    render(
      <DesignProvider locale="zh">
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("class").textContent).toBe("medium");
    act(() => win.resize(500));
    expect(screen.getByTestId("class").textContent).toBe("compact");
    act(() => win.resize(1200));
    expect(screen.getByTestId("class").textContent).toBe("expanded");
  });

  it("useSizeClass is null where there is no matchMedia", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    render(
      <DesignProvider locale="zh">
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("class").textContent).toBe("null");
  });
});

describe("the shell follows the class", () => {
  it("the state tokens end with size= after hydration", () => {
    window.matchMedia = matchMediaFor(700).matchMedia;
    const { container } = render(shell({ capState: "run=idle theme=builtin" }));
    expect(shellEl(container).getAttribute("data-cap-state")).toBe(
      "run=idle theme=builtin sidebar=rail size=medium",
    );
  });

  it("the server render carries no size token (the window is unknown)", () => {
    window.matchMedia = matchMediaFor(700).matchMedia;
    const html = renderToString(shell({ capState: "run=idle" }));
    expect(html).toContain('data-cap-state="run=idle"');
    expect(html).not.toMatch(/data-cap-state="[^"]*size=/);
  });

  it("data-short follows the height query, whatever the width", () => {
    const win = stub(1000, 900);
    const { container } = render(shell());
    expect(shellEl(container).getAttribute("data-short")).toBeNull();
    act(() => win.resize(1000, 400));
    expect(shellEl(container).getAttribute("data-short")).toBe("true");
    act(() => win.resize(300, 479));
    expect(shellEl(container).getAttribute("data-short")).toBe("true");
    act(() => win.resize(300, 480));
    expect(shellEl(container).getAttribute("data-short")).toBeNull();
  });

  it("expanded: the full sidebar; collapsed it is the rail with an expand button", () => {
    window.matchMedia = matchMediaFor(1000).matchMedia;
    const { unmount } = render(shell());
    expect(document.querySelector('[data-part="sidebar"]')?.getAttribute("data-mode")).toBe("full");
    expect(screen.getByRole("button", { name: "收起侧栏" })).toBeTruthy();
    unmount();
    render(shell({ collapsed: true }));
    expect(document.querySelector('[data-part="sidebar"]')?.getAttribute("data-mode")).toBe("rail");
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeTruthy();
  });

  it("medium is the rail whatever the saved choice, with 会话 and no expand button", () => {
    window.matchMedia = matchMediaFor(700).matchMedia;
    render(shell({ collapsed: false }));
    expect(document.querySelector('[data-part="sidebar"]')?.getAttribute("data-mode")).toBe("rail");
    expect(screen.queryByRole("button", { name: "展开侧栏" })).toBeNull();
    expect(screen.getByRole("button", { name: "会话" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();
  });

  it("⌘\\ and Ctrl+\\ toggle the sidebar and report the new state", async () => {
    window.matchMedia = matchMediaFor(1000).matchMedia;
    const onCollapsedChange = vi.fn();
    render(shell({ collapsed: true, onCollapsedChange }));
    await userEvent.keyboard("{Meta>}\\{/Meta}");
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
    await userEvent.keyboard("{Control>}\\{/Control}");
    expect(onCollapsedChange).toHaveBeenCalledTimes(2);
  });

  it("uncontrolled, the shell keeps the choice itself and the shortcut toggles it", async () => {
    window.matchMedia = matchMediaFor(1000).matchMedia;
    render(shell());
    await userEvent.keyboard("{Meta>}\\{/Meta}");
    expect(document.querySelector('[data-part="sidebar"]')?.getAttribute("data-mode")).toBe("rail");
    await userEvent.keyboard("{Meta>}\\{/Meta}");
    expect(document.querySelector('[data-part="sidebar"]')?.getAttribute("data-mode")).toBe("full");
  });

  it("the shortcut does nothing where the sidebar cannot be collapsed (medium)", async () => {
    window.matchMedia = matchMediaFor(700).matchMedia;
    const onCollapsedChange = vi.fn();
    render(shell({ onCollapsedChange }));
    await userEvent.keyboard("{Meta>}\\{/Meta}");
    expect(onCollapsedChange).not.toHaveBeenCalled();
  });
});

describe("the stylesheets use the class widths only", () => {
  const styles = resolve(import.meta.dirname, "../src/styles");
  it("sidebar.css draws the first paint by the classes and the cookie's collapsed flag", () => {
    const css = readFileSync(resolve(styles, "sidebar.css"), "utf8");
    expect(css).toMatch(
      /@media \(max-width: 840px\) \{[^@]*\.cb-sidebar\[data-responsive="true"\]\[data-mode="full"\] \{\s*display: none;/,
    );
    expect(css).toMatch(
      /@media \(min-width: 841px\) \{[^@]*\[data-mode="full"\]\[data-collapsed="true"\]/,
    );
    expect(css).not.toMatch(/959px|960px/);
  });
});

function stub(width: number, height: number) {
  const win = matchMediaFor(width, height);
  window.matchMedia = win.matchMedia;
  return win;
}
