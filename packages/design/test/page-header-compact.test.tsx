import { cleanup, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPACT_QUERY,
  DesignProvider,
  type HeaderAction,
  PageHeader,
  type PageHeaderProps,
  SIZE_CLASS_QUERIES,
  sizeClassOf,
} from "../src/index";
import { type ShellPage, ShellPageContext } from "../src/shell/shell-page";
import { css, parseCss } from "./css-rules";
import { matchMediaFor, renderAtClass } from "./width";

// The compact page head (responsive system spec §2.1, §3.1–3.5 head rows, §5.4; design spec §4.2
// "Compact head"): below 600 no path row, the count beside the large title (header.count, else the
// first tab's count, D10), the secondary actions in the shell's "…" (D1, also one), the primary per
// template (`primaryForm`: the head button, the ListPage's FAB restyle, a full-width block, D2),
// the tabs segmented. Medium and expanded keep the expanded head (D9).

const real = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = real;
});

const path = [{ label: "capybara", href: "/" }, { label: "智能体" }];
const ACTIONS: HeaderAction[] = [
  { label: "导入", variant: "default", onSelect: () => {} },
  { label: "新建", variant: "primary", onSelect: () => {} },
];
const TABS: NonNullable<PageHeaderProps["tabs"]> = [
  { id: "all", label: "全部", count: 6 },
  { id: "mine", label: "我的", count: 3 },
];

const head = (over: Partial<PageHeaderProps> = {}) => (
  <PageHeader path={path} title="智能体" actions={ACTIONS} {...over} />
);

/** A stand-in shell that keeps what the page registered last. */
function shellStub() {
  const pages = new Map<symbol, ShellPage>();
  const register = vi.fn((id: symbol, page: ShellPage | null) => {
    if (page === null) pages.delete(id);
    else pages.set(id, { ...pages.get(id), ...page });
  });
  const actions = () => [...pages.values()].flatMap((p) => p.actions ?? []);
  return { register, actions };
}

const count = (c: HTMLElement) =>
  [...c.querySelectorAll(".cb-pageheader-count")].map((e) => e.textContent);

describe("PageHeader compact form", () => {
  it("no path at 390", () => {
    const { container } = renderAtClass(390, head());
    expect(container.querySelector('[data-part="path"]')).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "智能体" })).toBeTruthy();
  });

  it("count falls back to the first tab's count at 390", () => {
    const { container } = renderAtClass(390, head({ tabs: TABS, activeTab: "mine" }));
    expect(count(container)).toEqual(["6"]);
  });

  it("header.count wins", () => {
    const { container } = renderAtClass(390, head({ tabs: TABS, count: 12 }));
    expect(count(container)).toEqual(["12"]);
  });

  it("secondary actions go to the shell overflow at 390", () => {
    const shell = shellStub();
    renderAtClass(
      390,
      <ShellPageContext.Provider value={shell.register}>{head()}</ShellPageContext.Provider>,
    );
    // D1: one secondary goes too; the head draws neither it nor a ⋯ of its own
    expect(shell.actions().map((a) => (a === "separator" ? a : a.label))).toEqual(["导入"]);
    const header = screen.getByRole("banner");
    expect(within(header).queryByRole("button", { name: "导入" })).toBeNull();
    expect(within(header).queryByRole("button", { name: "更多操作" })).toBeNull();
    expect(within(header).getAllByRole("button", { name: "新建" })).toHaveLength(1);
  });

  it("the shell's overflow item runs the page's latest handler", () => {
    const shell = shellStub();
    const first = vi.fn();
    const second = vi.fn();
    const at = (onSelect: () => void) => (
      <ShellPageContext.Provider value={shell.register}>
        {head({ actions: [{ label: "导入", variant: "default", onSelect }] })}
      </ShellPageContext.Provider>
    );
    const r = renderAtClass(390, at(first));
    r.rerender(<DesignProvider locale="zh">{at(second)}</DesignProvider>);
    const item = shell.actions()[0];
    if (item === undefined || item === "separator" || !item.onSelect) throw new Error("no item");
    item.onSelect();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("without a shell the secondaries fold into the head's ⋯, also one (D1)", () => {
    renderAtClass(390, head());
    const header = screen.getByRole("banner");
    expect(within(header).queryByRole("button", { name: "导入" })).toBeNull();
    expect(within(header).getByRole("button", { name: "更多操作" })).toBeTruthy();
  });

  it("block primary is full width under the title", () => {
    const { container } = renderAtClass(390, head({ primaryForm: "block" }));
    const block = container.querySelector('[data-form="block"]') as HTMLElement;
    expect(block).not.toBeNull();
    expect(within(block).getByRole("button", { name: "新建" })).toBeTruthy();
    const h1 = screen.getByRole("heading", { level: 1 });
    // after the title in document order
    expect(h1.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rules = parseCss(css("shell.css")).filter(
      (r) => r.at === COMPACT_QUERY && r.selector.includes('[data-form="block"]'),
    );
    // it takes the whole actions line (which is the full width under the title on compact)
    expect(rules.some((r) => r.decls.flex === "1 1 0")).toBe(true);
    const line = parseCss(css("shell.css")).find(
      (r) => r.at === COMPACT_QUERY && r.selector === ".cb-pageheader-actions",
    );
    expect(line?.decls.flex).toBe("1 1 100%");
  });

  it("fab form keeps the one head primary, marked for the FAB restyle, at 390", () => {
    // the primary stays the one head element the ListPage's `data-fab` CSS restyles (§6.62)
    const { container } = renderAtClass(390, head({ primaryForm: "fab" }));
    const buttons = screen.getAllByRole("button", { name: "新建" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.closest('[data-head-primary="true"]')?.getAttribute("data-form")).toBe(
      "fab",
    );
    expect(container.querySelector('[data-form="block"]')).toBeNull();
  });

  it.each([
    ["in a shell, head form: one slot for the primary", true, "head", 1],
    ["in a shell, fab form: none (the FAB is out of flow)", true, "fab", 0],
    ["outside a shell, head form: the ⋯ and the primary", false, "head", 2],
    ["outside a shell, fab form: the ⋯ only", false, "fab", 1],
  ] as const)("loading placeholders at 390 follow the loaded line: %s", (_n, inShell, form, n) => {
    const shell = shellStub();
    const ui = head({ actions: [], primaryForm: form, loading: { actions: 2 } });
    const { container } = renderAtClass(
      390,
      inShell ? (
        <ShellPageContext.Provider value={shell.register}>{ui}</ShellPageContext.Provider>
      ) : (
        ui
      ),
    );
    const slots = container.querySelector('[data-part="page-header-action-slots"]');
    expect(slots?.querySelectorAll('[data-part="skeleton-box"], .cb-skeleton-box')).toHaveLength(n);
    // an empty slot line takes no room, as an empty loaded line (one compact rule)
    const rule = parseCss(css("shell.css")).find(
      (r) =>
        r.at === COMPACT_QUERY && r.selector.includes('[data-part="page-header-action-slots"]'),
    );
    expect(rule?.decls.display).toBe("contents");
  });

  it("loading placeholders are unchanged at 1440", () => {
    const { container } = renderAtClass(
      1440,
      head({ actions: [], primaryForm: "fab", loading: { actions: 2 } }),
    );
    const slots = container.querySelector('[data-part="page-header-action-slots"]');
    expect(slots?.querySelectorAll(".cb-skeleton-box")).toHaveLength(2);
  });

  it("tabs are the segmented-compact look (2-3 tabs)", () => {
    renderAtClass(390, head({ tabs: TABS }));
    expect(screen.getByRole("tablist").getAttribute("data-look")).toBe("segmented-compact");
  });

  it.each([768, 1440])("%i unchanged", (width) => {
    const shell = shellStub();
    const { container } = renderAtClass(
      width,
      <ShellPageContext.Provider value={shell.register}>
        {head({ tabs: TABS, primaryForm: "block" })}
      </ShellPageContext.Provider>,
    );
    expect(container.querySelector('[data-part="path"]')).not.toBeNull();
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("button", { name: "导入" })).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "更多操作" })).toBeNull();
    // no count beside the title from the tabs: the tabs carry it
    expect(count(container)).toEqual([]);
    // the primary is the rightmost head action
    const actions = container.querySelector('[data-part="page-header-actions"]') as HTMLElement;
    expect(actions.lastElementChild?.textContent).toBe("新建");
  });

  it("the server render draws both forms; the width shows one", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const html = renderToString(
      <DesignProvider locale="zh">{head({ tabs: TABS })}</DesignProvider>,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    // the path is drawn once and the compact stylesheet hides it until hydration drops it
    expect(doc.querySelectorAll('[data-part="path"]')).toHaveLength(1);
    const hide = parseCss(css("shell.css")).find(
      (r) => r.selector === ".cb-pageheader-path" && r.decls.display === "none",
    );
    expect(hide?.at).toBe(COMPACT_QUERY);
    // the secondaries are drawn in both forms, inside the ClassForms copies
    const actions = doc.querySelector('[data-part="page-header-actions"]') as Element;
    expect(actions.querySelector('[data-class-form="wide"]')?.textContent).toBe("导入");
    expect(
      actions.querySelector('[data-class-form="compact"] [aria-label="更多操作"]'),
    ).not.toBeNull();
    // the primary is one element, outside both copies
    expect(doc.querySelectorAll('[data-head-primary="true"]')).toHaveLength(1);
    expect(doc.querySelector('[data-class-form] [data-head-primary="true"]')).toBeNull();
  });

  it("a resize across 600 moves the secondaries", () => {
    const r = renderAtClass(1440, head());
    expect(screen.getByRole("button", { name: "导入" })).toBeTruthy();
    r.resize(390);
    expect(screen.queryByRole("button", { name: "导入" })).toBeNull();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeTruthy();
  });
});

describe("compact queries (one complement of min-width 600)", () => {
  it("compact is the complement of (min-width: 600px), so a zoomed 599.5 is compact", () => {
    expect(SIZE_CLASS_QUERIES.compact).toBe("not all and (min-width: 600px)");
    expect(COMPACT_QUERY).toBe(SIZE_CLASS_QUERIES.compact);
    const at = (w: number) => matchMediaFor(w).matchMedia;
    expect(at(599.5)(COMPACT_QUERY).matches).toBe(true);
    expect(at(599.5)(SIZE_CLASS_QUERIES.medium).matches).toBe(false);
    expect(at(600)(COMPACT_QUERY).matches).toBe(false);
    expect(at(390)(COMPACT_QUERY).matches).toBe(true);
    expect(sizeClassOf(599.5)).toBe("compact");
  });

  it("the test setup's default window is not compact", () => {
    expect(window.matchMedia(COMPACT_QUERY).matches).toBe(false);
    expect(window.matchMedia("(min-width: 600px)").matches).toBe(true);
  });
});
