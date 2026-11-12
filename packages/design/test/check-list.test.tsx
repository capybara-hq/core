import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge, CheckList, type CheckListRow, DesignProvider } from "../src/index";

afterEach(cleanup);
const controls = readFileSync(resolve(import.meta.dirname, "../src/styles/controls.css"), "utf8");
const display = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8");
const ruleOf = (css: string, selector: string) =>
  new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(
    css,
  )?.[1] ?? "";

const LONG =
  "Use when starting any conversation - establishes how to find and use skills, requiring Skill tool invocation before ANY response";

const ROWS: CheckListRow[] = [
  { id: "a", title: "brainstorming", marks: <Badge>平台</Badge>, description: LONG, checked: true },
  { id: "b", title: "writing-plans", description: "Plans.", checked: false },
  { id: "c", title: "skill-guide", marks: <Badge>内置</Badge>, checked: true, locked: true },
];

function Harness({
  rows: initial = ROWS,
  title,
  selectAll = true,
  disabled,
}: {
  rows?: CheckListRow[];
  title?: string;
  selectAll?: boolean;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState(initial);
  const check = (ids: string[], next: boolean) =>
    setRows((cur) => cur.map((r) => (ids.includes(r.id) ? { ...r, checked: next } : r)));
  return (
    <DesignProvider locale="zh">
      <CheckList
        label="组织技能"
        rows={rows}
        onCheck={(id, next) => check([id], next)}
        {...(selectAll ? { onCheckAll: check } : {})}
        {...(title !== undefined ? { title } : {})}
        {...(disabled !== undefined ? { disabled } : {})}
      />
    </DesignProvider>
  );
}

describe("CheckList", () => {
  it("draws the name and its marks on the first line, the description as a cut line with its full text on hover", () => {
    render(<Harness />);
    const list = screen.getByRole("list", { name: "组织技能" });
    const row = within(list).getAllByRole("listitem")[0] as HTMLElement;
    const line = row.querySelector('[data-part="check-list-line"]') as HTMLElement;
    expect(line.querySelector('[data-part="check-list-title"]')?.textContent).toBe("brainstorming");
    // the marks sit on the name's line, outside the checkbox's label (they do not rename it)
    expect(line.querySelector('[data-part="check-list-marks"]')?.textContent).toBe("平台");
    expect(screen.getByRole("checkbox", { name: "brainstorming" })).toBeTruthy();
    const desc = row.querySelector('[data-part="check-list-description"]') as HTMLElement;
    expect(desc.parentElement).toBe(row);
    expect(line.contains(desc)).toBe(false);
    expect(desc.getAttribute("title")).toBe(LONG);
    // cut at one line; the marks never shrink or wrap
    expect(ruleOf(controls, ".cb-check-list-description")).toMatch(/text-overflow:\s*ellipsis/);
    expect(ruleOf(controls, ".cb-check-list-description")).toMatch(/white-space:\s*nowrap/);
    expect(ruleOf(controls, ".cb-check-list-marks")).toMatch(/flex:\s*none/);
    expect(ruleOf(controls, ".cb-check-list-marks")).toMatch(/white-space:\s*nowrap/);
    expect(ruleOf(controls, ".cb-check-list-title")).toMatch(/text-overflow:\s*ellipsis/);
    // a row without a description draws no second line
    const plain = within(list).getAllByRole("listitem")[2] as HTMLElement;
    expect(plain.querySelector('[data-part="check-list-description"]')).toBeNull();
  });

  it("a checked box that cannot change still shows its check (muted on the disabled ground)", () => {
    const rule = ruleOf(controls, ".cb-check input:disabled + .cb-box");
    expect(rule).toMatch(/background:\s*var\(--cb-hover\)/);
    expect(rule).toMatch(/color:\s*var\(--cb-muted\)/);
  });

  it("a Badge never shrinks or wraps anywhere (no 「平 / 台」)", () => {
    const rule = ruleOf(display, ".cb-badge");
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/flex:\s*none/);
  });

  it("the group checkbox: the group's name, mixed with checked/total, locked rows left out", async () => {
    render(<Harness title="superpowers" />);
    const all = screen.getByRole("checkbox", { name: "全选「superpowers」" });
    const count = document.querySelector('[data-part="check-list-count"]');
    // a and b are open; c is locked (built-in) and counts in neither
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    expect(count?.textContent).toBe("1/2");
    expect(document.querySelector('[data-part="check-list-group"]')?.textContent).toBe(
      "superpowers",
    );
    await userEvent.click(all);
    expect(all.getAttribute("aria-checked")).toBe("true");
    expect(count?.textContent).toBe("2/2");
    await userEvent.click(all);
    expect(all.getAttribute("aria-checked")).toBe("false");
    expect(count?.textContent).toBe("0/2");
    // the locked row stays checked and cannot be changed
    const locked = screen.getByRole("checkbox", { name: "skill-guide" }) as HTMLInputElement;
    expect(locked.checked).toBe(true);
    expect(locked.disabled).toBe(true);
  });

  it("select all acts only on the rows it is given (a filtered group)", async () => {
    render(<Harness rows={[ROWS[1] as CheckListRow]} />);
    const all = screen.getByRole("checkbox", { name: "全选" });
    expect(all.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(all);
    expect(
      (screen.getByRole("checkbox", { name: "writing-plans" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(document.querySelector('[data-part="check-list-count"]')?.textContent).toBe("1/1");
  });

  it("a group of locked rows only: the name as a heading with the count, no select-all box", () => {
    render(<Harness title="内置" rows={[ROWS[2] as CheckListRow]} />);
    expect(screen.queryByRole("checkbox", { name: /全选/ })).toBeNull();
    expect(document.querySelector('[data-part="check-list-group"]')?.textContent).toBe("内置");
    expect(document.querySelector('[data-part="check-list-count"]')?.textContent).toBe("1");
  });

  it("disabled turns every box off", () => {
    render(<Harness title="superpowers" disabled />);
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("without a title or onCheckAll there is no head row", () => {
    render(<Harness selectAll={false} />);
    expect(document.querySelector('[data-part="check-list-all"]')).toBeNull();
  });
});
