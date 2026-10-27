import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerBox, type ComposerBoxProps, DesignProvider } from "../src/index";

/** Phase D Task 10: the skill chip (token) in the composer (spec §6.16.2, state `skill`). */

afterEach(cleanup);

const noop = () => {};
const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const props = (over: Partial<ComposerBoxProps> = {}): ComposerBoxProps => ({
  value: "",
  onChange: noop,
  placeholder: "Message, / for commands",
  onAttach: noop,
  pickers: {
    agent: { label: "Agent", value: "Research", groups: [], onPick: noop },
    model: { label: "Model", value: "opus 5.5", groups: [], onPick: noop },
  },
  send: { mode: "send", disabled: true, onClick: noop },
  ...over,
});

function Harness({ onRemove, initial }: { onRemove(): void; initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ComposerBox
      {...props({
        value,
        onChange: setValue,
        token: { label: "/fix-issue", hint: "[issue-number]", onRemove },
      })}
    />
  );
}

describe("ComposerBox token (skill chip)", () => {
  it("renders the token with its label before the text area", () => {
    wrap(<ComposerBox {...props({ token: { label: "/fix-issue", onRemove: noop } })} />);
    const token = document.querySelector('[data-part="composer-token"]');
    expect(token?.textContent).toContain("/fix-issue");
    const input = screen.getByRole("textbox");
    // the token comes first in document order
    expect(token?.compareDocumentPosition(input)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("the token's hint becomes the textarea placeholder", () => {
    wrap(
      <ComposerBox
        {...props({ token: { label: "/fix-issue", hint: "[issue-number]", onRemove: noop } })}
      />,
    );
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("[issue-number]");
  });

  it("without a hint the placeholder stays", () => {
    wrap(<ComposerBox {...props({ token: { label: "/x", onRemove: noop } })} />);
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("Message, / for commands");
  });

  it("Backspace with the caret at 0 calls onRemove and keeps the text", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    wrap(<Harness onRemove={onRemove} initial="123" />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(0, 0);
    await user.keyboard("{Backspace}");
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("123");
  });

  it("Backspace elsewhere edits the text and keeps the token", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    wrap(<Harness onRemove={onRemove} initial="123" />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(3, 3);
    await user.keyboard("{Backspace}");
    expect(onRemove).not.toHaveBeenCalled();
    expect(input.value).toBe("12");
  });

  it("Backspace with a selection starting at 0 deletes the selection, not the token", () => {
    const onRemove = vi.fn();
    wrap(<Harness onRemove={onRemove} initial="123" />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.setSelectionRange(0, 2);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("the remove button calls onRemove and is named after the token", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    wrap(<ComposerBox {...props({ token: { label: "/fix-issue", onRemove } })} />);
    await user.click(screen.getByRole("button", { name: "Remove /fix-issue" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("the caller's onKeyDown still runs for other keys", () => {
    const onKeyDown = vi.fn();
    wrap(<ComposerBox {...props({ onKeyDown, token: { label: "/x", onRemove: noop } })} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("zh names the remove button", () => {
    wrap(<ComposerBox {...props({ token: { label: "/x", onRemove: noop } })} />, "zh");
    expect(screen.getByRole("button", { name: "移除 /x" })).toBeTruthy();
  });
});
