import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, Grid, ItemList, StepList } from "../src/index";

afterEach(cleanup);
const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

describe("ItemList", () => {
  it("rows with a tag, a linked title, meta, a status and actions", () => {
    zh(
      <ItemList
        label="等你处理"
        rows={[
          {
            id: "a",
            tag: { label: "工具审批", tone: "accent" },
            title: "研究助手 想调用 sandbox_bash",
            meta: "2 分钟前",
            href: "/chat/c1",
            status: { label: "等你处理", tone: "accent" },
            actions: <button type="button">允许一次</button>,
          },
          { id: "b", title: "写作助手" },
        ]}
      />,
    );
    const rows = within(screen.getByRole("list", { name: "等你处理" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(
      within(first)
        .getByRole("link", { name: "研究助手 想调用 sandbox_bash" })
        .getAttribute("href"),
    ).toBe("/chat/c1");
    expect(within(first).getByText("工具审批").getAttribute("data-tone")).toBe("accent");
    expect(within(first).getByText("2 分钟前")).toBeTruthy();
    expect(within(first).getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole("link")).toBeNull();
  });

  it("empty: the muted empty text, no list", () => {
    zh(<ItemList label="会话" rows={[]} empty="还没有会话。" />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("还没有会话。")).toBeTruthy();
  });
});

describe("StepList and the main-side grid", () => {
  it("a card-inset step list marks done and to-do steps; the grid names its layout", () => {
    const { container } = zh(
      <Grid columns="main-side">
        <StepList
          inset="card"
          steps={[
            { label: "组织已建好", description: "Acme", done: true },
            {
              label: "配置模型",
              description: "x",
              done: false,
              action: <button type="button">去配置</button>,
            },
          ]}
        />
        <div />
      </Grid>,
    );
    expect(container.querySelector(".cb-grid")?.getAttribute("data-columns")).toBe("main-side");
    expect(container.querySelector(".cb-checklist")?.getAttribute("data-inset")).toBe("card");
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("data-state"))).toEqual(["done", "todo"]);
    expect(within(items[1] as HTMLElement).getByRole("button", { name: "去配置" })).toBeTruthy();
  });
});
