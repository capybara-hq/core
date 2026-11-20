import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalBlock,
  type ApprovalBlockProps,
  ComposerBox,
  type ComposerBoxProps,
  DesignProvider,
  type NativeHandlers,
  type PickerProps,
  TOUCH_QUERY,
} from "../src/index";
import { css, parseCss } from "./css-rules";

// The conversation on touch (spec §6.16.2, §6.16.6, §6.16.8, §6.16.11; mobile touch plan Task 26):
// the floating composer pill (attach, input, send; no voice button), the settings chip and sheet,
// the user bubble at the end edge, the approval card's two 48 px buttons. Touch rules sit only
// under TOUCH_QUERY; the same components outside it keep their order and look.

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

/** A touch device: the primary pointer is coarse. */
function touchDevice() {
  window.matchMedia = ((q: string) => ({
    matches: q === "(pointer: coarse)",
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const rules = [...parseCss(css("conversation.css")), ...parseCss(css("conversation-page.css"))];
/** The declarations of `selector` under the touch query, merged in source order. */
function touch(selector: string): Record<string, string> {
  const hits = rules.filter(
    (r) =>
      r.at === TOUCH_QUERY &&
      r.selector
        .split(",")
        .map((s) => s.trim())
        .includes(selector),
  );
  if (hits.length === 0) throw new Error(`no touch rule for ${selector}`);
  return Object.assign({}, ...hits.map((r) => r.decls));
}

describe("touch rules (stylesheets)", () => {
  it("the composer pill is composer high and pill round", () => {
    const pill = touch(".cb-composer::before");
    expect(pill["min-height"]).toBe("var(--cb-touch-composer)");
    expect(pill["border-radius"]).toBe("var(--cb-radius-pill)");
  });

  it("send is a float-sized round accent button", () => {
    const send = touch(".cb-composer-bar > .cb-send.cb-btn");
    expect(send.width).toBe("var(--cb-touch-float)");
    expect(send.height).toBe("var(--cb-touch-float)");
    expect(send["border-radius"]).toBe("var(--cb-radius-pill)");
    expect(send.background).toBe("var(--cb-accent)");
  });

  it("the approval buttons are primary high", () => {
    expect(touch(".cb-hcard-actions > .cb-btn")["min-height"]).toBe("var(--cb-touch-primary)");
  });

  it("the user bubble sits at the end edge", () => {
    expect(touch(".cb-user-msg > .cb-bubble")["margin-inline-start"]).toBe("auto");
  });

  it("the thread clears the floating composer, which floats above the insets", () => {
    const composer = touch(".cb-conv-composer");
    expect(composer.position).toBe("absolute");
    expect(composer["padding-bottom"]).toContain("--cb-inset-bottom");
    expect(touch(".cb-conv-scroll")["padding-bottom"]).toContain("--cb-touch-composer");
    // the page lifts its column by the keyboard's height, once
    const page = rules.find((r) => r.at === null && r.selector === ".cb-conv-page");
    expect(page?.decls["padding-bottom"]).toContain("--cb-keyboard-inset");
    expect(touch('.cb-shell[data-keyboard="open"] .cb-conv-composer')["padding-bottom"]).toBe(
      "var(--cb-space-3)",
    );
  });

  it("the command is set in the code font", () => {
    const code = rules.find((r) => r.at === null && r.selector === ".cb-hcard-command");
    expect(code?.decls["font-family"]).toBe("var(--cb-font-code)");
  });
});

const noop = () => {};
const picker = (label: string, value: string, items: string[], onPick = noop): PickerProps => ({
  label,
  value,
  groups: [{ items: items.map((l) => ({ id: l, label: l, checked: l === value })) }],
  onPick,
});
const box = (over: Partial<ComposerBoxProps> = {}) => (
  <ComposerBox
    value=""
    onChange={noop}
    placeholder="p"
    onAttach={noop}
    pickers={{
      model: picker("模型", "DeepSeek", ["DeepSeek"]),
      effort: picker("思考档位", "中", ["低", "中", "高"]),
      device: picker("设备", "个人设备", ["个人设备"]),
    }}
    send={{ mode: "send", onClick: noop }}
    {...over}
  />
);
const wrap = (ui: React.ReactElement, native?: NativeHandlers) =>
  render(
    <DesignProvider locale="zh" {...(native ? { native } : {})}>
      {ui}
    </DesignProvider>,
  );

describe("the composer pill", () => {
  it("holds attach, the input and send; stop while running; no voice button", () => {
    touchDevice();
    wrap(box());
    const bar = document.querySelector('[data-part="composer-bar"]') as HTMLElement;
    expect(within(bar).getByRole("button", { name: "添加附件" })).toBeTruthy();
    expect(bar.querySelector(".cb-send")).not.toBeNull();
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
    expect(document.body.innerHTML).not.toMatch(/voice|语音|mic/i);
    cleanup();
    wrap(box({ send: { mode: "stop", onClick: noop } }));
    expect(document.querySelector(".cb-stop")).not.toBeNull();
    expect(document.querySelector(".cb-send")).toBeNull();
  });

  it("has no voice prop", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/conversation/composer.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/voice/i);
  });
});

describe("the settings chip and sheet", () => {
  it("opens the sheet, shows the note, and picking 高 calls onChange once and plays selection", async () => {
    touchDevice();
    const onPick = vi.fn();
    const haptics = vi.fn();
    wrap(
      box({
        pickers: {
          model: picker("模型", "DeepSeek", ["DeepSeek"]),
          effort: picker("思考档位", "中", ["低", "中", "高"], onPick),
          device: picker("设备", "个人设备", ["个人设备"]),
        },
      }),
      { haptics },
    );
    await userEvent.click(document.querySelector('[data-part="composer-options"]') as HTMLElement);
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("设置只对这次会话生效。")).toBeTruthy();
    await userEvent.click(within(sheet).getByRole("radio", { name: "高" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("高");
    expect(haptics).toHaveBeenCalledWith("selection");
    expect(haptics).toHaveBeenCalledTimes(1);
    // a segmented control, not a list of rows
    expect(sheet.querySelector('[data-part="segmented"]')).not.toBeNull();
  });

  it("outside touch the effort stays a list of options", async () => {
    wrap(box());
    await userEvent.click(document.querySelector('[data-part="composer-options"]') as HTMLElement);
    const sheet = screen.getByRole("dialog");
    expect(sheet.querySelector('[data-part="segmented"]')).toBeNull();
    expect(within(sheet).queryByText("设置只对这次会话生效。")).toBeNull();
  });
});

describe("the approval card on touch", () => {
  const approval: ApprovalBlockProps = {
    tool: "Acme",
    toolKey: "mcp__acme__send",
    input: { text: "x" },
    scopes: ["once"],
    state: { kind: "pending" },
    onApprove: noop,
    onDeny: noop,
  };
  const names = () =>
    [...document.querySelectorAll(".cb-hcard-actions button")].map((b) => b.textContent);

  it("renders 拒绝 before 批准, 批准 primary", () => {
    touchDevice();
    wrap(<ApprovalBlock {...approval} />);
    expect(names()).toEqual(["拒绝", "批准"]);
    const approve = screen.getByRole("button", { name: "批准" });
    expect(approve.getAttribute("data-variant")).toBe("primary");
  });

  it("keeps 批准 first outside touch", () => {
    wrap(<ApprovalBlock {...approval} />);
    expect(names()).toEqual(["批准", "拒绝…"]);
  });

  it("the command card sets its command in a font-code element", () => {
    touchDevice();
    wrap(
      <ApprovalBlock
        {...approval}
        command={{ kind: "command", command: "ls -la", reason: "list" }}
      />,
    );
    const el = document.querySelector(".cb-hcard-command") as HTMLElement;
    expect(el.textContent).toContain("ls -la");
  });
});
