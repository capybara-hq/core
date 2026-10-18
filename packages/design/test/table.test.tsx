import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Column, DataTable, DesignProvider } from "../src/index";

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
  it("loading 骨架", () => {
    const { container } = plain({ state: "loading" });
    expect(container.querySelector("[data-empty='loading'] .cb-skeleton")).toBeTruthy();
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
    expect(screen.getByText("∅")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(onClear).toHaveBeenCalled();
  });
  it("error", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    plain({ state: "error", error: { code: "E_DB", requestId: "req1", onRetry } });
    expect(screen.getByText(/✗/)).toBeTruthy();
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
    expect(th.textContent).toContain("▼");
  });
  it("asc 显示 ▲", () => {
    plain({ sort: { key: "name", dir: "asc", onChange: vi.fn() } });
    const th = screen.getByRole("columnheader", { name: /名称/ });
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    expect(th.textContent).toContain("▲");
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
  it("勾选行 aria-selected=true、未勾选 false；选中行 aria-current=true", () => {
    render(<Harness initial={["b"]} activeKey="c" />);
    const [ra, rb, rc] = screen.getAllByRole("row").slice(1);
    expect(ra?.getAttribute("aria-selected")).toBe("false");
    expect(rb?.getAttribute("aria-selected")).toBe("true");
    expect(rc?.getAttribute("aria-current")).toBe("true");
    expect(ra?.getAttribute("aria-current")).toBeNull();
  });

  it("无 selection 时不输出 aria-selected", () => {
    plain({});
    expect(screen.getAllByRole("row")[1]?.hasAttribute("aria-selected")).toBe(false);
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

describe("清理：卡片内无框表格的行状态底色", () => {
  it("卡片内每个带底色的行状态都按有框表格的层叠方式重写（悬停、选中、展开、批量栏）", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/table.css"), "utf8");
    const card = css.slice(css.indexOf("/* 嵌入 Card"));
    const scope = '.cb-card .cb-table[data-framed="false"]';
    const rule = (sel: string) => {
      const at = card.indexOf(`${scope} ${sel}`);
      expect(at, sel).toBeGreaterThan(-1);
      return card.slice(card.indexOf("{", at), card.indexOf("}", at));
    };
    expect(rule(".cb-table-el td")).toContain("var(--cb-panel)");
    expect(rule(".cb-table-el .cb-table-row:hover td")).toContain("var(--cb-hover)");
    expect(rule('.cb-table-el .cb-table-row[data-state~="active"] td')).toContain(
      "linear-gradient(var(--cb-accent-tint), var(--cb-accent-tint)), var(--cb-panel)",
    );
    expect(rule(".cb-table-el .cb-table-expand td")).toContain("var(--cb-hover)");
    expect(rule(".cb-table-bulk")).toContain("var(--cb-hover)");
    // 勾选 / 禁用在有框表格里没有底色，卡片里也不应单独加
    expect(card).not.toMatch(/data-state~="(checked|disabled)"/);
  });
});
