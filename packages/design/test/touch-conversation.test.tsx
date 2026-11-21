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
  it("the composer pill is composer high; its radius is half that, so a grown box is no oval", () => {
    const pill = touch(".cb-composer::before");
    expect(pill["min-height"]).toBe("var(--cb-touch-composer)");
    expect(pill["border-radius"]).toBe("calc(var(--cb-touch-composer) / 2)");
  });

  it("＋ and send sit at the bottom of a grown composer, centred on its last line (T27 review)", () => {
    const attach = touch(".cb-composer-bar > .cb-icon-btn:first-child");
    const send = touch(".cb-composer-bar > .cb-send.cb-btn");
    expect(attach["align-self"]).toBe("end");
    expect(attach["margin-block-end"]).toBe(
      "calc((var(--cb-touch-composer) - var(--cb-touch-hit)) / 2)",
    );
    expect(send["align-self"]).toBe("end");
    expect(send["margin-block-end"]).toBe(
      "calc((var(--cb-touch-composer) - var(--cb-touch-float)) / 2)",
    );
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
    const labels = [...bar.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? "",
    );
    expect(labels.filter((l) => /voice|dictat|speech|语音|麦克风|听写/i.test(l))).toEqual([]);
    // the pill's own buttons: attach first, send last
    expect(labels[0]).toBe("添加附件");
    expect(labels.at(-1)).toBe("发送");
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

describe("outside touch the composer and thread keep their base rules", () => {
  const base = (sel: string) => rules.find((r) => r.at === null && r.selector === sel)?.decls;
  it("the frame is still a column box with its border, radius and shadow", () => {
    expect(base(".cb-composer")).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      border: "1px solid var(--cb-line)",
      "border-radius": "var(--cb-radius-md)",
      "box-shadow": "var(--cb-shadow-float)",
    });
    expect(base(".cb-composer-bar")).toMatchObject({ display: "flex" });
    expect(
      rules.some(
        (r) =>
          r.at === null && r.selector === ".cb-conv-composer" && r.decls.position === "relative",
      ),
    ).toBe(true);
    expect(base(".cb-hcard-actions")?.["flex-wrap"]).toBe("wrap");
  });
  it("no touch rule sits outside the one touch block, and every ::before / grid rule is inside it", () => {
    const grid = rules.filter(
      (r) => r.at !== TOUCH_QUERY && r.selector.startsWith(".cb-composer") && r.decls["grid-row"],
    );
    expect(grid).toEqual([]);
  });
  it("the DOM order of the composer bar is the same", () => {
    wrap(box());
    const bar = document.querySelector('[data-part="composer-bar"]') as HTMLElement;
    const first = bar.firstElementChild as HTMLElement;
    expect(first.getAttribute("aria-label")).toBe("添加附件");
    expect(bar.lastElementChild?.className).toContain("cb-send");
  });
});

describe("the tool group on touch", () => {
  it("the summary line is hit high, full width, one line", () => {
    expect(touch(".cb-tool-group > .cb-tool-line")["min-height"]).toBe("var(--cb-touch-hit)");
    expect(touch(".cb-tool-group > .cb-tool-line")).toMatchObject({ width: "100%" });
    expect(touch(".cb-tool-group > .cb-tool-line > .cb-tool-label")).toMatchObject({
      flex: "1 1 auto",
    });
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

  it("with three scopes the card stays 拒绝, the wider grants, then 批准 last, in one row", () => {
    touchDevice();
    wrap(<ApprovalBlock {...approval} scopes={["once", "session", "always"]} />);
    expect(names()).toEqual(["拒绝", "本会话内都批准", "总是批准", "批准"]);
    expect(screen.getByRole("button", { name: "批准" }).getAttribute("data-variant")).toBe(
      "primary",
    );
    // every button has flex-basis 0 and may shrink: they cannot wrap to a second row
    expect(touch(".cb-hcard-actions > .cb-btn")).toMatchObject({ flex: "1 1 0", "min-width": "0" });
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
