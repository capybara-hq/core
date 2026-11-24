import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  Input,
  ListPage,
  type ListScope,
  ObjectCard,
  type ObjectCardProps,
  type PageHeaderProps,
  Segmented,
  Tabs,
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

/** A scope of `n` options: the all-sources option (value "all") then s1..s(n-1), "all" chosen. */
function scopeWith(n: number): ListScope {
  return {
    ...scope,
    options: [
      { value: "all", label: "全部来源" },
      ...Array.from({ length: n - 1 }, (_, i) => ({ value: `s${i + 1}`, label: `s${i + 1}` })),
    ],
  };
}

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

  it("more than 5 options without avatars: one select in the bar, no chip strip", () => {
    const { container } = renderAtClass(390, agents({ scope: scopeWith(30) }));
    const b = bar(container) as HTMLElement;
    expect(within(b).getAllByRole("combobox")).toHaveLength(1);
    expect(within(b).getByRole("combobox", { name: "范围" }).textContent).toContain("全部来源");
    expect(within(b).queryByRole("radiogroup", { name: "范围" })).toBeNull();
    expect(container.querySelector(".cb-scope-chips")).toBeNull();
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
    const button = screen.getByRole("button", { name: /^筛选\s*已启用 2 项$/ });
    // the count is drawn as the bare number; its words are for assistive tech only
    expect(
      button.querySelector('[data-part="filter-count"] [aria-hidden="true"]')?.textContent,
    ).toBe("2");
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

  it("a slightly longer list (700 of content): no jitter, the bar never hides", () => {
    const { container } = renderAtClass(390, agents());
    const scrollTo = rig(container, 700);
    for (const v of [0, 40, 100, 60, 100, 0, 100]) {
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
    // 0: the offset counts from the scroller's padding edge, already the row's bottom (#642)
    expect(b?.top).toBe("0");
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

  it("more than 5 options without avatars render one select, not a tab row", () => {
    renderAtClass(1440, agents({ scope: scopeWith(30) }));
    expect(screen.queryByRole("tablist", { name: "范围" })).toBeNull();
    const box = screen.getByRole("combobox", { name: "范围" });
    expect(box.textContent).toContain("全部来源");
    expect(box.closest('[data-part="list-scope"]')).not.toBeNull();
  });

  it.each([768, 1440])("at %i the scope and the field filters share one row", (width) => {
    renderAtClass(width, agents({ filters: <a href="/sources">市场源</a> }));
    const row = screen
      .getByRole("radiogroup", { name: "范围" })
      .closest('[data-part="list-scope"]');
    expect(row?.getAttribute("data-filters")).toBe("true");
    expect(within(row as HTMLElement).getByRole("link", { name: "市场源" })).toBeTruthy();
    expect(document.querySelectorAll(".cb-list-filters")).toHaveLength(1);
  });

  it("5 options stay a segmented control", () => {
    renderAtClass(1440, agents({ scope: scopeWith(5) }));
    expect(screen.getByRole("radiogroup", { name: "范围" })).toBeTruthy();
  });

  it("choosing in the select calls onChange with the option value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderAtClass(1440, agents({ scope: { ...scopeWith(30), onChange } }));
    await user.click(screen.getByRole("combobox", { name: "范围" }));
    await user.click(await screen.findByRole("option", { name: "s7" }));
    expect(onChange).toHaveBeenCalledWith("s7");
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
      /scope.*Segmented or Tabs/,
    );
  });

  it("scope and a Tabs passed through filters are not both given (development)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tabs = <Tabs label="x" value="a" items={[{ id: "a", label: "A" }]} />;
    expect(() => renderAtClass(1440, agents({ filters: <div>{tabs}</div> }))).toThrow(
      /scope.*Segmented or Tabs/,
    );
  });
});

/**
 * The geometry of every element, as a laid-out page has it before the list mounts: the scroller
 * is 600 high with `content` px of content, the title's bottom 120 below its top, rectangles
 * follow the one `scrollTop`. `restore()` puts jsdom's prototypes back.
 */
function geometry(content = 2000) {
  const g = { top: 0, content };
  const proto = HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get: () => g.top,
    set: (v: number) => {
      g.top = Math.min(Math.max(v, 0), Math.max(g.content - 600, 0));
    },
  });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => g.content });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 600 });
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("cb-pageheader-titleline"))
      return { top: 80 - g.top, bottom: 120 - g.top } as DOMRect;
    return { top: 0, bottom: 600 } as DOMRect;
  };
  return {
    g,
    /** A person's scroll of the list's scroller. */
    scroll(container: HTMLElement, v: number) {
      const el = root(container) as HTMLElement;
      el.dispatchEvent(new Event("wheel"));
      g.top = v;
      el.dispatchEvent(new Event("scroll"));
      flushFrames();
    },
    restore() {
      proto.getBoundingClientRect = rect;
      delete (proto as { scrollTop?: number }).scrollTop;
      delete (proto as { scrollHeight?: number }).scrollHeight;
      delete (proto as { clientHeight?: number }).clientHeight;
    },
  };
}

const inShell = (register: ReturnType<typeof shellStub>["register"], ui: ReactElement) => (
  <ShellPageContext.Provider value={register}>{ui}</ShellPageContext.Provider>
);

/** Leaves the list: it unmounts as a pushed detail page replaces it. */
function leave(view: { unmount(): void }) {
  view.unmount();
  document.body.innerHTML = "";
}

/** Re-renders a `renderAtClass` view with new props, inside the provider it was rendered in. */
const rerender = (view: { rerender(ui: ReactElement): void }, ui: ReactElement) =>
  view.rerender(<DesignProvider locale="zh">{ui}</DesignProvider>);

const popstate = () =>
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

describe("scroll restoration", () => {
  let geo: ReturnType<typeof geometry>;
  beforeEach(() => {
    window.history.replaceState(null, "", "/agents");
    geo = geometry();
  });
  afterEach(() => {
    geo.restore();
    window.history.replaceState(null, "", "/");
  });

  /** Scrolls a list at the current location to `v` and leaves it. */
  function scrolledAway(v: number) {
    const view = renderAtClass(390, agents());
    geo.scroll(view.container, 10);
    geo.scroll(view.container, v);
    leave(view);
    geo.g.top = 0;
  }

  it("back from a detail to a scrolled list: scroll position and the scrolled title together", () => {
    scrolledAway(400);
    popstate();
    const back = shellStub();
    const view = renderAtClass(390, inShell(back.register, agents()));
    // restored before the frame's first read: no frame had to run for the title to be away
    expect(root(view.container)?.scrollTop).toBe(400);
    expect(back.titleAway()).toBe(true);
    expect(root(view.container)?.getAttribute("data-bar-hidden")).toBeNull();
  });

  it("a router that renders the traversal eagerly, inside popstate, before the design listener", () => {
    scrolledAway(400);
    const back = shellStub();
    let view: ReturnType<typeof renderAtClass> | null = null;
    // a capture listener on window runs before the design's; stopping the event keeps the
    // design's listener from ever recording the traversal
    const router = (e: Event) => {
      e.stopImmediatePropagation();
      view = renderAtClass(390, inShell(back.register, agents()));
    };
    window.addEventListener("popstate", router, { capture: true });
    try {
      // not inside act: the router's render flushes inside the event, as React does eagerly
      window.dispatchEvent(new PopStateEvent("popstate"));
    } finally {
      window.removeEventListener("popstate", router, { capture: true });
    }
    expect(root((view as unknown as { container: HTMLElement }).container)?.scrollTop).toBe(400);
    expect(back.titleAway()).toBe(true);
  });

  it("a fresh visit to the same list starts at the top", () => {
    scrolledAway(400);
    const view = renderAtClass(390, agents());
    expect(root(view.container)?.scrollTop).toBe(0);
  });

  it("a traversal no list took never restores a later fresh visit", () => {
    scrolledAway(400);
    // back lands here, but no list mounts for it (another page renders), then a push to the list
    popstate();
    window.history.pushState(null, "", "/agents");
    const view = renderAtClass(390, agents());
    expect(root(view.container)?.scrollTop).toBe(0);
  });

  it("back / forward that changes only the query restores the kept list", () => {
    const view = renderAtClass(390, agents());
    geo.scroll(view.container, 10);
    geo.scroll(view.container, 400);
    // a tab pushed as a query: the same ListPage stays mounted
    window.history.pushState(null, "", "/agents?tab=templates");
    rerender(view, agents({ header: header({ activeTab: "templates" }) }));
    geo.scroll(view.container, 50);
    // back to the first tab
    window.history.replaceState(null, "", "/agents");
    popstate();
    rerender(view, agents({ header: header({ activeTab: "agents" }) }));
    expect(root(view.container)?.scrollTop).toBe(400);
  });

  it("content shorter than the owed position: nothing overwritten, restored once it grows", () => {
    scrolledAway(1200);
    geo.g.content = 700;
    popstate();
    const view = renderAtClass(390, agents({ loading: { rows: 3 } }));
    // the clamped position is not stored over the owed one
    root(view.container)?.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(sessionStorage.getItem("cb-list-scroll:/agents")).toBe("1200");
    geo.g.content = 2000;
    rerender(view, agents());
    expect(root(view.container)?.scrollTop).toBe(1200);
  });

  it("a person's gesture drops an owed position the list never reaches, without a jump", () => {
    scrolledAway(1200);
    geo.g.content = 700;
    popstate();
    const view = renderAtClass(390, agents());
    const el = root(view.container) as HTMLElement;
    // as far as there is: the list may still grow
    expect(el.scrollTop).toBe(100);
    for (const g of ["touchstart", "wheel", "pointerdown"]) {
      el.dispatchEvent(new Event(g));
      expect(el.scrollTop).toBe(100);
    }
    // from then on the position is the person's: stored, and never pulled to the old one
    geo.scroll(view.container, 50);
    expect(sessionStorage.getItem("cb-list-scroll:/agents")).toBe("50");
    geo.g.content = 2000;
    rerender(view, agents());
    expect(el.scrollTop).toBe(50);
  });

  it("a push to a new query drops what an earlier traversal still owed", () => {
    scrolledAway(1200);
    geo.g.content = 700;
    popstate();
    const view = renderAtClass(390, agents());
    const el = root(view.container) as HTMLElement;
    expect(el.scrollTop).toBe(100);
    // a tab pushed as a query (no traversal) while the old position was still owed
    window.history.pushState(null, "", "/agents?tab=templates");
    geo.g.content = 2000;
    rerender(view, agents({ header: header({ activeTab: "templates" }) }));
    // the new location owes nothing: no jump, and its scrolls are stored again
    expect(el.scrollTop).toBe(100);
    el.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(sessionStorage.getItem("cb-list-scroll:/agents?tab=templates")).toBe("100");
  });

  it("the old list re-rendering after a traversal away leaves the position to the next list", () => {
    sessionStorage.setItem("cb-list-scroll:/agents/a1", "300");
    const old = renderAtClass(390, agents());
    // back to a detail-side list at another path; the old list renders once more before it goes
    window.history.replaceState(null, "", "/agents/a1");
    popstate();
    rerender(old, agents({ header: header({ title: "智能体 " }) }));
    expect(root(old.container)?.scrollTop).toBe(0);
    leave(old);
    const next = renderAtClass(390, agents());
    expect(root(next.container)?.scrollTop).toBe(300);
  });

  it("a body that grows without a render finishes the restore (the body is watched)", () => {
    const observers: { cb: () => void; els: Element[] }[] = [];
    const real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      els: Element[] = [];
      constructor(cb: () => void) {
        observers.push({ cb, els: this.els });
      }
      observe(el: Element) {
        this.els.push(el);
      }
      unobserve(el: Element) {
        this.els.splice(this.els.indexOf(el), 1);
      }
      disconnect() {
        this.els.length = 0;
      }
    } as unknown as typeof ResizeObserver;
    try {
      scrolledAway(1200);
      geo.g.content = 700;
      popstate();
      const view = renderAtClass(390, agents());
      const body = view.container.querySelector(".cb-body");
      // other parts watch their own boxes; the restore watches the body
      const live = observers.filter((o) => o.els.some((e) => e.classList.contains("cb-body")));
      expect(live.map((o) => o.els)).toEqual([[body]]);
      geo.g.content = 2000;
      act(() => {
        for (const o of live) o.cb();
      });
      expect(root(view.container)?.scrollTop).toBe(1200);
    } finally {
      globalThis.ResizeObserver = real;
    }
  });

  it("keeps at most 50 stored locations", () => {
    const view = renderAtClass(390, agents());
    for (let i = 0; i < 55; i++) {
      window.history.replaceState(null, "", `/agents?page=${i}`);
      geo.scroll(view.container, 100 + i);
    }
    const keys = Object.keys(sessionStorage).filter((k) => k.startsWith("cb-list-scroll:"));
    expect(keys).toHaveLength(50);
    expect(sessionStorage.getItem("cb-list-scroll:/agents?page=0")).toBeNull();
    expect(sessionStorage.getItem("cb-list-scroll:/agents?page=54")).toBe("154");
  });
});
