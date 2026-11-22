import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Input,
  ListPage,
  type ListScope,
  ObjectCard,
  type ObjectCardProps,
  type PageHeaderProps,
  Segmented,
} from "../src/index";
import { type ShellPage, ShellPageContext } from "../src/shell/shell-page";
import { css, parseCss } from "./css-rules";
import { renderAtClass } from "./width";

// ListPage on compact (responsive system spec §0, §2.1, §2.2, §2.5, §2.6, §3.1, §5.4; design spec
// §5.1, §6.62, §6.63, §6.65): below 600 the template is the one scroller; the search, the head
// tabs (segmented for 2–3) and the scope chips are one quick-return bar, a direct child of the
// scroller; the head's primary is the FAB (none while the empty state carries it); field filters
// sit in the Filter bottom sheet. From 600 the head keeps its tab row with the search and the
// scope is a Segmented in the filters row.

const real = window.matchMedia;
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.matchMedia = real;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function flushFrames() {
  const due = frames;
  frames = [];
  act(() => {
    for (const cb of due) cb(0);
  });
}

const card = (title: string, i: number): ObjectCardProps => ({
  avatar: { kind: "preset", id: "capybara" },
  title,
  href: `/agents/${i}`,
  description: "帮你检索资料、整理笔记。",
  meta: ["grant", "仅自己"],
  primary: { label: "开始会话", onSelect: () => {} },
  menu: [
    { label: "设置", href: `/agents/${i}/settings` },
    { label: "运行记录", href: `/agents/${i}/runs` },
  ],
});

const header = (over: Partial<PageHeaderProps> = {}): PageHeaderProps => ({
  path: [{ label: "acme", href: "/" }, { label: "agents" }],
  title: "智能体",
  description: "组织里的智能体",
  actions: [
    { label: "导入", variant: "default", onSelect: () => {} },
    { label: "新建智能体", variant: "primary", icon: "plus", href: "/agents/new" },
  ],
  tabs: [
    { id: "agents", label: "智能体", count: 3 },
    { id: "templates", label: "模板", count: 0 },
  ],
  activeTab: "agents",
  search: { label: "搜索智能体", value: "", onChange: () => {} },
  ...over,
});

const scope: ListScope = {
  label: "范围",
  value: "all",
  options: [
    { value: "all", label: "全部" },
    { value: "mine", label: "我的" },
    { value: "shared", label: "组织共享" },
  ],
  onChange: () => {},
};

const NAMES = ["研究助手", "周报助手", "客服助手"];

function agents(over: Partial<Parameters<typeof ListPage>[0]> = {}): ReactElement {
  return (
    <ListPage header={header()} variant="cards" listLabel="智能体" scope={scope} {...over}>
      {NAMES.map((n, i) => (
        <ObjectCard key={n} {...card(n, i)} />
      ))}
    </ListPage>
  );
}

const root = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-template="ListPage"]');
const bar = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-part="list-compact-bar"]');

/** A stand-in shell keeping the last `titleAway` each registration reported. */
function shellStub() {
  const pages = new Map<symbol, ShellPage>();
  const register = vi.fn((id: symbol, page: ShellPage | null) => {
    if (page === null) pages.delete(id);
    else pages.set(id, { ...pages.get(id), ...page });
  });
  const titleAway = () => [...pages.values()].some((p) => p.titleAway === true);
  return { register, titleAway };
}

/**
 * Makes the template's root the scroller under test: 600 high with `content` px of content, the
 * title's bottom 120 below its top; the rectangles follow `scrollTop`. Returns a person's scroll.
 */
function rig(container: HTMLElement, content = 2000) {
  const scroller = root(container);
  const title = container.querySelector<HTMLElement>(".cb-pageheader-titleline");
  if (!scroller || !title) throw new Error("no scroller or title");
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 600 });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
  title.getBoundingClientRect = () => ({ top: 80 - top, bottom: 120 - top }) as DOMRect;
  return (v: number) => {
    scroller.dispatchEvent(new Event("wheel"));
    top = v;
    scroller.dispatchEvent(new Event("scroll"));
    flushFrames();
  };
}

/** Dispatches a cancelable context-menu event and reports whether something prevented it. */
const contextMenu = (el: Element) => {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  act(() => {
    el.dispatchEvent(e);
  });
  return e.defaultPrevented;
};

describe("ListPage at 390", () => {
  it("at 390 no path, FAB with 新建智能体, segmented tabs, scope chips, rows without buttons", () => {
    const { container } = renderAtClass(390, agents());
    expect(container.querySelector('[data-part="path"]')).toBeNull();
    // the count beside the large title is the first tab's (D10)
    expect(container.querySelector(".cb-pageheader-titleline")?.textContent).toBe("智能体3");
    // the FAB: the head's primary, marked for the data-fab CSS, named by its label
    expect(root(container)?.getAttribute("data-fab")).toBe("true");
    const fab = screen.getByRole("link", { name: "新建智能体" });
    expect(fab.closest('[data-head-primary="true"]')?.getAttribute("data-form")).toBe("fab");
    // the bar: search, the segmented tabs, the scope chips
    const b = bar(container) as HTMLElement;
    expect(b).not.toBeNull();
    expect(within(b).getByRole("searchbox", { name: "搜索智能体" })).toBeTruthy();
    const tabs = within(b).getByRole("tablist");
    expect(tabs.getAttribute("data-look")).toBe("segmented-compact");
    expect(within(b).getByRole("radiogroup", { name: "范围" }).className).toContain(
      "cb-scope-chips",
    );
    // the head holds no tab row of its own any more
    expect(container.querySelector('[data-part="page-header-tabs"]')).toBeNull();
    // the rows carry no buttons
    const list = screen.getByRole("list", { name: "智能体" });
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
  });

  it("the bar is a direct child of the scroller (only box-less wrappers between)", () => {
    const { container } = renderAtClass(390, agents());
    const r = root(container) as HTMLElement;
    let el = (bar(container) as HTMLElement).parentElement;
    while (el && el !== r) {
      expect(
        el.classList.contains("cb-skeleton-group") || el.classList.contains("cb-class-form"),
      ).toBe(true);
      el = el.parentElement;
    }
    expect(el).toBe(r);
    expect(r.getAttribute("data-scroll")).toBe("one");
  });

  it("contextmenu on a row opens the card's actions", () => {
    renderAtClass(390, agents());
    const row = screen
      .getByRole("link", { name: "周报助手" })
      .closest('[data-part="object-card"]') as HTMLElement;
    expect(contextMenu(row)).toBe(true);
    const sheet = document.querySelector<HTMLElement>('[data-part="action-sheet"]') as HTMLElement;
    expect(within(sheet).getByRole("heading").textContent).toBe("周报助手");
    expect(
      [...document.querySelectorAll('[data-part="action-sheet-item"]')].map((e) =>
        e.textContent?.trim(),
      ),
    ).toEqual(["开始会话", "设置", "运行记录"]);
  });

  it("empty state with primary means no FAB", () => {
    const action = { label: "新建智能体", variant: "primary" as const, href: "/agents/new" };
    const { container } = renderAtClass(390, agents({ empty: { text: "还没有智能体", action } }));
    expect(root(container)?.getAttribute("data-fab")).toBeNull();
    expect(container.querySelector('[data-head-primary="true"]')).toBeNull();
    expect(screen.getAllByRole("link", { name: "新建智能体" })).toHaveLength(1);
  });

  it.each([390, 768, 1440])("one search input after hydration (%i)", (width) => {
    renderAtClass(width, agents());
    expect(screen.getAllByRole("searchbox", { name: "搜索智能体" })).toHaveLength(1);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getAllByRole("radiogroup", { name: "范围" })).toHaveLength(1);
  });

  it("the server render carries both forms; the compact CSS hides the head's tab row", () => {
    const { container } = renderAtClass(390, agents());
    const r = root(container) as HTMLElement;
    expect(r.getAttribute("data-compact-bar")).toBe("true");
    const rules = parseCss(css("list-page.css"));
    const hide = rules.find(
      (x) =>
        x.at === "not all and (min-width: 600px)" &&
        x.selector.includes('.cb-template[data-compact-bar="true"]') &&
        x.selector.includes('[data-part="page-header-tabs"]'),
    );
    expect(hide?.decls.display).toBe("none");
  });

  it("field filters sit in the Filter sheet at 390", () => {
    const { container } = renderAtClass(
      390,
      agents({
        scope: undefined as never,
        filters: <Input aria-label="所有者" value="" onChange={() => {}} />,
        filterCount: 2,
      }),
    );
    // not inline on the page
    expect(container.querySelector(".cb-list-filters")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "所有者" })).toBeNull();
    // the Filter button shows the active-filter count and opens the bottom sheet
    const button = screen.getByRole("button", { name: /筛选/ });
    expect(button.textContent).toBe("筛选2");
    fireEvent.click(button);
    const sheet = document.querySelector<HTMLElement>(".cb-bsheet") as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(within(sheet).getByRole("textbox", { name: "所有者" })).toBeTruthy();
  });

  it("at 768 the field filters stay inline and there is no Filter button", () => {
    const { container } = renderAtClass(
      768,
      agents({
        scope: undefined as never,
        filters: <Input aria-label="所有者" value="" onChange={() => {}} />,
      }),
    );
    expect(container.querySelector(".cb-list-filters")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "所有者" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /筛选/ })).toBeNull();
  });

  it("short list never hides the bar", () => {
    const { container } = renderAtClass(390, agents());
    const scrollTo = rig(container, 600);
    for (const v of [0, 10, 300, 500, 20, 400]) {
      scrollTo(v);
      expect(root(container)?.getAttribute("data-bar-hidden")).toBeNull();
    }
  });

  it("a long list hides the bar going down past the title and brings it back going up", () => {
    const { container } = renderAtClass(390, agents());
    const scrollTo = rig(container);
    scrollTo(10);
    scrollTo(300);
    expect(root(container)?.getAttribute("data-bar-hidden")).toBe("true");
    scrollTo(280);
    expect(root(container)?.getAttribute("data-bar-hidden")).toBeNull();
  });

  it("the bar is sticky under the floating row and slides over motion.overlay", () => {
    const rules = parseCss(css("list-page.css"));
    const compact = (sel: string) =>
      rules.find((x) => x.at === "not all and (min-width: 600px)" && x.selector === sel)?.decls;
    const b = compact(".cb-list-compact-bar");
    expect(b?.position).toBe("sticky");
    expect(b?.top).toBe("var(--cb-float-row, 0px)");
    expect(b?.transition).toContain("var(--cb-motion-overlay)");
    expect(b?.flex).toBe("none");
    const hidden = compact('.cb-template[data-bar-hidden="true"] .cb-list-compact-bar');
    expect(hidden?.transform).toBe("translateY(calc(-100% - var(--cb-float-row, 0px)))");
    const reduced = rules.find(
      (x) => x.at === "(prefers-reduced-motion: reduce)" && x.selector === ".cb-list-compact-bar",
    );
    expect(reduced?.decls.transition).toBe("none");
  });

  it("loading keeps the compact bar with dashes", () => {
    const { container } = renderAtClass(390, agents({ loading: { rows: 3 } }));
    const b = bar(container) as HTMLElement;
    expect(within(b).getByRole("searchbox", { name: "搜索智能体" })).toBeTruthy();
    expect(within(b).getByRole("radiogroup", { name: "范围" })).toBeTruthy();
    const counts = [...b.querySelectorAll(".cb-tab-count")].map((e) => e.textContent);
    expect(counts).toEqual(["–", "–"]);
  });
});

describe("ListPage at 768 and 1440", () => {
  it.each([768, 1440])("at %i the head keeps its primary, tabs and Segmented scope", (width) => {
    const { container } = renderAtClass(width, agents());
    expect(bar(container)).toBeNull();
    const head = container.querySelector('[data-part="page-header"]') as HTMLElement;
    expect(within(head).getByRole("link", { name: "新建智能体" })).toBeTruthy();
    expect(within(head).getByRole("button", { name: "导入" })).toBeTruthy();
    expect(within(head).getByRole("tablist")).toBeTruthy();
    expect(within(head).getByRole("searchbox", { name: "搜索智能体" })).toBeTruthy();
    const seg = screen.getByRole("radiogroup", { name: "范围" });
    expect(seg.className).toContain("cb-segmented");
    expect(seg.closest(".cb-list-filters")).not.toBeNull();
  });

  it("a scope of more than five options stays chips on wide", () => {
    const many: ListScope = {
      ...scope,
      options: ["a", "b", "c", "d", "e", "f"].map((v) => ({ value: v, label: v })),
      value: "a",
    };
    renderAtClass(1440, agents({ scope: many }));
    expect(screen.getByRole("radiogroup", { name: "范围" }).className).toContain("cb-scope-chips");
  });
});

describe("a wide scope with avatars", () => {
  it("stays chips: a Segmented draws no avatar", () => {
    const withAvatars: ListScope = {
      ...scope,
      options: [
        { value: "all", label: "全部" },
        { value: "a", label: "研究助手", avatar: null },
      ],
    };
    renderAtClass(1440, agents({ scope: withAvatars }));
    expect(screen.getByRole("radiogroup", { name: "范围" }).className).toContain("cb-scope-chips");
  });
});

describe("scope and filters", () => {
  it("scope and a Segmented passed through filters are not both given (development)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seg = (
      <Segmented label="x" value="a" options={[{ value: "a", label: "A" }]} onChange={() => {}} />
    );
    expect(() => renderAtClass(1440, agents({ filters: <div>{seg}</div> }))).toThrow(
      /scope.*Segmented/,
    );
  });
});

describe("scroll restoration", () => {
  it("back from a detail to a scrolled list: scroll position and the scrolled title together", () => {
    const shell = shellStub();
    const ui = (
      <ShellPageContext.Provider value={shell.register}>{agents()}</ShellPageContext.Provider>
    );
    const first = renderAtClass(390, ui);
    const scrollTo = rig(first.container);
    scrollTo(10);
    scrollTo(400);
    expect(shell.titleAway()).toBe(true);
    // leave for the detail page (the list unmounts), then come back with the browser's back
    first.unmount();
    document.body.innerHTML = "";
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    // the scroller's geometry exists before the list mounts, as a laid-out page's does
    let top = 0;
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("cb-pageheader-titleline"))
        return { top: 80 - top, bottom: 120 - top } as DOMRect;
      return { top: 0, bottom: 600 } as DOMRect;
    };
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 600,
    });
    try {
      const back = shellStub();
      const second = renderAtClass(
        390,
        <ShellPageContext.Provider value={back.register}>{agents()}</ShellPageContext.Provider>,
      );
      // restored before the frame's first read: no frame had to run for the title to be away
      expect(root(second.container)?.scrollTop).toBe(400);
      expect(back.titleAway()).toBe(true);
      // and the bar starts shown
      expect(root(second.container)?.getAttribute("data-bar-hidden")).toBeNull();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
      delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      if (scrollTop) Object.defineProperty(Element.prototype, "scrollTop", scrollTop);
    }
  });

  it("a fresh visit to the same list starts at the top", () => {
    const first = renderAtClass(390, agents());
    const scrollTo = rig(first.container);
    scrollTo(10);
    scrollTo(400);
    first.unmount();
    document.body.innerHTML = "";
    const second = renderAtClass(390, agents());
    expect(root(second.container)?.scrollTop).toBe(0);
  });
});
