import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type KeyboardEvent, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerBox, type ComposerBoxProps, DesignProvider } from "../src/index";
import { findNestedBoxes } from "../src/reference/index";

// Setup guides v2 spec §12.1: the composer warns, in the browser and before sending, when the draft
// holds token-like text; a non-blocking warning with 移除 / 仍然发送, and a second ↵ also sends.

afterEach(cleanup);

const noop = () => {};
const SLACK = "xoxb-123456789012-abcdefghij";
const originalMatchMedia = window.matchMedia;

type Over = Partial<ComposerBoxProps>;

/** A composer as ComposerBar wires it: ↵ (no Shift, no IME) calls `sent` with the draft. */
function Harness({
  initial = "",
  sent,
  over = {},
}: {
  initial?: string;
  sent(text: string): void;
  over?: Over;
}) {
  const [value, setValue] = useState(initial);
  const submit = () => {
    sent(value);
    setValue("");
  };
  return (
    <ComposerBox
      value={value}
      onChange={setValue}
      onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        submit();
      }}
      placeholder="Message"
      onAttach={noop}
      pickers={{ model: { label: "Model", value: "opus", groups: [], onPick: noop } }}
      send={{ mode: "send", disabled: value.trim() === "", onClick: submit }}
      {...over}
    />
  );
}

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);
const input = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const warning = () => screen.queryByRole("status");

function paste(text: string) {
  const el = input();
  el.focus();
  fireEvent.paste(el, { clipboardData: { getData: () => text } });
  fireEvent.change(el, { target: { value: el.value + text } });
}

describe("composer token warning", () => {
  it("paste shows the warn with the kind label", () => {
    wrap(<Harness sent={noop} />);
    paste(`bot token ${SLACK}`);
    expect(warning()?.textContent).toContain(
      "This looks like a secret or token (Slack token). Secrets belong in the setting's field",
    );
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send anyway" })).toBeTruthy();
  });

  it("says it in Chinese and names every kind once", () => {
    wrap(<Harness sent={noop} />, "zh");
    paste(`${SLACK} ${SLACK} xapp-1-A0123456789-abcdef`);
    expect(warning()?.textContent).toContain(
      "这段内容看起来像密钥或令牌（Slack 令牌、Slack 应用令牌）。密钥只应填在设置页的对应字段里",
    );
    expect(screen.getByRole("button", { name: "移除" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "仍然发送" })).toBeTruthy();
  });

  it("a paste of normal text shows nothing", () => {
    wrap(<Harness sent={noop} />);
    paste("see https://example.com/a/very/long/path/with/many/segments/0123456789");
    expect(warning()).toBeNull();
  });

  it("typed text is checked only on send", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(<Harness sent={sent} />);
    await user.click(input());
    await user.keyboard(`token ${SLACK}`);
    expect(warning()).toBeNull();
    await user.keyboard("{Enter}");
    expect(sent).not.toHaveBeenCalled();
    expect(warning()).not.toBeNull();
  });

  it("Enter with a match shows the warn instead of sending", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(<Harness sent={sent} initial={`token ${SLACK}`} />);
    await user.click(input());
    await user.keyboard("{Enter}");
    expect(sent).not.toHaveBeenCalled();
    expect(warning()).not.toBeNull();
    // the draft stays, without a newline
    expect(input().value).toBe(`token ${SLACK}`);
  });

  it("the send button with a match shows the warn instead of sending", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(<Harness sent={sent} initial={`token ${SLACK}`} />);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).not.toHaveBeenCalled();
    expect(warning()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toHaveBeenCalledWith(`token ${SLACK}`);
  });

  it("仍然发送 sends unchanged", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(<Harness sent={sent} />);
    paste(`token ${SLACK}`);
    await user.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(sent).toHaveBeenCalledWith(`token ${SLACK}`);
    expect(warning()).toBeNull();
  });

  it("仍然发送 uses onSend while the button is Stop", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onStop = vi.fn();
    wrap(
      <Harness
        sent={noop}
        initial={`token ${SLACK}`}
        over={{ onSend, send: { mode: "stop", onClick: onStop } }}
      />,
    );
    await user.click(input());
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("second Enter sends", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(<Harness sent={sent} initial={`token ${SLACK}`} />);
    await user.click(input());
    await user.keyboard("{Enter}");
    expect(sent).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(sent).toHaveBeenCalledWith(`token ${SLACK}`);
    expect(warning()).toBeNull();
  });

  it("Enter after a paste warning sends (the warning was already seen)", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(<Harness sent={sent} />);
    paste(SLACK);
    await user.keyboard("{Enter}");
    expect(sent).toHaveBeenCalledWith(SLACK);
  });

  it("Shift+Enter is a newline, never a send or a warning", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(<Harness sent={sent} initial={`token ${SLACK}`} />);
    await user.click(input());
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(sent).not.toHaveBeenCalled();
    expect(warning()).toBeNull();
  });

  it("移除 deletes the spans", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(<Harness sent={sent} />);
    paste(`bot ${SLACK} and app xapp-1-A0123456789-abcdef done`);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(input().value).toBe("bot  and app  done");
    expect(warning()).toBeNull();
    expect(sent).not.toHaveBeenCalled();
    // the text gets focus back (not a touch device)
    expect(document.activeElement).toBe(input());
  });

  it("移除 on a touch device leaves the keyboard down", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: noop,
      removeEventListener: noop,
    })) as unknown as typeof window.matchMedia;
    try {
      const user = userEvent.setup();
      wrap(<Harness sent={noop} />);
      paste(`bot ${SLACK}`);
      input().blur();
      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(input().value).toBe("bot ");
      expect(document.activeElement).not.toBe(input());
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("editing away the match clears the warn", () => {
    wrap(<Harness sent={noop} />);
    paste(`token ${SLACK}`);
    expect(warning()).not.toBeNull();
    fireEvent.change(input(), { target: { value: "token " } });
    expect(warning()).toBeNull();
  });

  it("editing that keeps a match keeps the warn", () => {
    wrap(<Harness sent={noop} />);
    paste(`token ${SLACK}`);
    fireEvent.change(input(), { target: { value: `my token ${SLACK}` } });
    expect(warning()).not.toBeNull();
  });

  it("a draft without a match sends on the first Enter", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(
      <Harness sent={sent} initial="commit e8008def3c1b9a7f5e4d2c0b8a6f4e2d0c9b7a5f looks fine" />,
    );
    await user.click(input());
    await user.keyboard("{Enter}");
    expect(sent).toHaveBeenCalledTimes(1);
    expect(warning()).toBeNull();
  });

  it("the warning is the warn line in the composer, not a box in its box", () => {
    wrap(<Harness sent={noop} />);
    paste(SLACK);
    const callout = document.querySelector('[data-part="composer"] > [data-part="callout"]');
    expect(callout?.getAttribute("data-framed")).toBe("false");
    expect(findNestedBoxes(document.body)).toEqual([]);
  });
});
