import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, ImpactPreview } from "../src/index";

afterEach(cleanup);
const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);
const css = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8");

describe("ImpactPreview (spec §6.35)", () => {
  it("each group is a region named by its h3, with its rows as a list", () => {
    zh(
      <ImpactPreview
        empty="没有影响"
        groups={[
          {
            id: "agents",
            title: "受影响的智能体",
            items: [{ id: "a", title: "研究助手", notes: [{ text: "技能 crm-notes" }] }],
          },
          {
            id: "removed",
            title: "将移除",
            items: [
              { id: "s", title: "crm-notes", code: "技能" },
              { id: "c", title: "crm", notes: [{ text: "凭据会清空", tone: "warn" }] },
            ],
          },
        ]}
      />,
    );
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "受影响的智能体",
      "将移除",
    ]);
    const removed = screen.getByRole("region", { name: /将移除/ });
    expect(removed.getAttribute("data-variant")).toBe("divided");
    const list = within(removed).getByRole("list", { name: "将移除" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    // a warn note carries its icon and tone; no character list markers
    const warn = within(list).getByText("凭据会清空");
    expect(warn.getAttribute("data-tone")).toBe("warn");
    expect(warn.querySelector("svg")).not.toBeNull();
    expect(removed.textContent).not.toMatch(/[·−•]/);
  });

  it("a group with nothing shows its own empty line, or is left out without one", () => {
    zh(
      <ImpactPreview
        empty="没有影响"
        groups={[
          { id: "removed", title: "将移除", items: [{ id: "s", title: "crm-notes" }] },
          { id: "kept", title: "保留", items: [], empty: "没有保留的组件" },
          { id: "orgs", title: "受影响的组织", items: [] },
        ]}
      />,
    );
    expect(screen.getByRole("region", { name: "保留" }).textContent).toContain("没有保留的组件");
    expect(screen.queryByRole("region", { name: "受影响的组织" })).toBeNull();
    expect(screen.queryByText("没有影响")).toBeNull();
  });

  it("with nothing in any group, the one empty line is said once, no headings", () => {
    const { container } = zh(
      <ImpactPreview
        empty="没有影响"
        groups={[
          { id: "a", title: "将移除", items: [], empty: "没有组件会被移除" },
          { id: "b", title: "保留" },
        ]}
      />,
    );
    expect(screen.getAllByText("没有影响")).toHaveLength(1);
    expect(screen.queryByText("没有组件会被移除")).toBeNull();
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    expect(
      container.querySelector('[data-part="impact-preview"]')?.getAttribute("data-state"),
    ).toBe("empty");
  });

  it("content (a table) comes before the group's rows", () => {
    zh(
      <ImpactPreview
        empty="没有影响"
        groups={[{ id: "c", title: "会变化", content: <table aria-label="组件" /> }]}
      />,
    );
    const region = screen.getByRole("region", { name: "会变化" });
    expect(within(region).getByRole("table", { name: "组件" })).toBeTruthy();
  });

  it("groups sit space.4 apart; the empty line is prose, small and muted", () => {
    expect(css).toMatch(/\.cb-impact-preview \{[^}]*row-gap: var\(--cb-space-4\);/);
    expect(css).toMatch(
      /\.cb-impact-preview-empty \{[^}]*color: var\(--cb-muted\);[^}]*font-family: var\(--cb-font-prose\);[^}]*font-size: var\(--cb-type-small-size\);/,
    );
  });
});
