import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionSheet,
  Button,
  DangerConfirm,
  DesignProvider,
  Dialog,
  Input,
  OVERLAY_HISTORY_MARKER,
} from "../src/index";
import { css, parseCss } from "./css-rules";
import { renderAtClass } from "./width";

// Dialogs on compact (interaction model spec §2.2, §2.4, D1): what is a centred Dialog from 600 up
// is a bottom sheet below 600 (the §6.59 sheet: handle, centred title, round close, body), the
// footer's buttons full width with the primary on top; DangerConfirm keeps its typed name; the
// system back closes it (one history entry on a compact touch window).

type Win = { width: number; coarse: boolean };
/** A `matchMedia` stand-in for a window `width` wide with a coarse or a fine pointer. */
function stubWindow(start: Win) {
  const w = { ...start };
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (q: string) => {
    const one = (s: string) => {
      const t = s.trim();
      if (t === "(pointer: coarse)") return w.coarse;
      if (t === "(any-pointer: coarse)") return w.coarse;
      if (t === "(any-pointer: fine)") return !w.coarse;
      const max = /^\(max-width:\s*(\d+)px\)$/.exec(t);
      if (max) return w.width <= Number(max[1]);
      const min = /^\(min-width:\s*(\d+)px\)$/.exec(t);
      if (min) return w.width >= Number(min[1]);
      return false;
    };
    // "a, b and (not c)": the touch query; evaluate its three features by hand.
    const matches = q.includes("not (any-pointer: fine)") ? w.coarse : q.split(",").some(one);
    return {
      matches,
      media: q,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
  });
  return {
    /** Resizes the window and notifies every query's listeners. */
    resize(width: number) {
      w.width = width;
      for (const fn of [...listeners]) fn();
    },
  };
}

const markerOf = () => (history.state as Record<string, unknown> | null)?.[OVERLAY_HISTORY_MARKER];
/** The marker in the state a `pushState` call pushed. */
const markerIn = (call: unknown[] | undefined) =>
  (call?.[0] as Record<string, unknown> | undefined)?.[OVERLAY_HISTORY_MARKER];
const settled = () => new Promise<void>((r) => setTimeout(r, 0));
const sheet = () => document.querySelector<HTMLElement>('[data-part="dialog-sheet"]');

let win: ReturnType<typeof stubWindow>;
beforeEach(() => {
  win = stubWindow({ width: 390, coarse: true });
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Rename({ withField = false }: { withField?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <DesignProvider locale="zh">
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="重命名"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary">保存</Button>
          </>
        }
      >
        {withField ? <Input aria-label="名称" defaultValue="研究助手" /> : <p>正文</p>}
      </Dialog>
    </DesignProvider>
  );
}

function Delete({ onConfirm = () => {} }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <DesignProvider locale="zh">
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <DangerConfirm
        open={open}
        onOpenChange={setOpen}
        title={"删除 “研究助手”？"}
        description="删除后无法恢复。"
        confirmName="研究助手"
        confirmLabel="删除"
        onConfirm={onConfirm}
      />
    </DesignProvider>
  );
}

describe("Dialog on compact (390)", () => {
  it("renders as a bottom sheet with the sheet head", async () => {
    render(<Rename />);
    await userEvent.click(screen.getByText("open"));
    const s = sheet();
    expect(s).not.toBeNull();
    expect(s?.getAttribute("role")).toBe("dialog");
    expect(document.querySelector(".cb-dialog")).toBeNull();
    const head = s?.querySelector('[data-part="sheet-head"]');
    expect(head?.querySelector(".cb-bsheet-title")?.textContent).toBe("重命名");
    expect(head?.querySelector('[data-part="sheet-close"]')?.getAttribute("aria-label")).toBe(
      "关闭",
    );
    expect(s?.querySelector('[data-part="sheet-handle"]')).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "重命名" })).toBe(s);
    // the body scrolls in the sheet's body; the footer stays under it, outside the scroller
    const body = s?.querySelector('[data-part="bsheet-body"]');
    expect(body?.textContent).toContain("正文");
    expect(body?.textContent).not.toContain("保存");
    const foot = s?.querySelector('[data-part="bsheet-foot"]');
    expect(foot?.previousElementSibling).toBe(body);
    // drawn primary first, so the tab order is the visual order (primary on top)
    expect(Array.from(foot?.querySelectorAll("button") ?? []).map((b) => b.textContent)).toEqual([
      "保存",
      "取消",
    ]);
  });

  it("starts on the close even with a field, quietly after a pointer, and hands focus back", async () => {
    render(<Rename withField />);
    const trigger = screen.getByText("open");
    await userEvent.click(trigger);
    const close = screen.getByRole("button", { name: "关闭" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(close.getAttribute("data-quiet-focus")).toBe("true");
    await userEvent.click(screen.getByText("取消"));
    await waitFor(() => expect(sheet()).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("starts on the close when it asks for no input", async () => {
    render(<Rename />);
    await userEvent.click(screen.getByText("open"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" })),
    );
  });

  it("stacks the footer's buttons full width in a non-scrolling foot (CSS)", () => {
    const rules = parseCss(css("overlays.css"));
    const foot = rules.find((r) => r.at === null && r.selector === ".cb-dialog-sheet-foot");
    expect(foot?.decls["flex-direction"]).toBe("column");
    const sheetRules = parseCss(css("conversation-page.css"));
    const bfoot = sheetRules.find((r) => r.at === null && r.selector === ".cb-bsheet-foot");
    expect(bfoot?.decls.flex).toBe("none");
    expect(bfoot?.decls.padding).toContain("var(--cb-inset-bottom)");
    const bodyAbove = sheetRules.find(
      (r) => r.at === null && r.selector === ".cb-bsheet-body:has(+ .cb-bsheet-foot)",
    );
    expect(bodyAbove?.decls["padding-bottom"]).toBe("var(--cb-space-2)");
    const btn = rules.find(
      (r) => r.at === null && r.selector === ".cb-dialog-sheet-foot > .cb-btn",
    );
    expect(btn?.decls.width).toBe("100%");
  });
});

/** A row whose action sheet's delete item opens the confirmation. */
function Row() {
  const [actions, setActions] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <DesignProvider locale="zh">
      <button type="button" onClick={() => setActions(true)}>
        row
      </button>
      <ActionSheet
        open={actions}
        onOpenChange={setActions}
        title="研究助手"
        items={[{ label: "删除", danger: true, onSelect: () => setConfirm(true) }]}
      />
      <DangerConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title={"删除 “研究助手”？"}
        description="删除后无法恢复。"
        confirmName="研究助手"
        confirmLabel="删除"
        onConfirm={() => {}}
      />
    </DesignProvider>
  );
}

/** A dangerous dialog whose Cancel is disabled at open (an action in flight) while its primary is not. */
function CancelBusy() {
  return (
    <DesignProvider locale="zh">
      <Dialog
        open
        onOpenChange={() => {}}
        title="删除"
        danger
        initialFocus="cancel"
        footer={
          <>
            <Button variant="ghost" disabled>
              取消
            </Button>
            <Button variant="danger-solid">删除</Button>
          </>
        }
      >
        <p>正文</p>
      </Dialog>
    </DesignProvider>
  );
}

describe("a dangerous dialog whose Cancel is disabled", () => {
  it("never starts on the destructive button on compact (the close instead)", async () => {
    render(<CancelBusy />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" })),
    );
  });

  it("never starts on the destructive button from 600 up", async () => {
    win.resize(1440);
    render(<CancelBusy />);
    await waitFor(() => expect(document.querySelector(".cb-dialog")).not.toBeNull());
    expect(document.activeElement?.textContent).not.toBe("删除");
  });
});

describe("DangerConfirm on compact (390)", () => {
  it("puts the fail button full width above 取消", async () => {
    render(<Delete />);
    await userEvent.click(screen.getByText("open"));
    const s = sheet();
    expect(s?.querySelector(".cb-dialog-sheet")?.getAttribute("data-danger")).toBe("true");
    expect(s?.querySelector(".cb-bsheet-title")?.textContent).toBe("删除 “研究助手”？");
    const foot = s?.querySelector(".cb-dialog-sheet-foot");
    const buttons = Array.from(foot?.querySelectorAll("button") ?? []).map((b) => [
      b.textContent,
      b.getAttribute("data-variant"),
    ]);
    // the destructive one first (on top), then cancel: DOM order is the visual order
    expect(buttons).toEqual([
      ["删除", "danger"],
      ["取消", "ghost"],
    ]);
    // one sentence of consequence, named as the sheet's description
    const desc = screen.getByText("删除后无法恢复。");
    expect(s?.getAttribute("aria-describedby")).toBe(desc.id);
  });

  it("still requires the typed name, and starts quietly on 取消", async () => {
    const onConfirm = vi.fn();
    render(<Delete onConfirm={onConfirm} />);
    await userEvent.click(screen.getByText("open"));
    const cancel = screen.getByRole("button", { name: "取消" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(cancel.getAttribute("data-quiet-focus")).toBe("true");
    const confirm = screen.getByRole<HTMLButtonElement>("button", { name: "删除" });
    expect(confirm.disabled).toBe(true);
    await userEvent.type(screen.getByRole("textbox"), "研究");
    expect(confirm.disabled).toBe(true);
    await userEvent.type(screen.getByRole("textbox"), "助手");
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute("data-variant")).toBe("danger-solid");
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("back closes it, and a close of its own leaves no entry", async () => {
    render(<Delete />);
    const push = vi.spyOn(history, "pushState");
    await userEvent.click(screen.getByText("open"));
    expect(push).toHaveBeenCalledTimes(1);
    expect(typeof markerOf()).toBe("string");
    act(() => history.back());
    await waitFor(() => expect(sheet()).toBeNull());
    await settled();
    expect(markerOf()).toBeUndefined();
    // reopened and cancelled: its entry is popped once
    await userEvent.click(screen.getByText("open"));
    expect(typeof markerOf()).toBe("string");
    const back = vi.spyOn(history, "back");
    await userEvent.click(screen.getByText("取消"));
    await waitFor(() => expect(sheet()).toBeNull());
    await waitFor(() => expect(markerOf()).toBeUndefined());
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("unmounting while open pops its entry", async () => {
    const { unmount } = render(<Delete />);
    await userEvent.click(screen.getByText("open"));
    expect(typeof markerOf()).toBe("string");
    unmount();
    await waitFor(() => expect(markerOf()).toBeUndefined());
  });

  it("opened from an action sheet's pick replaces it: one overlay, one entry", async () => {
    render(<Row />);
    const push = vi.spyOn(history, "pushState");
    await userEvent.click(screen.getByText("row"));
    expect(push).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(sheet()).not.toBeNull());
    await settled();
    await settled();
    expect(document.querySelector('[data-part="action-sheet"]')).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    // the action sheet's entry was popped before the confirmation pushed its own: the current
    // entry is the confirmation's
    expect(push).toHaveBeenCalledTimes(2);
    const confirmEntry = markerIn(push.mock.calls[1]);
    expect(markerOf()).toBe(confirmEntry);
    act(() => history.back());
    await waitFor(() => expect(sheet()).toBeNull());
    await settled();
    expect(markerOf()).toBeUndefined();
  });

  it("waits for the action sheet's pop to land before it pushes its own entry", async () => {
    // A browser runs history.back() as a later traversal; a push made before it lands is the
    // entry that traversal pops. The back is held here until the confirmation has opened.
    render(<Row />);
    await userEvent.click(screen.getByText("row"));
    const realBack = history.back.bind(history);
    const held: (() => void)[] = [];
    vi.spyOn(history, "back").mockImplementation(() => held.push(realBack));
    const push = vi.spyOn(history, "pushState");
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(sheet()).not.toBeNull());
    await settled();
    expect(held).toHaveLength(1);
    expect(push).not.toHaveBeenCalled();
    act(() => held[0]?.());
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const confirmEntry = markerIn(push.mock.calls[0]);
    expect(markerOf()).toBe(confirmEntry);
    vi.mocked(history.back).mockRestore();
    act(() => history.back());
    await waitFor(() => expect(sheet()).toBeNull());
  });
});

describe("Dialog across 600 while open", () => {
  it("swaps forms with the caller's state, one history entry and focus inside", async () => {
    render(<Delete />);
    await userEvent.click(screen.getByText("open"));
    await userEvent.type(screen.getByRole("textbox"), "研究");
    expect(typeof markerOf()).toBe("string");
    // to 1440: the centred dialog, the sheet's entry popped
    act(() => win.resize(1440));
    await waitFor(() => expect(document.querySelector(".cb-dialog")).not.toBeNull());
    expect(sheet()).toBeNull();
    await waitFor(() => expect(markerOf()).toBeUndefined());
    await waitFor(() =>
      expect(document.querySelector(".cb-dialog")?.contains(document.activeElement)).toBe(true),
    );
    expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("研究");
    // back to 390: the sheet again, holding one entry
    act(() => win.resize(390));
    await waitFor(() => expect(sheet()).not.toBeNull());
    await waitFor(() => expect(typeof markerOf()).toBe("string"));
    await waitFor(() => expect(sheet()?.contains(document.activeElement)).toBe(true));
    expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("研究");
    act(() => history.back());
    await waitFor(() => expect(sheet()).toBeNull());
    await settled();
    expect(markerOf()).toBeUndefined();
  });
});

describe("Dialog from 600 up", () => {
  it("stays the centred dialog at 1440", () => {
    const { container } = renderAtClass(
      1440,
      <Dialog open onOpenChange={() => {}} title="重命名" size={640} footer={<Button>保存</Button>}>
        <p>正文</p>
      </Dialog>,
    );
    const dialog = document.querySelector(".cb-dialog");
    expect(dialog?.getAttribute("data-size")).toBe("640");
    expect(dialog?.querySelector(".cb-dialog-title")?.textContent).toBe("重命名");
    expect(dialog?.querySelector(".cb-dialog-foot")?.textContent).toBe("保存");
    expect(sheet()).toBeNull();
    expect(document.querySelector('[data-part="sheet-head"]')).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    container.remove();
  });

  it("an open dialog hydrated at 390 draws one sheet", () => {
    const { container } = renderAtClass(
      390,
      <Dialog open onOpenChange={() => {}} title="重命名" footer={<Button>保存</Button>}>
        <p>正文</p>
      </Dialog>,
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(sheet()).not.toBeNull();
    expect(document.querySelector(".cb-dialog")).toBeNull();
    container.remove();
  });
});
