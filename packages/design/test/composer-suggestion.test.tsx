import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerBox,
  type ComposerBoxProps,
  type ComposerSegment,
  DesignProvider,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";
import { backspace, composerText, draftText, focusEnd, typeText } from "./composer-editor-helpers";

// The prompt suggestion in the composer (spec §6.16.2 state `suggestion`, prompt suggestions spec
// §5): the placeholder, Tab fills, Esc and typing dismiss, the touch button, no focus trap. The
// text box is the inline token editor (composer inline tokens spec §2).

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

const noop = () => {};
const IDLE = "Message, / for commands";
const TEXT = "Export the summary as CSV";

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const props = (over: Partial<ComposerBoxProps> = {}): ComposerBoxProps => ({
  segments: [],
  onChange: noop,
  onSubmit: noop,
  placeholder: IDLE,
  onAttach: noop,
  pickers: { model: { label: "Model", value: "opus 5.5", groups: [], onPick: noop } },
  send: { mode: "send", disabled: true, onClick: noop },
  ...over,
});

/** A composer that owns its draft and drops the suggestion once dismissed, as the web does. */
function Harness({
  onDismiss = noop,
  over = {},
}: {
  onDismiss?(): void;
  over?: Partial<ComposerBoxProps>;
}) {
  const [segments, setSegments] = useState<ComposerSegment[]>([]);
  const [shown, setShown] = useState(true);
  return (
    <ComposerBox
      {...props({
        segments,
        onChange: setSegments,
        ...(shown
          ? {
              suggestion: {
                text: TEXT,
                onDismiss: () => {
                  setShown(false);
                  onDismiss();
                },
              },
            }
          : {}),
        ...over,
      })}
    />
  );
}

const input = () => composerText();
const placeholderOf = () => input().getAttribute("aria-placeholder");

function touchPointer() {
  window.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    addEventListener: noop,
    removeEventListener: noop,
  })) as unknown as typeof window.matchMedia;
}

describe("ComposerBox suggestion: the placeholder", () => {
  it("is the suggestion text when the draft is empty, idle and has no chip", () => {
    wrap(<ComposerBox {...props({ suggestion: { text: TEXT, onDismiss: noop } })} />);
    expect(placeholderOf()).toBe(TEXT);
    expect(document.querySelector(".cb-composer-editor-placeholder")?.textContent).toBe(TEXT);
  });

  it("is not shown while the draft has text", () => {
    wrap(
      <ComposerBox {...props({ segments: ["hi"], suggestion: { text: TEXT, onDismiss: noop } })} />,
    );
    expect(placeholderOf()).toBe(IDLE);
    expect(input().hasAttribute("aria-describedby")).toBe(false);
  });

  it("gives way to the running hint", () => {
    wrap(
      <ComposerBox
        {...props({
          hint: "Messages sent while it works",
          suggestion: { text: TEXT, onDismiss: noop },
        })}
      />,
    );
    expect(placeholderOf()).toBe("Messages sent while it works");
  });

  it("gives way to a skill token", () => {
    wrap(
      <ComposerBox
        {...props({
          segments: [{ kind: "skill", id: "fix-issue", label: "/fix-issue" }, " "],
          skillHint: "[issue-number]",
          suggestion: { text: TEXT, onDismiss: noop },
        })}
      />,
    );
    expect(document.querySelector(".cb-composer-editor-hint")?.textContent).toBe("[issue-number]");
    expect(document.querySelector('[data-part="composer-suggestion-hint"]')).toBeNull();
    expect(document.querySelector(".cb-composer-editor-placeholder")).toBeNull();
  });

  it("describes the textarea with a hidden Tab hint only while shown, with no live region", () => {
    const { rerender } = wrap(
      <ComposerBox {...props({ suggestion: { text: TEXT, onDismiss: noop } })} />,
    );
    const id = input().getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const hint = document.getElementById(id as string);
    expect(hint?.getAttribute("data-part")).toBe("composer-suggestion-hint");
    expect(hint?.classList.contains("cb-sr-only")).toBe(true);
    expect(hint?.textContent).toBe("Press Tab to use the suggestion");
    expect(document.querySelector("[aria-live]")).toBeNull();
    rerender(
      <DesignProvider locale="en">
        <ComposerBox {...props()} />
      </DesignProvider>,
    );
    expect(input().hasAttribute("aria-describedby")).toBe(false);
    expect(document.querySelector('[data-part="composer-suggestion-hint"]')).toBeNull();
  });

  it("is one line with an ellipsis on a phone", () => {
    wrap(<ComposerBox {...props({ suggestion: { text: TEXT, onDismiss: noop } })} />);
    expect(input().closest('[data-part="composer-editor"]')?.getAttribute("data-suggestion")).toBe(
      "true",
    );
    const css = readFileSync(resolve(__dirname, "../src/styles/conversation-page.css"), "utf8");
    const phone = [...css.matchAll(/@media not all and \(min-width: 600px\) \{([\s\S]*?)\n\}/g)]
      .map((m) => m[1])
      .join("\n");
    const rule = phone.match(
      /\.cb-composer-editor\[data-suggestion="true"\] \.cb-composer-editor-placeholder \{([^}]*)\}/,
    )?.[1];
    expect(rule).toContain("white-space: nowrap");
    expect(rule).toContain("text-overflow: ellipsis");
  });

  it("speaks zh", () => {
    wrap(<ComposerBox {...props({ suggestion: { text: TEXT, onDismiss: noop } })} />, "zh");
    expect(document.querySelector('[data-part="composer-suggestion-hint"]')?.textContent).toBe(
      "按 Tab 使用建议",
    );
  });
});

describe("ComposerBox suggestion: keys", () => {
  it("Tab fills the draft, puts the caret at its end and dismisses", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    wrap(<Harness onDismiss={onDismiss} />);
    focusEnd();
    await user.keyboard("{Tab}");
    expect(draftText()).toBe(TEXT);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // focus stays in the text, the caret at the end
    expect(document.activeElement).toBe(input());
    typeText("!");
    expect(draftText()).toBe(`${TEXT}!`);
  });

  it("Tab with text in the draft is not intercepted", () => {
    const onChange = vi.fn();
    const onDismiss = vi.fn();
    wrap(
      <ComposerBox
        {...props({ segments: ["hi"], onChange, suggestion: { text: TEXT, onDismiss } })}
      />,
    );
    const ev = fireEvent.keyDown(input(), { key: "Tab" });
    expect(ev).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("Tab without a suggestion is not intercepted", () => {
    const onChange = vi.fn();
    wrap(<ComposerBox {...props({ onChange })} />);
    expect(fireEvent.keyDown(input(), { key: "Tab" })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Tab while the running hint shows is not intercepted", () => {
    const onChange = vi.fn();
    wrap(
      <ComposerBox
        {...props({ onChange, hint: "running", suggestion: { text: TEXT, onDismiss: noop } })}
      />,
    );
    expect(fireEvent.keyDown(input(), { key: "Tab" })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Shift+Tab and Tab with a modifier are never intercepted", () => {
    const onChange = vi.fn();
    const onDismiss = vi.fn();
    wrap(<ComposerBox {...props({ onChange, suggestion: { text: TEXT, onDismiss } })} />);
    expect(fireEvent.keyDown(input(), { key: "Tab", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: "Tab", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: "Tab", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: "Tab", metaKey: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("Shift+Tab moves focus backwards as usual", async () => {
    const user = userEvent.setup();
    wrap(
      <>
        <button type="button">before</button>
        <Harness />
      </>,
    );
    focusEnd();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("button", { name: "before" })).toBe(document.activeElement);
    expect(draftText()).toBe("");
  });

  it("Tab during IME composition is ignored", () => {
    const onChange = vi.fn();
    const onDismiss = vi.fn();
    wrap(<ComposerBox {...props({ onChange, suggestion: { text: TEXT, onDismiss } })} />);
    expect(fireEvent.keyDown(input(), { key: "Tab", isComposing: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("Esc dismisses it; Tab then moves focus as usual", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    wrap(
      <>
        <Harness onDismiss={onDismiss} />
        <button type="button">after</button>
      </>,
    );
    focusEnd();
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(placeholderOf()).toBe(IDLE);
    await user.keyboard("{Tab}");
    expect(draftText()).toBe("");
    expect(document.activeElement).not.toBe(input());
  });

  it("an open menu's keys come before the suggestion's Tab", () => {
    const onDismiss = vi.fn();
    const onKeyDown = vi.fn(() => true);
    wrap(
      <ComposerBox
        {...props({
          suggestion: { text: TEXT, onDismiss },
          menu: {
            combobox: { role: "combobox", "aria-expanded": true, "aria-autocomplete": "list" },
            onKeyDown,
          },
        })}
      />,
    );
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("ComposerBox suggestion: typing dismisses", () => {
  it("typing a character dismisses it for the run", async () => {
    const onDismiss = vi.fn();
    wrap(<Harness onDismiss={onDismiss} />);
    focusEnd();
    typeText("x");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(draftText()).toBe("x");
    // emptied again, the idle placeholder comes back, not the suggestion
    backspace();
    expect(draftText()).toBe("");
    expect(placeholderOf()).toBe(IDLE);
  });

  it("an edit that empties the draft does not dismiss", () => {
    const onDismiss = vi.fn();
    function Draft() {
      const [segments, setSegments] = useState<ComposerSegment[]>(["x"]);
      return (
        <ComposerBox
          {...props({ segments, onChange: setSegments, suggestion: { text: TEXT, onDismiss } })}
        />
      );
    }
    wrap(<Draft />);
    focusEnd();
    backspace();
    expect(draftText()).toBe("");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("a paste dismisses it", async () => {
    const onDismiss = vi.fn();
    wrap(<Harness onDismiss={onDismiss} />);
    focusEnd();
    await act(async () => {
      fireEvent.paste(input(), {
        clipboardData: { files: [], types: ["text/plain"], getData: () => "pasted" },
      });
    });
    expect(onDismiss).toHaveBeenCalled();
    expect(draftText()).toBe("pasted");
  });

  it("attaching a file dismisses it", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onAttach = vi.fn();
    wrap(<Harness onDismiss={onDismiss} over={{ onAttach }} />);
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ComposerBox suggestion: the touch button", () => {
  it("is absent with a fine pointer", () => {
    wrap(<ComposerBox {...props({ suggestion: { text: TEXT, onDismiss: noop } })} />);
    expect(document.querySelector('[data-part="composer-suggestion-use"]')).toBeNull();
  });

  it("on a touch device sits in the control row, outside the pill, and fills the draft without focusing it", async () => {
    touchPointer();
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    wrap(<Harness onDismiss={onDismiss} />);
    const button = screen.getByRole("button", { name: `Use suggestion: ${TEXT}` });
    expect(button.getAttribute("data-part")).toBe("composer-suggestion-use");
    expect(button.getAttribute("data-variant")).toBe("ghost");
    expect(button.getAttribute("data-density")).toBe("dense");
    expect(button.textContent).toBe("Use suggestion");
    expect(button.querySelector("svg")).not.toBeNull();
    // the chip row's end in the mobile form (above the pill), before send's line above 600
    expect(button.closest('[data-part="composer-bar"]')).not.toBeNull();
    expect(button.closest('[data-part="composer-box"]')).toBeNull();
    await user.click(button);
    expect(draftText()).toBe(TEXT);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input());
    // shown only while the suggestion shows
    expect(document.querySelector('[data-part="composer-suggestion-use"]')).toBeNull();
  });

  it("is absent while the draft has text or a run is going", () => {
    touchPointer();
    const { rerender } = wrap(
      <ComposerBox {...props({ segments: ["hi"], suggestion: { text: TEXT, onDismiss: noop } })} />,
    );
    expect(document.querySelector('[data-part="composer-suggestion-use"]')).toBeNull();
    rerender(
      <DesignProvider locale="en">
        <ComposerBox {...props({ hint: "running", suggestion: { text: TEXT, onDismiss: noop } })} />
      </DesignProvider>,
    );
    expect(document.querySelector('[data-part="composer-suggestion-use"]')).toBeNull();
  });

  it("names the text literally, never expanding replacement patterns", () => {
    touchPointer();
    wrap(
      <ComposerBox {...props({ suggestion: { text: "Use $& and $1 here", onDismiss: noop } })} />,
    );
    expect(screen.getByRole("button", { name: "Use suggestion: Use $& and $1 here" })).toBeTruthy();
  });

  it("a paste or attach click without a shown suggestion does not dismiss", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    wrap(
      <ComposerBox
        {...props({ segments: ["hi"], hint: "running", suggestion: { text: TEXT, onDismiss } })}
      />,
    );
    // the paste event alone (a file changes no text); a text change has its own rule
    fireEvent.paste(input(), { clipboardData: { files: [], types: [], getData: () => "" } });
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("names the text in zh", () => {
    touchPointer();
    wrap(<ComposerBox {...props({ suggestion: { text: "导出", onDismiss: noop } })} />, "zh");
    expect(screen.getByRole("button", { name: "使用建议：导出" }).textContent).toBe("使用建议");
  });

  it("adds no box inside the composer box", () => {
    touchPointer();
    wrap(<ComposerBox {...props({ suggestion: { text: TEXT, onDismiss: noop } })} />);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});
