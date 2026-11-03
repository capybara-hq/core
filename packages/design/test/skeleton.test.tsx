import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, PageHeader, SkeletonBox, SkeletonGroup, SkeletonText } from "../src/index";

afterEach(cleanup);
const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);
const css = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "../src/styles", name), "utf8");

/** The declared value of `prop` in the first rule whose selector contains `selector`. */
function declared(sheet: string, selector: string, prop: string): string | undefined {
  for (const m of sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const d = (m[2] ?? "").match(new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+)`));
    if (d) return d[1]?.trim();
  }
  return undefined;
}

const tokenValue = (name: string) =>
  css("tokens.css")
    .match(new RegExp(`--cb-${name}:\\s*([^;]+);`))?.[1]
    ?.trim();

describe("SkeletonText", () => {
  it("SkeletonText takes the line box of its type size", () => {
    const sheet = css("display.css");
    for (const size of ["body", "small", "title"] as const) {
      const { container, unmount } = zh(<SkeletonText width="55%" size={size} />);
      const bar = container.querySelector("[data-part=skeleton-text]");
      expect(bar?.getAttribute("data-size")).toBe(size);
      const height = declared(sheet, `.cb-skeleton-text[data-size="${size}"]`, "height");
      // `title` is the h1 type size (spec §6.29); the others are their own.
      const token = size === "title" ? "h1" : size;
      expect(height).toBe(`var(--cb-type-${token}-line)`);
      expect(tokenValue(`type-${token}-line`)).toMatch(/^\d+px$/);
      unmount();
    }
    expect(declared(sheet, ".cb-skeleton-text", "background")).toBe("var(--cb-hover)");
    expect(declared(sheet, ".cb-skeleton-text", "border-radius")).toBe("var(--cb-radius-sm)");
  });

  it("takes a percentage or a pixel width", () => {
    const { container } = zh(
      <>
        <SkeletonText width="70%" />
        <SkeletonText width={96} />
      </>,
    );
    const bars = container.querySelectorAll<HTMLElement>("[data-part=skeleton-text]");
    expect(bars[0]?.style.width).toBe("70%");
    expect(bars[1]?.style.width).toBe("96px");
    expect(bars[0]?.getAttribute("data-size")).toBe("body");
  });
});

describe("SkeletonBox", () => {
  it("is a control-sized block on the selected ground", () => {
    const sheet = css("display.css");
    const { container } = zh(<SkeletonBox part="default" width={72} />);
    const box = container.querySelector<HTMLElement>("[data-part=skeleton-box]");
    expect(box?.getAttribute("data-box")).toBe("default");
    expect(box?.style.width).toBe("72px");
    expect(declared(sheet, `.cb-skeleton-box[data-box="default"]`, "height")).toBe(
      "var(--cb-control-default)",
    );
    expect(declared(sheet, ".cb-skeleton-box", "background")).toBe("var(--cb-selected)");
  });
});

describe("SkeletonGroup", () => {
  it("one busy announcement per group", () => {
    zh(
      <SkeletonGroup label="Agents">
        <SkeletonText width="30%" />
        <SkeletonGroup label="inner">
          <SkeletonText width="55%" />
        </SkeletonGroup>
      </SkeletonGroup>,
    );
    expect(screen.getAllByText("正在加载")).toHaveLength(1);
    expect(document.querySelectorAll("[aria-busy=true]")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Agents" })).toBeTruthy();
  });

  it("a PageHeader loading inside a group does not announce again", () => {
    zh(
      <SkeletonGroup label="Page">
        <PageHeader path={[]} title="" loading={{ title: true }} />
      </SkeletonGroup>,
    );
    expect(screen.getAllByText("正在加载")).toHaveLength(1);
  });
});

describe("PageHeader loading", () => {
  const path = [{ label: "capybara" }, { label: "Agents" }];

  it("PageHeader loading keeps the actions it knows", () => {
    const { container } = zh(
      <PageHeader
        path={path}
        title=""
        loading={{ title: true, actions: 2 }}
        actions={[{ label: "新建", variant: "primary", onSelect: () => {} }]}
      />,
    );
    expect(screen.getByRole("button", { name: "新建" })).toBeTruthy();
    // The actions are known, so no placeholder stands in for them.
    expect(container.querySelectorAll("[data-part=skeleton-box]")).toHaveLength(0);
    // The title is not known: a title-size bar of 30%, and no empty heading.
    const bar = container.querySelector<HTMLElement>("[data-part=skeleton-text]");
    expect(bar?.getAttribute("data-size")).toBe("title");
    expect(bar?.style.width).toBe("30%");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector("header")?.getAttribute("aria-busy")).toBe("true");
  });

  it("draws the given slot counts for actions and tabs that are not known", () => {
    const { container } = zh(
      <PageHeader path={path} title="Agents" loading={{ actions: 2, tabs: 3 }} />,
    );
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(container.querySelectorAll("[data-part=skeleton-box]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-part=skeleton-text]")).toHaveLength(3);
  });

  it("known tabs render for real while loading", () => {
    const { container } = zh(
      <PageHeader
        path={path}
        title="Agents"
        loading={{ tabs: 3 }}
        tabs={[{ id: "all", label: "全部" }]}
      />,
    );
    expect(screen.getByRole("tab", { name: /全部/ })).toBeTruthy();
    expect(container.querySelectorAll("[data-part=skeleton-text]")).toHaveLength(0);
  });
});
