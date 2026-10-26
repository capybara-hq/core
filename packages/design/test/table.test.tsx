import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, CellTitle, type Column, DataTable, DesignProvider } from "../src/index";

afterEach(cleanup);

type Row = { id: string; name: string; n: number };
const rows: Row[] = [
  { id: "a", name: "Alpha", n: 1 },
  { id: "b", name: "Beta", n: 2 },
  { id: "c", name: "Gamma", n: 3 },
];
const columns: Column<Row>[] = [
  { key: "name", header: "名称", cell: (r) => r.name, sortable: true },
  { key: "n", header: "数量", cell: (r) => r.n, align: "right" },
];

type Props = Partial<React.ComponentProps<typeof DataTable<Row>>>;

function Harness(props: Props & { initial?: string[] }) {
  const [sel, setSel] = useState<Set<string>>(new Set(props.initial ?? []));
  return (
    <DesignProvider locale="zh">
      <DataTable<Row>
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        label="测试表"
        selection={{ selected: sel, onChange: setSel }}
        bulkActions={() => <button type="button">批量删除</button>}
        {...props}
      />
    </DesignProvider>
  );
}

const plain = (props: Props) =>
  render(
    <DesignProvider locale="zh">
      <DataTable<Row>
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        label="测试表"
        {...props}
      />
    </DesignProvider>,
  );

describe("DataTable density and parts", () => {
  it("toolbar controls are default (28) and row menus dense; rowHeight is a data attribute", () => {
    plain({
      toolbar: <Button>导出</Button>,
      rowMenu: () => [{ label: "删除", onSelect: () => {} }],
      rowHeight: "roomy",
    });
    // The signed reference draws the toolbar at the default step (spec §6.6).
    expect(screen.getByRole("button", { name: "导出" }).getAttribute("data-density")).toBe(
      "default",
    );
    const menus = screen.getAllByRole("button", { name: "行操作" });
    expect(menus[0]?.getAttribute("data-density")).toBe("dense");
    const table = screen.getByRole("table", { name: "测试表" });
    expect(table.closest('[data-part="table"]')).toBeTruthy();
    expect(table.closest(".cb-table")?.getAttribute("data-row-height")).toBe("roomy");
    expect(table.querySelectorAll('[data-part="header-cell"]')).toHaveLength(3);
    expect(table.querySelectorAll('tbody [data-part="row"]')).toHaveLength(3);
    expect(table.querySelector('[data-part="row"] [data-part="cell"]')?.textContent).toBe("Alpha");
    expect(table.querySelectorAll('tbody [data-part="menu-cell"]')).toHaveLength(3);
  });
  it("toolbarEnd sits after the toolbar, in its own right-aligned part (sort, view switch)", () => {
    plain({ toolbar: <Button>筛选</Button>, toolbarEnd: <span>按最近调用排序</span> });
    const end = document.querySelector('[data-part="table-toolbar-end"]') as HTMLElement;
    expect(end.textContent).toBe("按最近调用排序");
    const toolbar = document.querySelector('[data-part="table-toolbar"]') as HTMLElement;
    expect(end.parentElement).toBe(toolbar);
    expect(toolbar.lastElementChild).toBe(end);
  });
  it("the bulk bar's actions are default, like the toolbar it replaces", () => {
    render(<Harness initial={["a"]} bulkActions={() => <Button>批量删除</Button>} />);
    expect(screen.getByRole("button", { name: "批量删除" }).getAttribute("data-density")).toBe(
      "default",
    );
  });
  it("rowHeight defaults to default", () => {
    const { container } = plain({});
    expect(container.querySelector(".cb-table")?.getAttribute("data-row-height")).toBe("default");
  });
  it("the empty state's action is default and the loading state draws skeleton bars", () => {
    const r = plain({ rows: [], empty: { title: "还没有连接器", action: <Button>添加</Button> } });
    expect(screen.getByRole("button", { name: "添加" }).getAttribute("data-density")).toBe(
      "default",
    );
    expect(r.container.querySelector('[data-part="table-empty"]')).toBeTruthy();
    expect(screen.getByText("还没有连接器").getAttribute("data-part")).toBe("table-empty-title");
    cleanup();
    const l = plain({ state: "loading" });
    expect(l.container.querySelectorAll('[data-part="skeleton-bar"]').length).toBeGreaterThan(0);
  });
  it("loading announces itself to assistive tech", () => {
    plain({ state: "loading" });
    expect(screen.getByRole("status").textContent).toContain("正在加载");
  });
  it("every empty state sits under the header (spec §6.6)", () => {
    const kinds: Props[] = [
      { state: "loading" },
      { rows: [] },
      { rows: [], noResults: { description: "状态：失败", onClear: () => {} } },
      { state: "error", error: { code: "E1", onRetry: () => {} } },
    ];
    for (const k of kinds) {
      const r = plain(k);
      expect(r.container.querySelectorAll('thead [data-part="header-cell"]')).toHaveLength(2);
      cleanup();
    }
  });
  it("no results shows the search-x icon", () => {
    const r = plain({ rows: [], noResults: { description: "状态：失败", onClear: () => {} } });
    expect(
      r.container.querySelector('[data-empty="no-results"] [data-icon="search-x"]'),
    ).toBeTruthy();
  });
  it("a CellTitle first cell names the row checkbox", () => {
    render(
      <Harness
        columns={[
          {
            key: "name",
            header: "名称",
            cell: (r) => <CellTitle title={r.name} description="d" />,
          },
        ]}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "选择 Alpha" })).toBeTruthy();
  });
});

describe("DataTable selection", () => {
  it("勾选后批量栏替换工具栏，Esc 清空", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DesignProvider locale="zh">
        <DataTable<Row>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          label="测试表"
          toolbar={<span>工具栏</span>}
          selection={{ selected: new Set(["a"]), onChange }}
          bulkActions={() => <button type="button">批量删除</button>}
        />
      </DesignProvider>,
    );
    expect(screen.getByText("已选 1 项")).toBeTruthy();
    expect(screen.getByText("批量删除")).toBeTruthy();
    expect(screen.queryByText("工具栏")).toBeNull();
    await user.keyboard("{Escape}");
    expect(onChange).toHaveBeenCalledWith(new Set());
  });

  it("表头全选框半选为 mixed，禁用行不被全选", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["a"]} isDisabled={(r) => r.id === "c"} />);
    const all = screen.getByRole("checkbox", { name: "全选" });
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    await user.click(all);
    expect(screen.getByText("已选 2 项")).toBeTruthy();
    const rowC = screen.getByText("Gamma").closest("tr") as HTMLElement;
    expect((within(rowC).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(rowC.getAttribute("data-state")).toContain("disabled");
  });

  it("键盘：↓ 移动焦点，空格勾选，↵ 打开", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    const r1 = screen.getByText("Alpha").closest("tr") as HTMLElement;
    const r2 = screen.getByText("Beta").closest("tr") as HTMLElement;
    r1.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(r2);
    await user.keyboard(" ");
    expect(screen.getByText("已选 1 项")).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(rows[1]);
  });
});

describe("DataTable rows", () => {
  it("activeKey 行 data-state 含 active；点击行调用 onOpen，点击复选框不调用", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Harness activeKey="b" onOpen={onOpen} />);
    const r2 = screen.getByText("Beta").closest("tr") as HTMLElement;
    expect(r2.getAttribute("data-state")).toContain("active");
    await user.click(screen.getByText("Alpha"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const r1 = screen.getByText("Alpha").closest("tr") as HTMLElement;
    await user.click(within(r1).getByRole("checkbox"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("勾选行 data-state 含 checked", () => {
    render(<Harness initial={["a"]} />);
    const r1 = screen.getByText("Alpha").closest("tr") as HTMLElement;
    expect(r1.getAttribute("data-state")).toContain("checked");
  });

  it("right 对齐与超长内容 title", () => {
    plain({ rows: [{ id: "x", name: "很长很长的名称", n: 9 }] });
    expect(screen.getByText("9").closest("td")?.getAttribute("data-align")).toBe("right");
    expect(screen.getByText("很长很长的名称").getAttribute("title")).toBe("很长很长的名称");
  });

  it("行菜单点击不触发 onOpen", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    plain({ onOpen, rowMenu: () => [{ label: "编辑", onSelect }] });
    const r1 = screen.getByText("Alpha").closest("tr") as HTMLElement;
    await user.click(within(r1).getByRole("button", { name: "行操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "编辑" }));
    expect(onSelect).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("某行的菜单项为空：该行不显示 ⋯（列仍保留，其他行照常）", () => {
    plain({ rowMenu: (r) => (r.id === rows[0]?.id ? [] : [{ label: "编辑", onSelect() {} }]) });
    const [r1, r2] = screen.getAllByRole("row").slice(1) as HTMLElement[];
    expect(within(r1 as HTMLElement).queryByRole("button", { name: "行操作" })).toBeNull();
    expect(within(r1 as HTMLElement).getAllByRole("cell")).toHaveLength(columns.length + 1);
    expect(within(r2 as HTMLElement).getByRole("button", { name: "行操作" })).toBeTruthy();
  });

  it("展开行：内容放进缩进容器，引导符由每行 CSS 前缀提供（不再单独渲染一行 └）", () => {
    const { container } = plain({
      expand: (r) =>
        r.id === "a" ? (
          <>
            <div>第一行</div>
            <div>第二行</div>
          </>
        ) : null,
    });
    const body = container.querySelector(".cb-table-expand-body");
    expect(body).toBeTruthy();
    expect(body?.children.length).toBe(2);
    expect(container.querySelector(".cb-table-guide")).toBeNull();
    expect(container.textContent).not.toContain("└");
  });

  it("展开内容为纯文本时包成一行", () => {
    const { container } = plain({ expand: (r) => (r.id === "a" ? "摘要" : null) });
    const body = container.querySelector(".cb-table-expand-body");
    expect(body?.children.length).toBe(1);
    expect(body?.textContent).toBe("摘要");
  });

  it("framed 默认 true；framed={false} 去掉外框以嵌入 Card", () => {
    const { container } = plain({});
    expect(container.querySelector(".cb-table")?.getAttribute("data-framed")).toBe("true");
    cleanup();
    const r = plain({ framed: false });
    expect(r.container.querySelector(".cb-table")?.getAttribute("data-framed")).toBe("false");
  });
});

describe("DataTable states", () => {
  it("loading draws skeleton bars under the header, the panel is aria-busy", () => {
    const { container } = plain({ state: "loading" });
    expect(
      container.querySelector("[data-empty='loading'] [data-part='skeleton-bar']"),
    ).toBeTruthy();
    expect(container.querySelector("[data-part='table']")?.getAttribute("aria-busy")).toBe("true");
  });
  it("empty", () => {
    plain({
      rows: [],
      empty: { title: "还没有数据", action: <button type="button">新建</button> },
    });
    expect(screen.getByText("还没有数据")).toBeTruthy();
    expect(screen.getByText("新建")).toBeTruthy();
  });
  it("noResults", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    plain({ rows: [], noResults: { description: "状态=失败", onClear } });
    expect(screen.getByText("没有符合条件的结果")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(onClear).toHaveBeenCalled();
  });
  it("error", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    plain({ state: "error", error: { code: "E_DB", requestId: "req1", onRetry } });
    expect(screen.getByRole("alert").querySelector("svg.cb-icon")).toBeTruthy();
    expect(screen.getByText(/E_DB/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /重试/ }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("DataTable sort", () => {
  it("点击可排序表头调用 onChange asc", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    plain({ sort: { key: "n", dir: "asc", onChange } });
    await user.click(screen.getByRole("button", { name: /名称/ }));
    expect(onChange).toHaveBeenCalledWith("name", "asc");
  });
  it("当前排序列显示箭头与 aria-sort", () => {
    plain({ sort: { key: "name", dir: "desc", onChange: vi.fn() } });
    const th = screen.getByRole("columnheader", { name: /名称/ });
    expect(th.getAttribute("aria-sort")).toBe("descending");
    expect(th.querySelector("svg.cb-icon")).toBeTruthy();
  });
  it("asc shows the arrow-up icon", () => {
    plain({ sort: { key: "name", dir: "asc", onChange: vi.fn() } });
    const th = screen.getByRole("columnheader", { name: /名称/ });
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    expect(th.querySelector("svg.cb-icon")).toBeTruthy();
  });
});

describe("DataTable fixes", () => {
  it("行重排后保持同一 DOM 节点与焦点", () => {
    const ui = (rs: Row[]) => (
      <DesignProvider locale="zh">
        <DataTable<Row> columns={columns} rows={rs} rowKey={(r) => r.id} label="t" />
      </DesignProvider>
    );
    const { rerender } = render(ui(rows));
    const before = screen.getByText("Beta").closest("tr") as HTMLElement;
    before.focus();
    rerender(ui([rows[2] as Row, rows[1] as Row, rows[0] as Row]));
    const after = screen.getByText("Beta").closest("tr") as HTMLElement;
    expect(after).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it("行复选框名称可区分，rowLabel 优先", () => {
    const sel = { selected: new Set<string>(), onChange: vi.fn() };
    const { rerender } = plain({ selection: sel });
    expect(screen.getByRole("checkbox", { name: "选择 Alpha" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "选择 Beta" })).toBeTruthy();
    rerender(
      <DesignProvider locale="zh">
        <DataTable<Row>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          label="t"
          selection={sel}
          rowLabel={(r) => `行${r.id}`}
        />
      </DesignProvider>,
    );
    expect(screen.getByRole("checkbox", { name: "选择 行a" })).toBeTruthy();
  });
});

describe("清理：行的 aria 状态、行内控件 roving tabindex、默认空文案", () => {
  it("选中行 aria-current=true；普通 <table> 的行不输出 aria-selected（勾选由行复选框表达）", () => {
    render(<Harness initial={["b"]} activeKey="c" />);
    const [ra, rb, rc] = screen.getAllByRole("row").slice(1);
    expect(rc?.getAttribute("aria-current")).toBe("true");
    expect(ra?.getAttribute("aria-current")).toBeNull();
    for (const r of [ra, rb, rc]) expect(r?.hasAttribute("aria-selected")).toBe(false);
    expect((within(rb as HTMLElement).getByRole("checkbox") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("只有 Tab 停靠行的复选框与 ⋯ 在 Tab 顺序里；Tab 不在每行停留", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness rowMenu={() => [{ label: "复制", onSelect() {} }]} />
        <button type="button">表格之后</button>
      </>,
    );
    const rows = screen.getAllByRole("row").slice(1);
    const boxes = rows.map((r) => within(r).getByRole("checkbox") as HTMLInputElement);
    const menus = rows.map((r) => within(r).getByRole("button", { name: "行操作" }));
    expect(boxes.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    expect(menus.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    // 全选 → 第一行 → 行复选框 → 行菜单 → 表格之后
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "全选" }));
    await user.tab();
    expect(document.activeElement).toBe(rows[0]);
    await user.tab();
    expect(document.activeElement).toBe(boxes[0]);
    await user.tab();
    expect(document.activeElement).toBe(menus[0]);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "表格之后" }));
  });

  it("焦点移到另一行（含点击其复选框）后，该行的控件进入 Tab 顺序", async () => {
    const user = userEvent.setup();
    render(<Harness rowMenu={() => [{ label: "复制", onSelect() {} }]} />);
    const rows = screen.getAllByRole("row").slice(1);
    rows[0]?.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
    const box = (r?: HTMLElement) =>
      within(r as HTMLElement).getByRole("checkbox") as HTMLInputElement;
    expect(box(rows[1]).tabIndex).toBe(0);
    expect(box(rows[0]).tabIndex).toBe(-1);
    await user.click(box(rows[2]));
    expect(box(rows[2]).tabIndex).toBe(0);
    expect(rows[2]?.tabIndex).toBe(0);
  });

  it("rows=[] 且未给 empty / noResults：显示默认「暂无数据」", () => {
    plain({ rows: [] });
    expect(screen.getByText("暂无数据")).toBeTruthy();
  });

  it("英文默认文案 No data", () => {
    render(
      <DesignProvider locale="en">
        <DataTable<Row> columns={columns} rows={[]} rowKey={(r) => r.id} label="t" />
      </DesignProvider>,
    );
    expect(screen.getByText("No data")).toBeTruthy();
  });
});

describe("row grounds of a table inside a card", () => {
  it("rows paint their state through --cb-row-ground; a card table's ground is the panel", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/table.css"), "utf8");
    expect(css).toMatch(
      /\.cb-card \.cb-table\[data-framed="false"\] \{\s*--cb-table-ground: var\(--cb-panel\);/,
    );
    expect(css).toMatch(/\.cb-table-row:hover \{\s*--cb-row-ground: var\(--cb-hover\);/);
    expect(css).toMatch(
      /\.cb-table-row\[data-state~="active"\] \{\s*--cb-row-ground: var\(--cb-accent-tint\);/,
    );
    // checked / disabled rows keep the ground (only the checkbox / text changes)
    expect(css).not.toMatch(/data-state~="(checked|disabled)"\] \{\s*--cb-row-ground/);
  });
});

describe("CellTitle", () => {
  it("draws the initial tile, the name and the description, with full text in title", async () => {
    const { CellTitle } = await import("../src/index");
    const { container } = render(
      <CellTitle title="Acme Docs" description="检索文档" initial="A" />,
    );
    expect(container.querySelector(".cb-cell-initial")?.textContent).toBe("A");
    expect(screen.getByText("Acme Docs").getAttribute("title")).toBe("Acme Docs");
    expect(screen.getByText("检索文档").getAttribute("title")).toBe("检索文档");
  });
});
