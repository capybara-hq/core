import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HeaderAction,
  type ListMoreProps,
  ListPage,
  ObjectCard,
  ObjectRow,
  type PageHeaderProps,
} from "../src/index";
import { type ShellPage, ShellPageContext } from "../src/shell/shell-page";
import { css, parseCss } from "./css-rules";
import { renderAtClass } from "./width";

// Duo (interaction model §10.3, D10, D14; design spec §6.62): while `nav@1` is present
// (`<html data-native-nav>`) the list's primary is the strip pill's, so below 600 the FAB form is
// hidden and the page registers the primary with the shell; without `nav@1` the FAB is back.
// From 600 the head keeps its button.

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-native-nav");
  document.body.innerHTML = "";
});

const COMPACT = "not all and (min-width: 600px)";

function shellStub() {
  const pages = new Map<symbol, ShellPage>();
  const register = vi.fn((id: symbol, page: ShellPage | null) => {
    if (page === null) pages.delete(id);
    else pages.set(id, { ...pages.get(id), ...page });
  });
  const primary = () => [...pages.values()].find((p) => p.primary)?.primary;
  return { register, primary };
}

type ListPageProps = ComponentProps<typeof ListPage>;
const header = (actions: HeaderAction[] = []): PageHeaderProps => ({
  title: "智能体",
  path: [{ label: "智能体" }],
  actions,
});
const create = {
  label: "新建智能体",
  icon: "plus",
  variant: "primary",
  href: "/agents/new",
} as const;

function page(extra: Partial<ListPageProps> = {}, h: PageHeaderProps = header([create])) {
  const stub = shellStub();
  const ui = (
    <ShellPageContext.Provider value={stub.register}>
      <ListPage header={h} variant="objects" {...extra}>
        <ObjectRow mark={{ text: "a" }} name="a" href="/a" />
      </ListPage>
    </ShellPageContext.Provider>
  );
  return { ui, stub };
}

describe("the list primary on the Duo", () => {
  it("with nav@1 present the FAB form is hidden and the shell holds the primary", () => {
    document.documentElement.setAttribute("data-native-nav", "");
    const { ui, stub } = page();
    const { container } = renderAtClass(390, ui);
    expect(stub.primary()).toMatchObject({ id: "list-primary", label: "新建智能体", icon: "plus" });
    // hidden by CSS, only below 600 and only while data-native-nav is on <html>
    const hide = parseCss(css("list-page.css")).find(
      (r) =>
        r.at === COMPACT &&
        r.selector.includes(":root[data-native-nav]") &&
        r.selector.includes('[data-head-primary="true"][data-form="fab"]'),
    );
    expect(hide?.decls.display).toBe("none");
    expect(container.querySelector('[data-head-primary="true"]')).not.toBeNull();
  });

  it("a link primary carries its href to the shell (the shell's router follows it)", () => {
    document.documentElement.setAttribute("data-native-nav", "");
    const { ui, stub } = page();
    renderAtClass(390, ui);
    expect(stub.primary()).toMatchObject({ id: "list-primary", href: "/agents/new" });
    expect(stub.primary()?.run).toBeUndefined();
  });

  it("a button primary runs its onSelect", () => {
    const onSelect = vi.fn();
    const { ui, stub } = page(
      {},
      header([{ label: "新建", variant: "primary", icon: "plus", onSelect }]),
    );
    renderAtClass(390, ui);
    act(() => stub.primary()?.run?.());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("without nav@1 the FAB form is back", () => {
    const { ui } = page();
    const { container } = renderAtClass(390, ui);
    expect(document.documentElement.hasAttribute("data-native-nav")).toBe(false);
    expect(container.querySelector('[data-template="ListPage"]')?.getAttribute("data-fab")).toBe(
      "true",
    );
    const rules = parseCss(css("list-page.css")).concat(parseCss(css("templates.css")));
    // the hiding rule is keyed on data-native-nav: no rule hides the FAB without it
    const hides = rules.filter(
      (r) =>
        r.selector.includes('[data-form="fab"]') &&
        !r.selector.includes("data-native-nav") &&
        r.decls.display === "none",
    );
    expect(hides).toEqual([]);
    expect(
      rules.find((r) => r.at === COMPACT && r.selector.includes('[data-fab="true"]')),
    ).toBeTruthy();
  });

  it("medium keeps the head button: the hiding rule sits in the compact block only", () => {
    document.documentElement.setAttribute("data-native-nav", "");
    const { ui } = page();
    const { container } = renderAtClass(768, ui);
    expect(container.querySelector('[data-head-primary="true"] a')).not.toBeNull();
    const all = parseCss(css("list-page.css")).filter((r) =>
      r.selector.includes(":root[data-native-nav]"),
    );
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r.at === COMPACT)).toBe(true);
  });

  it("an empty state carrying the primary registers none (one primary per screen)", () => {
    document.documentElement.setAttribute("data-native-nav", "");
    const { ui, stub } = page({ empty: { text: "还没有", action: create } });
    renderAtClass(390, ui);
    expect(stub.primary()).toBeUndefined();
  });

  it("no primary action registers none", () => {
    const { ui, stub } = page({}, header());
    renderAtClass(390, ui);
    expect(stub.primary()).toBeUndefined();
  });
});

describe("ListPage load more passthrough", () => {
  const more = (extra: Partial<ListMoreProps> = {}): ListMoreProps => ({
    onLoadMore: vi.fn(),
    hasMore: true,
    ...extra,
  });

  it("objects: the wide list shows Load more and calls onLoadMore", () => {
    const m = more();
    renderAtClass(
      1280,
      <ListPage header={{ title: "t", path: [{ label: "t" }] }} variant="objects" more={m}>
        <ObjectRow mark={{ text: "a" }} name="a" href="/a" />
      </ListPage>,
    );
    fireEvent.click(screen.getByRole("button", { name: /加载更多|Load more/ }));
    expect(m.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("cards: the error and Retry come through", () => {
    const m = more({ loadMoreError: "读取失败" });
    renderAtClass(
      1280,
      <ListPage header={{ title: "t", path: [{ label: "t" }] }} variant="cards" more={m}>
        <ObjectCard avatar={{ kind: "preset", id: "capybara" }} title="a" href="/a" />
      </ListPage>,
    );
    expect(screen.getByText("读取失败")).toBeTruthy();
  });
});
