// The action sheet and long press (responsive system spec §2.4; plan T0.3, the minimal form of the
// compact drawer / conversations line), the scope chips, the list FAB and the list's day sections.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionSheet,
  actionSheetItems,
  DesignProvider,
  dayBucket,
  formatListTime,
  ListPage,
  type MenuItem,
  ScopeChips,
  useLongPress,
} from "../src/index";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

describe("actionSheetItems", () => {
  it("lists the primary first, flattens submenus and drops stray separators", () => {
    const run = () => {};
    expect(
      actionSheetItems({
        primary: { label: "开始会话", href: "/" },
        items: [
          "separator",
          { label: "语言", submenu: [{ label: "中文", onSelect: run }] },
          "separator",
          "separator",
          { label: "删除", danger: true, onSelect: run },
          "separator",
        ],
      }).map((i) => (i === "separator" ? "-" : i.label)),
    ).toEqual(["开始会话", "-", "中文", "-", "删除"]);
  });
});

function Sheet({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(true);
  return (
    <DesignProvider locale="zh">
      <ActionSheet open={open} onOpenChange={setOpen} title="部署失败排查" items={items} />
    </DesignProvider>
  );
}

describe("ActionSheet", () => {
  it("titles itself with the object, draws a danger item in fail and runs a pick after closing", async () => {
    const archive = vi.fn();
    render(
      <Sheet
        items={[
          { label: "归档", onSelect: archive },
          { label: "删除", danger: true, onSelect: () => {} },
        ]}
      />,
    );
    const sheet = document.querySelector('[data-part="action-sheet"]') as HTMLElement;
    expect(within(sheet).getByRole("heading").textContent).toBe("部署失败排查");
    expect(within(sheet).getByRole("button", { name: "删除" }).getAttribute("data-danger")).toBe(
      "true",
    );
    // the bottom sheet's shared parts (§6.59): rows in a SheetGroup
    expect(sheet.querySelectorAll(".cb-sheet-group .cb-sheet-row")).toHaveLength(2);
    await userEvent.click(within(sheet).getByRole("button", { name: "归档" }));
    await waitFor(() => expect(document.querySelector('[data-part="action-sheet"]')).toBeNull());
    await waitFor(() => expect(archive).toHaveBeenCalledOnce());
  });

  it("a link item is a link through the design link", () => {
    render(<Sheet items={[{ label: "设置", href: "/agents/a1" }]} />);
    expect(screen.getByRole("link", { name: "设置" }).getAttribute("href")).toBe("/agents/a1");
  });
});

function Pressable({ onLong, onClick }: { onLong(): void; onClick(): void }) {
  const press = useLongPress(onLong);
  return (
    <div {...press}>
      <button type="button" onClick={onClick}>
        行
      </button>
    </div>
  );
}

describe("useLongPress", () => {
  const touch = (type: string, el: Element, x = 10, y = 10) =>
    fireEvent(
      el,
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), {
        pointerType: "touch",
      }),
    );

  it("opens after 500 ms of a resting touch, and its release does not click", () => {
    vi.useFakeTimers();
    const onLong = vi.fn();
    const onClick = vi.fn();
    render(<Pressable onLong={onLong} onClick={onClick} />);
    const el = screen.getByRole("button");
    touch("pointerdown", el);
    act(() => vi.advanceTimersByTime(499));
    expect(onLong).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onLong).toHaveBeenCalledOnce();
    touch("pointerup", el);
    fireEvent.click(el);
    expect(onClick).not.toHaveBeenCalled();
    // the next tap clicks again
    touch("pointerdown", el);
    touch("pointerup", el);
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("a touch that moves more than 10 px is a scroll: no long press", () => {
    vi.useFakeTimers();
    const onLong = vi.fn();
    render(<Pressable onLong={onLong} onClick={() => {}} />);
    const el = screen.getByRole("button");
    touch("pointerdown", el, 10, 10);
    touch("pointermove", el, 10, 22);
    act(() => vi.advanceTimersByTime(600));
    expect(onLong).not.toHaveBeenCalled();
  });

  it("a context menu opens it and keeps the browser's menu away", () => {
    const onLong = vi.fn();
    render(<Pressable onLong={onLong} onClick={() => {}} />);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    fireEvent(screen.getByRole("button"), ev);
    expect(onLong).toHaveBeenCalledOnce();
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("ScopeChips", () => {
  it("is a single choice: the selected chip checked and in the tab order, arrows move it", async () => {
    const onChange = vi.fn();
    render(
      <DesignProvider locale="zh">
        <ScopeChips
          label="按智能体筛选"
          value="all"
          options={[
            { value: "all", label: "全部" },
            { value: "a1", label: "运维助手", avatar: null },
          ]}
          onChange={onChange}
        />
      </DesignProvider>,
    );
    const radios = within(screen.getByRole("radiogroup", { name: "按智能体筛选" })).getAllByRole(
      "radio",
    );
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1]);
    expect(radios[1]?.querySelector('[data-part="avatar"]')).not.toBeNull();
    fireEvent.keyDown(radios[0] as HTMLElement, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("a1");
  });
});

const listPage = () => (
  <DesignProvider locale="zh">
    <ListPage
      header={{
        path: [{ label: "acme" }, { label: "conversations" }],
        title: "会话",
        actions: [{ label: "新会话", variant: "primary", href: "/" }],
      }}
    >
      <p>rows</p>
    </ListPage>
  </DesignProvider>
);

describe("ListPage on compact", () => {
  it("the FAB is the head's own primary: one element in every render, restyled by CSS", () => {
    const html = renderToString(listPage());
    expect(html.match(/新会话/g)).toHaveLength(1);
    expect(html).toContain('data-fab="true"');
    for (const width of [390, 1440]) {
      window.matchMedia = matchMediaFor(width).matchMedia;
      const { unmount } = render(listPage());
      const links = screen.getAllByRole("link", { name: "新会话" });
      expect(links).toHaveLength(1);
      const link = links[0] as HTMLElement;
      expect(link.getAttribute("href")).toBe("/");
      expect(link.closest('[data-head-primary="true"]')).not.toBeNull();
      // the default plus is there for the compact form, the label stays the accessible name
      expect(link.querySelector('[data-implicit="true"] [data-icon="plus"]')).not.toBeNull();
      expect(link.querySelector(".cb-pageheader-primary-label")?.textContent).toBe("新会话");
      unmount();
    }
  });

  it("the CSS restyles the marked primary below 600 only", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/templates.css"), "utf8");
    const block = css.slice(css.indexOf("/* The list's floating action button"));
    expect(block).toContain("@media (max-width: 599px)");
    expect(block).toContain('.cb-template[data-fab="true"] [data-head-primary="true"] > .cb-btn');
    expect(block).toContain("position: fixed;");
    expect(block).toContain("width: var(--cb-touch-prominent);");
  });

  it("the scope draws chips", () => {
    render(
      <DesignProvider locale="zh">
        <ListPage
          header={{ path: [{ label: "acme" }], title: "会话" }}
          scope={{
            label: "按智能体筛选",
            value: "all",
            options: [{ value: "all", label: "全部" }],
            onChange() {},
          }}
        >
          <p>rows</p>
        </ListPage>
      </DesignProvider>,
    );
    expect(screen.getByRole("radiogroup", { name: "按智能体筛选" })).toBeTruthy();
    expect(
      document.querySelector('[data-template="ListPage"]')?.getAttribute("data-fab"),
    ).toBeNull();
  });

  it("an empty state with the primary takes it alone: no FAB", () => {
    render(
      <DesignProvider locale="zh">
        <ListPage
          header={{
            path: [{ label: "acme" }],
            title: "会话",
            actions: [{ label: "新会话", variant: "primary", href: "/" }],
          }}
          empty={{ text: "还没有会话", action: { label: "新会话", variant: "primary", href: "/" } }}
        />
      </DesignProvider>,
    );
    expect(
      document.querySelector('[data-template="ListPage"]')?.getAttribute("data-fab"),
    ).toBeNull();
    expect(document.querySelector('[data-head-primary="true"]')).toBeNull();
  });
});

describe("list times and day sections", () => {
  const now = new Date(2026, 10, 22, 15, 0).getTime();
  it("HH:mm today, 昨天, the weekday this week, MM-DD before, YYYY-MM-DD in another year", () => {
    const at = (d: number, h = 9, y = 2026, m = 10) => new Date(y, m, d, h, 5);
    expect(formatListTime(at(22, 9), "zh", now)).toBe("09:05");
    expect(formatListTime(at(21), "zh", now)).toBe("昨天");
    expect(formatListTime(at(21), "en", now)).toBe("Yesterday");
    expect(formatListTime(at(18), "zh", now)).toBe("周三");
    expect(formatListTime(at(10), "zh", now)).toBe("11-10");
    expect(formatListTime(at(10, 9, 2025), "zh", now)).toBe("2025-11-10");
    expect([22, 21, 18, 10].map((d) => dayBucket(at(d), now))).toEqual([
      "today",
      "yesterday",
      "week",
      "older",
    ]);
  });
});
