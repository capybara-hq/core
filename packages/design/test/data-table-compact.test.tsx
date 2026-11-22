import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Column, DataTable } from "../src/index";
import { renderAtClass } from "./width";

const real = window.matchMedia;
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.matchMedia = real;
});

type Row = { id: string; name: string; role: string; email: string; state: string; on: boolean };
const ROWS: Row[] = [
  { id: "a", name: "Ada", role: "Owner", email: "ada@x.io", state: "Active", on: true },
  { id: "b", name: "Bo", role: "Member", email: "bo@x.io", state: "Invited", on: false },
];

const col = (key: string, header: string, compact?: Column<Row>["compact"]): Column<Row> => ({
  key,
  header,
  cell: (r) => String(r[key as keyof Row]),
  ...(compact ? { compact } : {}),
});

const declared: Column<Row>[] = [
  col("name", "Name", "title"),
  col("role", "Role", "subtitle"),
  col("email", "Email", "meta"),
  col("state", "State", "trailing"),
  col("id", "Id", "hidden"),
];
const plain: Column<Row>[] = [col("name", "Name"), col("role", "Role"), col("email", "Email")];

const base = { rows: ROWS, rowKey: (r: Row) => r.id, label: "Members" };

describe("DataTable grouped rows", () => {
  it("declared columns map to title subtitle trailing at 390", () => {
    const { container } = renderAtClass(
      390,
      <DataTable {...base} columns={declared} onOpen={() => {}} />,
    );
    const row = container.querySelector<HTMLElement>('[data-row-key="a"]');
    expect(row?.querySelector("[data-part=compact-title]")?.textContent).toBe("Ada");
    expect(row?.querySelector("[data-part=compact-subtitle]")?.textContent).toBe("Owner");
    expect(row?.querySelector("[data-part=compact-meta]")?.textContent).toBe("ada@x.io");
    expect(row?.querySelector("[data-part=compact-trailing]")?.textContent).toBe("Active");
    expect(row?.querySelector("[data-part=compact-chevron]")).not.toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });

  it("joins several subtitle columns with a middle dot", () => {
    const cols = [
      col("name", "Name", "title"),
      col("role", "Role", "subtitle"),
      col("email", "Email", "subtitle"),
    ];
    const { container } = renderAtClass(390, <DataTable {...base} columns={cols} />);
    expect(container.querySelector("[data-part=compact-subtitle]")?.textContent).toBe(
      "Owner · ada@x.io",
    );
    expect(container.querySelector("[data-part=compact-chevron]")).toBeNull();
  });

  it("the first column is the title when none declares it, and a lead is drawn", () => {
    const cols = [col("name", "Name"), col("role", "Role", "subtitle")];
    const { container } = renderAtClass(
      390,
      <DataTable
        {...base}
        columns={cols}
        compactLead={(r) => <i data-testid="lead">{r.name[0]}</i>}
      />,
    );
    expect(container.querySelector("[data-part=compact-title]")?.textContent).toBe("Ada");
    expect(screen.getAllByTestId("lead")).toHaveLength(2);
    expect(container.querySelector('[data-row-key="a"]')?.getAttribute("data-lead")).toBe("true");
  });

  it("hidden column is not drawn at 390", () => {
    const { container } = renderAtClass(390, <DataTable {...base} columns={declared} />);
    const row = container.querySelector('[data-row-key="a"]') as HTMLElement;
    // the id column ("a") is declared hidden: only the title, subtitle, meta and trailing text remain
    expect(row.textContent).toBe("AdaOwnerada@x.ioActive");
  });

  it("undeclared table keeps stacked label value rows", () => {
    const { container } = renderAtClass(390, <DataTable {...base} columns={plain} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("[data-part=compact-row]")).toBeNull();
    expect(container.querySelector('td[data-label="Role"]')).not.toBeNull();
  });

  it("declared table keeps the table at 1440", () => {
    const { container } = renderAtClass(1440, <DataTable {...base} columns={declared} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("[data-part=compact-row]")).toBeNull();
  });

  it("selection checkboxes are not mounted at 390", () => {
    const selection = { selected: new Set(["a"]), onChange: () => {} };
    const { container } = renderAtClass(
      390,
      <DataTable
        {...base}
        columns={declared}
        selection={selection}
        bulkActions={() => <b>bulk</b>}
      />,
    );
    expect(container.querySelector('input[type="checkbox"], [role="checkbox"]')).toBeNull();
    expect(container.querySelector(".cb-table-bulk")).toBeNull();
    expect(container.querySelector(".cb-table-narrow-bar")).toBeNull();
  });

  it("selection stays at 1440", () => {
    const selection = { selected: new Set(["a"]), onChange: () => {} };
    const { container } = renderAtClass(
      1440,
      <DataTable
        {...base}
        columns={declared}
        selection={selection}
        bulkActions={() => <b>bulk</b>}
      />,
    );
    expect(container.querySelector(".cb-table-bulk")).not.toBeNull();
  });

  it("contextmenu opens rowMenu items", () => {
    const run = vi.fn();
    const { container } = renderAtClass(
      390,
      <DataTable
        {...base}
        columns={declared}
        rowMenu={() => [{ label: "Remove", onSelect: run }]}
      />,
    );
    expect(screen.queryByText("Remove")).toBeNull();
    const row = container.querySelector<HTMLElement>('[data-row-key="a"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(row);
    });
    expect(screen.getByText("Remove")).not.toBeNull();
    // the sheet is titled with the row name: the row and the sheet both show it
    expect(screen.getAllByText("Ada")).toHaveLength(2);
  });

  it("a row click opens the row, but not from an interactive trailing cell", () => {
    const onOpen = vi.fn();
    const cols: Column<Row>[] = [
      col("name", "Name", "title"),
      {
        ...col("on", "On", "trailing"),
        interactive: true,
        cell: () => <button type="button">sw</button>,
      },
    ];
    const { container } = renderAtClass(
      390,
      <DataTable {...base} columns={cols} onOpen={onOpen} />,
    );
    fireEvent.click(screen.getAllByText("sw")[0] as HTMLElement);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('[data-row-key="a"]') as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith(ROWS[0]);
  });

  it("an interactive column that is not trailing is not drawn", () => {
    const cols: Column<Row>[] = [
      col("name", "Name", "title"),
      {
        ...col("on", "On", "subtitle"),
        interactive: true,
        cell: () => <button type="button">sw</button>,
      },
    ];
    renderAtClass(390, <DataTable {...base} columns={cols} />);
    expect(screen.queryByText("sw")).toBeNull();
  });

  it("two trailing columns throw in development", () => {
    const cols = [
      col("name", "Name", "title"),
      col("role", "Role", "trailing"),
      col("email", "Email", "trailing"),
    ];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderAtClass(390, <DataTable {...base} columns={cols} />)).toThrow(/trailing/);
    err.mockRestore();
  });

  it("a first column that declares hidden is not the title; the first unroled column is", () => {
    const cols = [col("id", "Id", "hidden"), col("name", "Name"), col("role", "Role", "subtitle")];
    const { container } = renderAtClass(390, <DataTable {...base} columns={cols} />);
    const row = container.querySelector('[data-row-key="a"]') as HTMLElement;
    expect(row.querySelector("[data-part=compact-title]")?.textContent).toBe("Ada");
    expect(row.textContent).toBe("AdaOwner");
  });

  it("a first column that declares another role is drawn once, in that role", () => {
    const cols = [col("role", "Role", "subtitle"), col("name", "Name")];
    const { container } = renderAtClass(390, <DataTable {...base} columns={cols} />);
    const row = container.querySelector('[data-row-key="a"]') as HTMLElement;
    expect(row.querySelector("[data-part=compact-title]")?.textContent).toBe("Ada");
    expect(row.textContent).toBe("AdaOwner");
  });

  it("a column without a role is not drawn when others declare one", () => {
    const cols = [col("name", "Name", "title"), col("role", "Role"), col("email", "Email", "meta")];
    const { container } = renderAtClass(390, <DataTable {...base} columns={cols} />);
    const row = container.querySelector('[data-row-key="a"]') as HTMLElement;
    expect(row.textContent).toBe("Adaada@x.io");
  });

  it("keeps the table, header and row roles for assistive tech", () => {
    renderAtClass(390, <DataTable {...base} columns={declared} />);
    const table = screen.getByRole("table", { name: "Members" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Name", "Role", "Email", "State"]);
    // the header row and one row per record
    expect(within(table).getAllByRole("row")).toHaveLength(1 + ROWS.length);
    expect(within(table).getAllByRole("rowgroup")).toHaveLength(2);
  });

  it("the grouped rows are one rounded box", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/table.css"), "utf8");
    const rule = /\.cb-table-compact \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("border-radius: var(--cb-radius-md);");
  });

  const touch = (type: string, el: Element, x = 10, y = 10) =>
    fireEvent(
      el,
      Object.assign(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
        {
          pointerType: "touch",
        },
      ),
    );
  const menu = () => [{ label: "Remove", onSelect: () => {} }];

  it("a 500 ms touch opens the sheet and a 12 px move cancels it", () => {
    vi.useFakeTimers();
    const { container } = renderAtClass(
      390,
      <DataTable {...base} columns={declared} rowMenu={menu} />,
    );
    const row = container.querySelector('[data-row-key="a"]') as HTMLElement;
    touch("pointerdown", row);
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByText("Remove")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Remove")).not.toBeNull();
    touch("pointerup", row);
    cleanup();
    const second = renderAtClass(390, <DataTable {...base} columns={declared} rowMenu={menu} />);
    const r2 = second.container.querySelector('[data-row-key="b"]') as HTMLElement;
    touch("pointerdown", r2, 10, 10);
    touch("pointermove", r2, 10, 22);
    act(() => vi.advanceTimersByTime(600));
    touch("pointerup", r2);
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("an open sheet stays mounted when the window leaves compact", () => {
    const { container, resize } = renderAtClass(
      390,
      <DataTable {...base} columns={declared} rowMenu={menu} />,
    );
    act(() => {
      fireEvent.contextMenu(container.querySelector('[data-row-key="a"]') as HTMLElement);
    });
    expect(screen.getByText("Remove")).not.toBeNull();
    resize(1440);
    expect(screen.getByText("Remove")).not.toBeNull();
  });
});
