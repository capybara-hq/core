import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOARD_FIXTURE as F } from "../src/fixtures/index";
import { Board, type BoardCard, type BoardProps, DesignProvider } from "../src/index";
import { renderAtClass } from "./width";

// Board (spec §6.69; plugin full pages design §6): columns of cards, pointer drag and keyboard
// moves, locked columns, the compact form with its Move to… menu.

type Task = BoardCard & { title: string; meta: string };

const real = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = real;
  vi.restoreAllMocks();
});

const CARDS: Task[] = F.cards.map((c) => ({ ...c }));
const COLUMNS = F.columns.map((c) => ({ ...c }));
const HINT = F.columns[2].hint;

function props(over: Partial<BoardProps<Task>> = {}): BoardProps<Task> {
  return {
    columns: COLUMNS,
    cards: CARDS,
    renderCard: (c) => <span>{c.title}</span>,
    onMove: vi.fn(),
    onOpen: vi.fn(),
    ...over,
  };
}

function board(over: Partial<BoardProps<Task>> = {}, wrap?: (n: ReactNode) => ReactNode) {
  const p = props(over);
  const node = <Board {...p} />;
  const r = render(<DesignProvider locale="zh">{wrap ? wrap(node) : node}</DesignProvider>);
  return { ...r, p };
}

const cardEl = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-part="board-card"][data-card-id="${id}"]`) as HTMLElement;
const columnOf = (el: HTMLElement) =>
  (el.closest('[data-part="board-column"]') as HTMLElement).dataset.columnId;
const key = (el: HTMLElement, k: string) => fireEvent.keyDown(el, { key: k });
/** The board's own polite live region (the library's silent region is a second `status`). */
const live = () => document.querySelector('[data-part="board-live"]') as HTMLElement;

describe("Board", () => {
  it("draws the columns with their heads and cards in order", () => {
    const { container } = board();
    const cols = [...container.querySelectorAll<HTMLElement>('[data-part="board-column"]')];
    expect(cols.map((c) => c.dataset.columnId)).toEqual(["todo", "doing", "review", "done"]);
    const todo = within(screen.getByRole("list", { name: "待处理" }));
    expect(todo.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "整理 11 月客户反馈",
      "更新部署手册的回滚章节",
      "核对发票抬头",
    ]);
    // the locked column's lock carries the hint as its tooltip; the empty column its drop area
    expect(cols[2]?.querySelector('[data-part="board-column-lock"]')?.getAttribute("title")).toBe(
      HINT,
    );
    expect(cols[3]?.querySelector('[data-part="board-column-empty"]')).not.toBeNull();
    // the count
    expect(cols[0]?.querySelector('[data-part="board-column-count"]')?.textContent).toBe("3");
  });

  it("is one tab stop; arrows move the focus; Enter opens", () => {
    const { container, p } = board();
    const stops = [...container.querySelectorAll('[data-part="board-card"][tabindex="0"]')];
    expect(stops).toHaveLength(1);
    const t1 = cardEl(container, "t1");
    t1.focus();
    key(t1, "ArrowDown");
    expect(document.activeElement).toBe(cardEl(container, "t2"));
    key(cardEl(container, "t2"), "ArrowRight");
    expect(document.activeElement).toBe(cardEl(container, "t5"));
    key(cardEl(container, "t5"), "End");
    key(cardEl(container, "t5"), "Enter");
    expect(p.onOpen).toHaveBeenCalledWith("t5");
  });

  it("keyboard: space picks, arrow right moves to next column, space drops → onMove(id, col2, 0)", () => {
    const { container, p } = board();
    const t1 = cardEl(container, "t1");
    t1.focus();
    key(t1, " ");
    expect(cardEl(container, "t1").dataset.held).toBe("true");
    key(cardEl(container, "t1"), "ArrowRight");
    const moved = cardEl(container, "t1");
    expect(columnOf(moved)).toBe("doing");
    expect(document.activeElement).toBe(moved);
    expect((moved.closest('[data-part="board-column"]') as HTMLElement).dataset.over).toBe("true");
    key(moved, " ");
    expect(p.onMove).toHaveBeenCalledTimes(1);
    expect(p.onMove).toHaveBeenCalledWith("t1", "doing", 0);
    expect(cardEl(container, "t1").dataset.held).toBeUndefined();
  });

  it("moves within a column with the up and down arrows", () => {
    const { container, p } = board();
    const t1 = cardEl(container, "t1");
    t1.focus();
    key(t1, " ");
    key(cardEl(container, "t1"), "ArrowDown");
    key(cardEl(container, "t1"), "ArrowDown");
    key(cardEl(container, "t1"), "Enter");
    expect(p.onMove).toHaveBeenCalledWith("t1", "todo", 2);
  });

  it("escape cancels without onMove", () => {
    const { container, p } = board();
    const t1 = cardEl(container, "t1");
    t1.focus();
    key(t1, " ");
    key(cardEl(container, "t1"), "ArrowRight");
    key(cardEl(container, "t1"), "Escape");
    expect(p.onMove).not.toHaveBeenCalled();
    expect(columnOf(cardEl(container, "t1"))).toBe("todo");
    expect(cardEl(container, "t1").dataset.held).toBeUndefined();
    expect(live().textContent).toBe("已取消，放回「待处理」第 1 项。");
  });

  it("a drop where the card started calls nothing", () => {
    const { container, p } = board();
    const t1 = cardEl(container, "t1");
    t1.focus();
    key(t1, " ");
    key(cardEl(container, "t1"), " ");
    expect(p.onMove).not.toHaveBeenCalled();
  });

  it("locked column shows its hint and still calls onMove", () => {
    const { container, p } = board();
    const t5 = cardEl(container, "t5");
    t5.focus();
    key(t5, " ");
    expect(screen.queryByText(HINT)).toBeNull();
    key(cardEl(container, "t5"), "ArrowRight");
    const held = cardEl(container, "t5");
    expect(columnOf(held)).toBe("review");
    const hint = held.querySelector('[data-part="board-card-hint"]');
    expect(hint?.textContent).toBe(HINT);
    expect(live().textContent).toContain("「待审批」已锁定。");
    expect(live().textContent).toContain(HINT);
    key(held, " ");
    expect(p.onMove).toHaveBeenCalledWith("t5", "review", 1);
    expect(screen.queryByText(HINT, { selector: '[data-part="board-card-hint"]' })).toBeNull();
  });

  it("rejected move snaps back", async () => {
    let reject: (e: Error) => void = () => {};
    const onMove = vi.fn(
      () =>
        new Promise<void>((_, rj) => {
          reject = rj;
        }),
    );
    const { container } = board({ onMove });
    const t1 = cardEl(container, "t1");
    t1.focus();
    key(t1, " ");
    key(cardEl(container, "t1"), "ArrowRight");
    key(cardEl(container, "t1"), " ");
    expect(onMove).toHaveBeenCalledWith("t1", "doing", 0);
    // the card stays where it was dropped while the promise is pending
    expect(columnOf(cardEl(container, "t1"))).toBe("doing");
    await act(async () => {
      reject(new Error("refused"));
    });
    expect(columnOf(cardEl(container, "t1"))).toBe("todo");
  });

  it("a resolved move keeps the card until the cards change", async () => {
    let resolve: () => void = () => {};
    const onMove = vi.fn(
      () =>
        new Promise<void>((rs) => {
          resolve = rs;
        }),
    );
    const p = props({ onMove });
    const { container, rerender } = render(
      <DesignProvider locale="zh">
        <Board {...p} />
      </DesignProvider>,
    );
    const t1 = cardEl(container, "t1");
    t1.focus();
    key(t1, " ");
    key(cardEl(container, "t1"), "ArrowRight");
    key(cardEl(container, "t1"), " ");
    await act(async () => resolve());
    expect(columnOf(cardEl(container, "t1"))).toBe("doing");
    const next = CARDS.map((c) => (c.id === "t1" ? { ...c, columnId: "doing" } : c));
    rerender(
      <DesignProvider locale="zh">
        <Board {...p} cards={next} />
      </DesignProvider>,
    );
    expect(columnOf(cardEl(container, "t1"))).toBe("doing");
  });

  it("canMove false refuses the drop", () => {
    const canMove = vi.fn((_: Task, to: string) => to !== "done");
    const { container, p } = board({ canMove });
    const t1 = cardEl(container, "t1");
    t1.focus();
    key(t1, " ");
    key(cardEl(container, "t1"), "ArrowRight");
    key(cardEl(container, "t1"), "ArrowRight");
    key(cardEl(container, "t1"), "ArrowRight");
    const held = cardEl(container, "t1");
    expect(columnOf(held)).toBe("done");
    expect((held.closest('[data-part="board-column"]') as HTMLElement).dataset.over).toBe(
      "refused",
    );
    key(held, " ");
    expect(p.onMove).not.toHaveBeenCalled();
    expect(columnOf(cardEl(container, "t1"))).toBe("todo");
    expect(live().textContent).toBe("不能移到「已完成」，已放回。");
  });

  it("announces pick/move/drop in a live region", () => {
    const { container } = board();
    expect(live().getAttribute("role")).toBe("status");
    expect(live().getAttribute("aria-live")).toBe("polite");
    const t1 = cardEl(container, "t1");
    // the card says how to move it
    const described = t1.getAttribute("aria-describedby");
    expect(described && document.getElementById(described)?.textContent).toContain("按空格拿起");
    t1.focus();
    key(t1, " ");
    expect(live().textContent).toBe("已拿起，在「待处理」第 1 项。");
    key(cardEl(container, "t1"), "ArrowRight");
    expect(live().textContent).toBe("「进行中」第 1 项");
    key(cardEl(container, "t1"), " ");
    expect(live().textContent).toBe("已移到「进行中」第 1 项。");
  });

  it("Tab while holding cancels the move", () => {
    const { container, p } = board();
    const t1 = cardEl(container, "t1");
    t1.focus();
    key(t1, " ");
    key(cardEl(container, "t1"), "ArrowRight");
    key(cardEl(container, "t1"), "Tab");
    expect(columnOf(cardEl(container, "t1"))).toBe("todo");
    expect(p.onMove).not.toHaveBeenCalled();
  });

  it("wide: every card is a drag handle (pointer drag)", () => {
    const { container } = board();
    expect(container.querySelectorAll("[data-drag-handle]")).toHaveLength(CARDS.length);
  });

  it("compact: no drag handles, Move to menu lists other columns", async () => {
    const p = props();
    const { container } = renderAtClass(390, <Board {...p} />);
    expect(container.querySelector("[data-drag-handle]")).toBeNull();
    expect(container.querySelector('[data-part="board"]')?.getAttribute("data-form")).toBe(
      "compact",
    );
    const t1 = cardEl(container, "t1");
    const move = within(t1).getByRole("button", { name: "移动到…" });
    await userEvent.click(move);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent?.replace(HINT, ""))).toEqual([
      "进行中",
      "待审批",
      "已完成",
    ]);
    await userEvent.click(items[2] as HTMLElement);
    expect(p.onMove).toHaveBeenCalledWith("t1", "done", 0);
  });

  it("compact: a column canMove refuses is disabled in the menu", async () => {
    const p = props({ canMove: (_, to) => to !== "doing" });
    const { container } = renderAtClass(390, <Board {...p} />);
    await userEvent.click(within(cardEl(container, "t1")).getByRole("button", { name: "移动到…" }));
    const doing = await screen.findByRole("menuitem", { name: "进行中" });
    expect(doing.getAttribute("aria-disabled")).toBe("true");
  });

  it("renders 500 cards without layout thrash", () => {
    const many: Task[] = Array.from({ length: 500 }, (_, i) => ({
      id: `c${i}`,
      columnId: COLUMNS[i % 4]?.id ?? "todo",
      title: `任务 ${i}`,
      meta: "",
    }));
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const renderCard = vi.fn((c: Task) => <span>{c.title}</span>);
    const { container } = board({ cards: many, renderCard });
    expect(container.querySelectorAll('[data-part="board-card"]')).toHaveLength(500);
    // one render: each card's content drawn once, no layout read before a drag
    expect(renderCard).toHaveBeenCalledTimes(500);
    expect(rect).not.toHaveBeenCalled();
  });

  it("loading: real heads and skeleton cards in one busy region", () => {
    const { container } = board({ cards: [], loading: true, empty: <p>空</p> });
    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(screen.queryByText("空")).toBeNull();
    expect(container.querySelectorAll('[data-part="board-column-title"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-part="skeleton-box"]')).toHaveLength(7);
    expect(container.querySelector('[data-part="board-card"]')).toBeNull();
  });

  it("empty: the caller's empty state in place of the columns", () => {
    const { container } = board({ cards: [], empty: <p>还没有任务</p> });
    expect(screen.getByText("还没有任务")).toBeTruthy();
    expect(container.querySelector('[data-part="board-column"]')).toBeNull();
  });
});
