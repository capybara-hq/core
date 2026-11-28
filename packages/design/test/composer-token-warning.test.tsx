import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerBox,
  type ComposerBoxProps,
  type ComposerEditorHandle,
  type ComposerSegment,
  DesignProvider,
  segmentsPlainText,
} from "../src/index";
import { findNestedBoxes } from "../src/reference/index";
import { composerText, draftText, focusEnd, select, typeText } from "./composer-editor-helpers";

// Setup guides v2 spec §12.1: the composer warns, in the browser and before sending, when the draft
// holds token-like text; a non-blocking warning with 移除 / 仍然发送, and a second ↵ also sends.
// The draft is the inline token editor's (composer inline tokens spec §2): typed and pasted text.

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
  const [segments, setSegments] = useState<ComposerSegment[]>(initial === "" ? [] : [initial]);
  const submit = () => {
    sent(segmentsPlainText(segments));
    setSegments([]);
  };
  return (
    <ComposerBox
      segments={segments}
      onChange={setSegments}
      onSubmit={submit}
      placeholder="Message"
      onAttach={noop}
      pickers={{ model: { label: "Model", value: "opus", groups: [], onPick: noop } }}
      send={{ mode: "send", disabled: segments.length === 0, onClick: submit }}
      {...over}
    />
  );
}

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);
const warning = () => screen.queryByRole("status");

/** A paste of plain text at the caret (the editor inserts it and reports the raw text). */
async function paste(text: string) {
  focusEnd();
  await act(async () => {
    fireEvent.paste(composerText(), {
      clipboardData: {
        files: [],
        types: ["text/plain"],
        getData: (k: string) => (k === "text/plain" ? text : ""),
      },
    });
  });
}

async function enter(init: Record<string, unknown> = {}) {
  await act(async () => {
    fireEvent.keyDown(composerText(), { key: "Enter", ...init });
  });
}

describe("composer token warning", () => {
  it("paste shows the warn with the kind label", async () => {
    wrap(<Harness sent={noop} />);
    await paste(`bot token ${SLACK}`);
    expect(warning()?.textContent).toContain(
      "This looks like a secret or token (Slack token). Secrets belong in the setting's field",
    );
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send anyway" })).toBeTruthy();
  });

  it("says it in Chinese and names every kind once", async () => {
    wrap(<Harness sent={noop} />, "zh");
    await paste(`${SLACK} ${SLACK} xapp-1-A0123456789-abcdef`);
    expect(warning()?.textContent).toContain(
      "这段内容看起来像密钥或令牌（Slack 令牌、Slack 应用令牌）。密钥只应填在设置页的对应字段里",
    );
    expect(screen.getByRole("button", { name: "移除" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "仍然发送" })).toBeTruthy();
  });

  it("a paste of normal text shows nothing", async () => {
    wrap(<Harness sent={noop} />);
    await paste("see https://example.com/a/very/long/path/with/many/segments/0123456789");
    expect(warning()).toBeNull();
  });

  it("typed text is checked only on send", async () => {
    const sent = vi.fn();
    wrap(<Harness sent={sent} />);
    focusEnd();
    typeText(`token ${SLACK}`);
    expect(warning()).toBeNull();
    await enter();
    expect(sent).not.toHaveBeenCalled();
    expect(warning()).not.toBeNull();
  });

  it("Enter with a match shows the warn instead of sending", async () => {
    const sent = vi.fn();
    wrap(<Harness sent={sent} initial={`token ${SLACK}`} />);
    focusEnd();
    await enter();
    expect(sent).not.toHaveBeenCalled();
    expect(warning()).not.toBeNull();
    // the draft stays, without a newline
    expect(draftText()).toBe(`token ${SLACK}`);
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
    await paste(`token ${SLACK}`);
    await user.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(sent).toHaveBeenCalledWith(`token ${SLACK}`);
    expect(warning()).toBeNull();
  });

  it("仍然发送 uses onSubmit while the button is Stop", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    wrap(
      <Harness
        sent={noop}
        initial={`token ${SLACK}`}
        over={{ onSubmit, send: { mode: "stop", onClick: onStop } }}
      />,
    );
    focusEnd();
    await enter();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("second Enter sends", async () => {
    const sent = vi.fn();
    wrap(<Harness sent={sent} initial={`token ${SLACK}`} />);
    focusEnd();
    await enter();
    expect(sent).not.toHaveBeenCalled();
    await enter();
    expect(sent).toHaveBeenCalledWith(`token ${SLACK}`);
    expect(warning()).toBeNull();
  });

  it("Enter after a paste warning sends (the warning was already seen)", async () => {
    const sent = vi.fn();
    wrap(<Harness sent={sent} />);
    await paste(SLACK);
    expect(warning()).not.toBeNull();
    await enter();
    expect(sent).toHaveBeenCalledWith(SLACK);
  });

  it("Shift+Enter is a newline, never a send or a warning", async () => {
    const sent = vi.fn();
    wrap(<Harness sent={sent} initial={`token ${SLACK}`} />);
    focusEnd();
    await enter({ shiftKey: true });
    expect(sent).not.toHaveBeenCalled();
    expect(warning()).toBeNull();
  });

  it("移除 deletes the spans", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    wrap(<Harness sent={sent} />);
    await paste(`bot ${SLACK} and app xapp-1-A0123456789-abcdef done`);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(draftText()).toBe("bot  and app  done");
    expect(warning()).toBeNull();
    expect(sent).not.toHaveBeenCalled();
    // the text gets focus back (not a touch device)
    expect(document.activeElement).toBe(composerText());
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
      await paste(`bot ${SLACK}`);
      act(() => composerText().blur());
      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(draftText()).toBe("bot ");
      expect(document.activeElement).not.toBe(composerText());
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("editing away the match clears the warn", async () => {
    const ref = createRef<ComposerEditorHandle>();
    wrap(<Harness sent={noop} over={{ editorRef: ref }} />);
    await paste(`token ${SLACK}`);
    expect(warning()).not.toBeNull();
    act(() => ref.current?.replace(["token "]));
    expect(warning()).toBeNull();
  });

  it("editing that keeps a match keeps the warn", async () => {
    wrap(<Harness sent={noop} />);
    await paste(`token ${SLACK}`);
    select(0);
    typeText("my ");
    expect(draftText()).toBe(`my token ${SLACK}`);
    expect(warning()).not.toBeNull();
  });

  it("a match in the text between tokens is found, and 移除 keeps the tokens", async () => {
    const user = userEvent.setup();
    const slack = { kind: "connector" as const, id: "c", label: "Slack" };
    function WithToken() {
      const [segments, setSegments] = useState<ComposerSegment[]>([`a ${SLACK} `, slack, " b"]);
      return (
        <ComposerBox
          segments={segments}
          onChange={setSegments}
          onSubmit={noop}
          placeholder="Message"
          onAttach={noop}
          pickers={{ model: { label: "Model", value: "opus", groups: [], onPick: noop } }}
          send={{ mode: "send", onClick: noop }}
        />
      );
    }
    wrap(<WithToken />);
    focusEnd();
    await enter();
    expect(warning()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("img", { name: "Connector: Slack" })).toBeTruthy();
    expect(draftText()).toContain(" b");
    expect(draftText()).not.toContain("xoxb");
  });

  it("a draft without a match sends on the first Enter", async () => {
    const sent = vi.fn();
    wrap(
      <Harness sent={sent} initial="commit e8008def3c1b9a7f5e4d2c0b8a6f4e2d0c9b7a5f looks fine" />,
    );
    focusEnd();
    await enter();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(warning()).toBeNull();
  });

  it("the warning is the warn line in the composer, not a box in its box", async () => {
    wrap(<Harness sent={noop} />);
    await paste(SLACK);
    // the first thing in the field, the composer's box (spec §6.16.2)
    const callout = document.querySelector('[data-part="composer-field"] > [data-part="callout"]');
    expect(callout?.parentElement?.firstElementChild).toBe(callout);
    expect(callout?.getAttribute("data-framed")).toBe("false");
    expect(findNestedBoxes(document.body)).toEqual([]);
  });
});
