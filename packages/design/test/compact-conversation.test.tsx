// The conversation inside the chat-first compact shell (design spec §6.16.1 compact form, §4.6;
// mobile touch plan Task 27): the title bar joins the floating row (centre pill, one trailing
// overflow), the thread's bottom reserve follows the floating composer's measured height, and the
// composer's settings sheet closes on the system back first.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerBox,
  ConversationPage,
  type ConversationPageProps,
  DesignProvider,
  MOBILE_SIZE_QUERY,
  type PickerProps,
  TitleBar,
  type TitleBarProps,
} from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const noop = () => {};
const titleBar = (over: Partial<TitleBarProps> = {}): TitleBarProps => ({
  title: "沙箱内 pnpm 安装失败",
  untitled: "未命名会话 · 10-26 14:32",
  menu: [{ id: "rename", label: "重命名", icon: "square-pen", onSelect: noop }],
  properties: { pressed: false, onToggle: noop },
  panels: [{ id: "files", label: "文件", icon: "file-text", pressed: false, onOpen: noop }],
  ...over,
});

const rules = parseCss(css("conversation-page.css"));
const compact = (selector: string) =>
  Object.assign(
    {},
    ...rules
      .filter(
        (r) =>
          r.at === "not all and (min-width: 600px)" &&
          r.selector
            .split(",")
            .map((s) => s.trim())
            .includes(selector),
      )
      .map((r) => r.decls),
  ) as Record<string, string>;

describe("the compact title bar (inside the shell)", () => {
  it("one trailing overflow holds the properties toggle and every panel", async () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    render(
      <DesignProvider locale="zh">
        <TitleBar
          {...titleBar({
            properties: { pressed: false, onToggle },
            panels: [
              { id: "files", label: "文件", icon: "file-text", pressed: false, onOpen },
              { id: "map", label: "地图", icon: "gauge", pressed: false, onOpen: noop },
            ],
          })}
        />
      </DesignProvider>,
    );
    const overflow = document.querySelector('[data-part="title-overflow"]') as HTMLElement;
    await userEvent.click(within(overflow).getByRole("button", { name: "更多操作" }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["属性面板", "文件", "地图"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "文件" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("CSS: the bar floats after the menu button, the title is the pill, the icons fold away", () => {
    expect(compact(".cb-shell .cb-title-bar").position).toBe("absolute");
    expect(compact(".cb-shell .cb-title-bar").top).toBe("var(--cb-float-top)");
    expect(compact(".cb-shell .cb-title-bar > .cb-title-btn")["border-radius"]).toBe(
      "var(--cb-radius-pill)",
    );
    for (const hidden of [
      ".cb-shell .cb-title-bar > .cb-title-path",
      ".cb-shell .cb-title-bar > .cb-icon-btn",
      '.cb-shell .cb-title-bar[data-new="true"]',
    ]) {
      expect(compact(hidden).display, hidden).toBe("none");
    }
    expect(compact('.cb-shell .cb-title-overflow[data-form="float"]').display).toBe("contents");
    // the flat title bar's plain title and overflow are drawn only inside the desktop shell
    expect(compact('.cb-shell .cb-title-overflow[data-form="flat"]').display).toBeUndefined();
    expect(
      rules.find(
        (r) =>
          r.selector
            .split(",")
            .map((x) => x.trim())
            .includes(".cb-title-plain") &&
          r.at === null &&
          r.decls.display,
      )?.decls.display,
    ).toBe("none");
    // outside the shell, and above 600, the overflow is not drawn
    expect(
      rules.find(
        (r) =>
          r.selector
            .split(",")
            .map((x) => x.trim())
            .includes(".cb-title-overflow") && r.at === null,
      )?.decls.display,
    ).toBe("none");
    expect(compact('.cb-shell .cb-conv-scroll:not([data-center="true"])')["padding-top"]).toBe(
      "var(--cb-float-row)",
    );
  });
});

describe("the floating row's round buttons are one size (maintainer decision 2026-11-22)", () => {
  it("the trailing overflow is the row's float size, as the menu button and the pill", () => {
    const more = compact(".cb-shell .cb-title-overflow > .cb-icon-btn");
    const pill = compact(".cb-shell .cb-title-bar > .cb-title-btn");
    for (const prop of ["width", "height", "min-width", "min-height"]) {
      expect(more[prop], prop).toBe("var(--cb-float-size)");
    }
    expect(pill.height).toBe("var(--cb-float-size)");
    // the touch.hit floor of the title bar's buttons on a phone (the mobile sizes) loses to the
    // row's own size: the overflow's rule is more specific than `.cb-title-bar .cb-icon-btn`
    const floor = rules.find(
      (r) =>
        r.at === "not all and (min-width: 600px)" && r.selector === ".cb-title-bar .cb-icon-btn",
    );
    expect(floor?.decls["min-width"]).toBe("var(--cb-touch-hit)");
    // the leading button and the page's overflow follow the same size property (shell.css)
    const shell = parseCss(css("shell.css"));
    expect(shell.find((r) => r.selector === ".cb-floatbar .cb-icon-btn")?.decls.width).toBe(
      "var(--cb-float-size, var(--cb-control-prominent))",
    );
    const touch = parseCss(css("touch.css"));
    expect(
      touch.find((r) => r.at?.includes("pointer: coarse") && r.selector === ".cb-shell")?.decls[
        "--cb-float-size"
      ],
    ).toBe("var(--cb-touch-float)");
    expect(
      touch.find((r) => r.at?.includes("pointer: coarse") && r.selector === ".cb-float-btn")?.decls
        .width,
    ).toBe("var(--cb-touch-float)");
  });
});

const page = (over: Partial<ConversationPageProps> = {}): ConversationPageProps => ({
  titleBar: titleBar(),
  thread: <p>消息</p>,
  composer: <div data-testid="composer" />,
  status: { context: "c", version: "v" },
  right: "none",
  onCloseRight: noop,
  layout: "inline",
  ...over,
});

describe("the thread's bottom reserve follows the floating composer", () => {
  it("--cb-composer-h is the composer's measured height, kept current by a ResizeObserver", () => {
    let height = 120;
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: (entries: unknown[]) => void) {
          observers.push(() => cb([]));
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("cb-conv-composer")) return { height } as DOMRect;
      return real.call(this);
    });
    render(
      <DesignProvider locale="zh">
        <ConversationPage {...page()} />
      </DesignProvider>,
    );
    const center = document.querySelector(".cb-conv-composer")?.parentElement as HTMLElement;
    expect(center.style.getPropertyValue("--cb-composer-h")).toBe("120px");
    // the textarea grew to eight lines
    height = 268.4;
    act(() => {
      for (const o of observers) o();
    });
    expect(center.style.getPropertyValue("--cb-composer-h")).toBe("269px");
  });

  it("the touch padding uses the measured height (a one-line fallback before it)", () => {
    const pad = rules
      .filter(
        (r) =>
          r.at === MOBILE_SIZE_QUERY && r.selector === '.cb-conv-scroll:not([data-center="true"])',
      )
      .map((r) => r.decls["padding-bottom"])
      .join(" ")
      .replace(/\s+/g, "");
    expect(pad).toContain("var(--cb-composer-h,");
  });
});

describe("the composer's settings sheet joins the back handling (Decision 25)", () => {
  const picker = (label: string, value: string, items: string[]): PickerProps => ({
    label,
    value,
    groups: [{ items: items.map((l) => ({ id: l, label: l, checked: l === value })) }],
    onPick: noop,
  });
  /** A compact touch window. */
  function touchWindow() {
    const sized = matchMediaFor(390).matchMedia;
    vi.stubGlobal("matchMedia", (q: string) =>
      /pointer/.test(q)
        ? {
            matches: q !== "(any-pointer: fine)",
            media: q,
            addEventListener() {},
            removeEventListener() {},
          }
        : sized(q),
    );
  }

  it("opening pushes one entry; the system back closes the sheet and stays on the page", async () => {
    touchWindow();
    render(
      <DesignProvider locale="zh">
        <ComposerBox
          value=""
          onChange={noop}
          placeholder="p"
          onAttach={noop}
          pickers={{
            model: picker("模型", "DeepSeek", ["DeepSeek"]),
            effort: picker("思考档位", "中", ["低", "中", "高"]),
          }}
          send={{ mode: "send", onClick: noop }}
        />
      </DesignProvider>,
    );
    const length = window.history.length;
    const chip = document.querySelector('[data-part="composer-options"]') as HTMLElement;
    await userEvent.click(chip);
    const sheet = () => document.querySelector('[data-part="composer-options-sheet"]');
    expect(sheet()).not.toBeNull();
    expect(window.history.length).toBe(length + 1);
    act(() => window.history.back());
    await waitFor(() => expect(sheet()).toBeNull());
    expect(window.location.pathname).toBe("/");
  });
});
