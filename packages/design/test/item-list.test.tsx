import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Badge,
  DesignProvider,
  Field,
  Grid,
  Input,
  ItemList,
  ItemListItem,
  LoadingSubsection,
  StepList,
  Subsection,
  Text,
} from "../src/index";

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
            title: "研究助手 想调用 Bash",
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
      within(first).getByRole("link", { name: "研究助手 想调用 Bash" }).getAttribute("href"),
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

describe("StepList: one thing at the right of a step", () => {
  it("done shows 已完成, a to-do step only its action (or reason), never a 待办 label", () => {
    zh(
      <StepList
        inset="card"
        steps={[
          { label: "配置模型", description: "x", done: true },
          {
            label: "新建 agent",
            description: "y",
            done: false,
            action: <button type="button">新建</button>,
          },
          { label: "邀请成员", description: "z", done: false, action: <span>先配置模型</span> },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    const ends = items.map((i) => i.querySelectorAll(".cb-checklist-end"));
    expect(ends.map((e) => e.length)).toEqual([1, 1, 1]);
    expect(ends[0]?.[0]?.textContent).toBe("已完成");
    expect(within(ends[1]?.[0] as HTMLElement).getByRole("button", { name: "新建" })).toBeTruthy();
    expect(ends[2]?.[0]?.textContent).toBe("先配置模型");
    expect(screen.queryByText("待办")).toBeNull();
  });
});

describe("StepList inset in a card", () => {
  it("a card-inset step list marks done and to-do steps", () => {
    const { container } = zh(
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
      />,
    );
    expect(container.querySelector(".cb-checklist")?.getAttribute("data-inset")).toBe("card");
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("data-state"))).toEqual(["done", "todo"]);
    expect(within(items[1] as HTMLElement).getByRole("button", { name: "去配置" })).toBeTruthy();
  });
});

describe("ItemListItem (rows that hold more than a line, spec §6.12)", () => {
  it("the title line (title, mono id, marks, actions), meta lines and a body named by the title", () => {
    zh(
      <ItemList label="用途" inset="flush">
        <ItemListItem
          title="评测"
          code="eval"
          marks={<Badge tone="warn">敏感</Badge>}
          actions={<button type="button">移除</button>}
          meta={<Text variant="small">由内核声明</Text>}
        >
          <Field label="模型">
            <Input defaultValue="deepseek-chat" />
          </Field>
        </ItemListItem>
        <ItemListItem title="标题" />
      </ItemList>,
    );
    const list = screen.getByRole("list", { name: "用途" });
    expect(list.getAttribute("data-inset")).toBe("flush");
    const [first, second] = within(list).getAllByRole("listitem") as HTMLElement[];
    expect(first?.getAttribute("data-shape")).toBe("item");
    // a row with fields is a group named by its title, so its fields read as that row's
    const group = within(first as HTMLElement).getByRole("group", { name: "评测" });
    expect(within(group).getByRole("textbox", { name: "模型" })).toBeTruthy();
    expect(within(first as HTMLElement).getByText("eval").className).toBe("cb-item-list-code");
    expect(within(first as HTMLElement).getByText("敏感")).toBeTruthy();
    expect(within(first as HTMLElement).getByRole("button", { name: "移除" })).toBeTruthy();
    expect(
      within(first as HTMLElement)
        .getByText("由内核声明")
        .closest(".cb-item-list-lines"),
    ).not.toBeNull();
    // a row without a body is no group
    expect(within(second as HTMLElement).queryByRole("group")).toBeNull();
  });

  it("empty meta and empty children draw no lines and no body", () => {
    zh(
      <ItemList label="用途">
        <ItemListItem title="评测" meta={[]}>
          {false}
        </ItemListItem>
      </ItemList>,
    );
    const row = within(screen.getByRole("list")).getByRole("listitem");
    expect(row.querySelector(".cb-item-list-lines")).toBeNull();
    expect(row.querySelector(".cb-item-list-body")).toBeNull();
    expect(within(row).queryByRole("group")).toBeNull();
    cleanup();
    zh(
      <ItemList label="渠道" empty="还没有渠道。">
        {false}
        {null}
      </ItemList>,
    );
    expect(screen.getByText("还没有渠道。")).toBeTruthy();
  });

  it("rows and children together; empty children fall back to the empty text", () => {
    zh(
      <ItemList label="渠道" rows={[{ id: "a", title: "飞书" }]}>
        <ItemListItem title="Slack" href="/channels/s" />
      </ItemList>,
    );
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Slack" }).getAttribute("href")).toBe("/channels/s");
    cleanup();
    zh(
      <ItemList label="渠道" empty="还没有渠道。">
        {[].map(() => null)}
      </ItemList>,
    );
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("还没有渠道。")).toBeTruthy();
  });

  it("the stylesheet: hairlines between rows, space.4 padding when flush, an invalid bar", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/templates.css"), "utf8");
    expect(css).toMatch(
      /\.cb-item-list\[data-inset="flush"\] > \.cb-item-list-row\[data-shape="item"\] \{\s*padding: var\(--cb-space-4\);/,
    );
    expect(css).toMatch(/\.cb-item-list-row \{[^}]*border-top: 1px solid var\(--cb-line-soft\);/);
    expect(css).toMatch(
      /\.cb-item-list-row\[data-invalid="true"\]::before \{[^}]*background: var\(--cb-fail\);/,
    );
  });
});

describe("Subsection (a group inside one box, spec §6.32)", () => {
  it("a region named by its h3, the help line, the content under the guide", () => {
    zh(
      <Subsection
        title="高级"
        count={2}
        description="一般不用改。"
        actions={<button type="button">重置</button>}
      >
        <span>字段</span>
      </Subsection>,
    );
    const region = screen.getByRole("region", { name: "高级" });
    expect(region.getAttribute("data-variant")).toBe("guide");
    expect(within(region).getByRole("heading", { level: 3, name: "高级" })).toBeTruthy();
    expect(within(region).getByText("2").getAttribute("data-part")).toBe("subsection-count");
    expect(within(region).getByText("一般不用改。").tagName).toBe("P");
    expect(
      within(region).getByText("字段").closest('[data-part="subsection-body"]'),
    ).not.toBeNull();
  });

  it("a node description is a block in the help's place (lines of its own, valid markup)", () => {
    zh(
      <Subsection
        title="broken"
        variant="flush"
        description={
          <div role="alert">
            <Text tone="fail" icon="circle-x">
              列模型失败
            </Text>
            <Text variant="small" tone="fail">
              connection refused
            </Text>
          </div>
        }
      />,
    );
    const region = screen.getByRole("region", { name: "broken" });
    const help = region.querySelector('[data-part="subsection-description"]') as HTMLElement;
    expect(help.tagName).toBe("DIV");
    expect(help.getAttribute("data-block")).toBe("true");
    expect(within(help).getByRole("alert").textContent).toContain("connection refused");
  });

  it("LoadingSubsection: the frame with a skeleton bar in the title's slot, then the content", () => {
    zh(
      <LoadingSubsection variant="flush">
        <span>表</span>
      </LoadingSubsection>,
    );
    const el = document.querySelector('[data-part="subsection"]') as HTMLElement;
    expect(el.getAttribute("data-variant")).toBe("flush");
    expect(el.querySelector("h3")).toBeNull();
    expect(
      el.querySelector('[data-part="subsection-title"] [data-part="skeleton-text"]'),
    ).not.toBeNull();
    expect(within(el).getByText("表").closest('[data-part="subsection-body"]')).not.toBeNull();
  });

  it("the stylesheet: a 1px line guide, and flush subsections split by line-soft", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8");
    expect(css).toMatch(
      /\.cb-subsection\[data-variant="guide"\] > \.cb-subsection-body \{\s*padding-left: var\(--cb-space-2\);\s*border-left: 1px solid var\(--cb-line\);/,
    );
    expect(css).toMatch(
      /\.cb-subsection\[data-variant="flush"\] \+ \.cb-subsection\[data-variant="flush"\] \{\s*border-top: 1px solid var\(--cb-line-soft\);/,
    );
  });
});

describe("Grid divided and Text h3", () => {
  it("a divided grid marks itself; its rule draws a line-soft column divider", () => {
    const { container } = zh(
      <Grid columns="list-detail" divided>
        <span>列表</span>
        <span>详情</span>
      </Grid>,
    );
    expect(container.querySelector(".cb-grid")?.getAttribute("data-divided")).toBe("true");
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/controls.css"), "utf8");
    expect(css).toMatch(
      /\.cb-grid\[data-divided="true"\] > \* \+ \* \{\s*padding-left: var\(--cb-space-4\);\s*border-left: 1px solid var\(--cb-line-soft\);/,
    );
  });

  it("Text h3 is a level-3 heading", () => {
    zh(<Text variant="h3">AGENTS.md</Text>);
    expect(screen.getByRole("heading", { level: 3, name: "AGENTS.md" })).toBeTruthy();
  });
});
