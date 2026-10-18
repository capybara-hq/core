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
