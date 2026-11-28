import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerBox,
  type ComposerBoxProps,
  type ComposerEditorHandle,
  type ComposerSegment,
  type ComposerTokenData,
  DesignProvider,
} from "../src/index";
import { findNestedBoxes } from "../src/reference/index";
import { composerText, focusEnd, select } from "./composer-editor-helpers";

// The composer box on the inline token editor (composer inline tokens spec §1, §2): the skill
// token, the refusal line, ↵, the menu's keys and the editor's handle.

afterEach(cleanup);

const noop = () => {};
const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const props = (over: Partial<ComposerBoxProps> = {}): ComposerBoxProps => ({
  segments: [],
  onChange: noop,
  onSubmit: noop,
  placeholder: "Message, / for commands",
  onAttach: noop,
  pickers: {
    agent: { label: "Agent", value: "Research", groups: [], onPick: noop },
    model: { label: "Model", value: "opus 5.5", groups: [], onPick: noop },
  },
  send: { mode: "send", disabled: true, onClick: noop },
  ...over,
});

const skill: ComposerTokenData = { kind: "skill", id: "fix-issue", label: "/fix-issue" };
const slack: ComposerTokenData = { kind: "connector", id: "c-slack", label: "Slack" };

/** A page holding the draft in state, as ComposerBar does. */
function Harness({
  initial,
  over = {},
  seen,
}: {
  initial: ComposerSegment[];
  over?: Partial<ComposerBoxProps>;
  seen?(s: ComposerSegment[]): void;
}) {
  const [segments, setSegments] = useState(initial);
  return (
    <ComposerBox
      {...props({
        segments,
        onChange: (s) => {
          setSegments(s);
          seen?.(s);
        },
        ...over,
      })}
    />
  );
}

describe("ComposerBox skill token", () => {
  it("the skill is an inline token leading the draft", () => {
    wrap(<ComposerBox {...props({ segments: [skill, " 42"] })} />);
    const token = screen.getByRole("img", { name: "Skill: /fix-issue" });
    expect(token.getAttribute("data-kind")).toBe("skill");
    expect(composerText().contains(token)).toBe(true);
    expect(composerText().textContent).toContain("42");
    // no chip and no remove button any more
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("the skill's argument hint is ghost text after a lone skill token", () => {
    wrap(<ComposerBox {...props({ segments: [skill, " "], skillHint: "[issue-number]" })} />);
    const hint = document.querySelector(".cb-composer-editor-hint");
    expect(hint?.textContent).toBe("[issue-number]");
    const ids = (composerText().getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toContain(hint?.id);
  });

  it("the hint goes once arguments follow the token", () => {
    wrap(<ComposerBox {...props({ segments: [skill, " 42"], skillHint: "[issue-number]" })} />);
    expect(document.querySelector(".cb-composer-editor-hint")).toBeNull();
  });

  it("an empty draft shows the placeholder", () => {
    wrap(<ComposerBox {...props({ skillHint: "[issue-number]" })} />);
    expect(composerText().getAttribute("aria-placeholder")).toBe("Message, / for commands");
    expect(document.querySelector(".cb-composer-editor-placeholder")?.textContent).toBe(
      "Message, / for commands",
    );
  });

  it("Backspace right after the skill token removes it and keeps the text", async () => {
    const seen = vi.fn();
    wrap(<Harness initial={[skill, "123"]} seen={seen} />);
    focusEnd();
    select(0);
    await act(async () => {
      fireEvent.keyDown(composerText(), { key: "Backspace" });
    });
    expect(seen).toHaveBeenLastCalledWith(["123"]);
    expect(screen.queryByRole("img", { name: "Skill: /fix-issue" })).toBeNull();
  });
});

describe("ComposerBox keys and handle", () => {
  it("Enter sends through onSubmit; Shift+Enter does not", async () => {
    const onSubmit = vi.fn();
    wrap(<Harness initial={["hello"]} over={{ onSubmit }} />);
    focusEnd();
    await act(async () => {
      fireEvent.keyDown(composerText(), { key: "Enter", shiftKey: true });
    });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(composerText(), { key: "Enter" });
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("the menu's keys come first, with the caret facts from the editor", async () => {
    const onSubmit = vi.fn();
    const onKeyDown = vi.fn((e: KeyboardEvent) => e.key === "Enter");
    wrap(
      <Harness
        initial={["@sl"]}
        over={{
          onSubmit,
          menu: {
            combobox: { role: "combobox", "aria-expanded": true, "aria-autocomplete": "list" },
            onKeyDown,
          },
        }}
      />,
    );
    focusEnd();
    await act(async () => {
      fireEvent.keyDown(composerText(), { key: "Enter" });
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onKeyDown).toHaveBeenLastCalledWith(expect.objectContaining({ key: "Enter" }), {
      collapsed: true,
      atStart: false,
      atEnd: true,
    });
    select(0);
    fireEvent.keyDown(composerText(), { key: "ArrowLeft" });
    expect(onKeyDown).toHaveBeenLastCalledWith(expect.anything(), {
      collapsed: true,
      atStart: true,
      atEnd: false,
    });
    select(0, 2);
    fireEvent.keyDown(composerText(), { key: "ArrowLeft" });
    expect(onKeyDown).toHaveBeenLastCalledWith(expect.anything(), {
      collapsed: false,
      atStart: false,
      atEnd: false,
    });
  });

  it("editorRef is the editor's handle", () => {
    const ref = createRef<ComposerEditorHandle>();
    wrap(<Harness initial={["hi ", slack]} over={{ editorRef: ref }} />);
    expect(ref.current?.value()).toEqual(["hi ", slack]);
    act(() => ref.current?.replace(["new"]));
    expect(ref.current?.value()).toEqual(["new"]);
  });

  it("a page's new segments replace the draft", () => {
    const { rerender } = wrap(<ComposerBox {...props({ segments: ["old"] })} />);
    rerender(
      <DesignProvider locale="en">
        <ComposerBox {...props({ segments: ["restored ", slack] })} />
      </DesignProvider>,
    );
    expect(screen.getByRole("img", { name: "Connector: Slack" })).toBeTruthy();
    expect(composerText().textContent).toContain("restored");
  });

  it("pasted files go to onPasteFiles and change no text", async () => {
    const onPasteFiles = vi.fn();
    const seen = vi.fn();
    wrap(<Harness initial={[]} seen={seen} over={{ onPasteFiles }} />);
    focusEnd();
    const file = new File(["x"], "shot.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(composerText(), {
        clipboardData: { files: [file], getData: () => "", types: ["Files"] },
      });
    });
    expect(onPasteFiles).toHaveBeenCalledWith([file]);
    expect(seen).not.toHaveBeenCalled();
  });

  it("onTrigger reports a typed @ at the caret", async () => {
    const onTrigger = vi.fn();
    wrap(<Harness initial={[]} over={{ onTrigger }} />);
    focusEnd();
    const { typeText } = await import("./composer-editor-helpers");
    typeText("@");
    expect(onTrigger).toHaveBeenLastCalledWith({ trigger: "@", query: "", atStart: true });
  });
});

describe("ComposerBox refusal line (inline tokens spec §1, §3.4)", () => {
  const refusedSlack: ComposerTokenData = {
    ...slack,
    state: "refused",
    reason: "This agent can't use it",
  };

  /** The page after a refused send: the refused tokens marked, the line until they are gone. */
  function Refused({ locale = "en" }: { locale?: "zh" | "en" }) {
    const [segments, setSegments] = useState<ComposerSegment[]>(["给 ", refusedSlack, " 发消息"]);
    const left = segments.filter((s) => typeof s !== "string" && s.state === "refused");
    return (
      <ComposerBox
        {...props({
          segments,
          onChange: setSegments,
          ...(left.length > 0
            ? {
                refused: {
                  label: "Slack",
                  reason: locale === "zh" ? "这个智能体不能使用它" : "This agent can't use it",
                  onRemove: () =>
                    setSegments(
                      segments.filter((s) => typeof s === "string" || s.state !== "refused"),
                    ),
                },
              }
            : {}),
        })}
      />
    );
  }

  it("refused Callout removes refused tokens", async () => {
    const user = userEvent.setup();
    wrap(<Refused />);
    const line = screen.getByRole("status");
    expect(line.getAttribute("data-tone")).toBe("fail");
    expect(line.textContent).toContain("Slack can't be used: This agent can't use it");
    expect(screen.getByRole("img", { name: "Connector: Slack, unavailable" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByRole("img", { name: /Slack/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(composerText().textContent).toContain("发消息");
  });

  it("says it in Chinese", () => {
    wrap(<Refused locale="zh" />, "zh");
    expect(screen.getByRole("status").textContent).toContain(
      "Slack 不能使用：这个智能体不能使用它",
    );
    expect(screen.getByRole("button", { name: "移除" })).toBeTruthy();
  });

  it("is the fail line at the top of the frame, not a box in its box", () => {
    wrap(<Refused />);
    const callout = document.querySelector('[data-part="composer"] > [data-part="callout"]');
    expect(callout?.getAttribute("data-framed")).toBe("false");
    expect(callout?.getAttribute("data-tone")).toBe("fail");
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("the token warning takes the line while it shows", async () => {
    const SLACK = "xoxb-123456789012-abcdefghij";
    wrap(
      <ComposerBox
        {...props({
          segments: [refusedSlack, ` ${SLACK}`],
          refused: { label: "Slack", reason: "This agent can't use it", onRemove: noop },
        })}
      />,
    );
    focusEnd();
    await act(async () => {
      fireEvent.keyDown(composerText(), { key: "Enter" });
    });
    const lines = screen.getAllByRole("status");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.getAttribute("data-tone")).toBe("warn");
  });
});

describe("ComposerBox device picker", () => {
  const env = (over: Partial<NonNullable<ComposerBoxProps["pickers"]["device"]>> = {}) => ({
    label: "Device",
    value: "Docker dev",
    groups: [
      {
        items: [
          { id: "e1", label: "Docker dev", checked: true },
          { id: "e2", label: "E2B cloud", tag: "Not configured", disabled: true },
        ],
      },
    ],
    onPick: noop,
    ...over,
  });

  it("device picker renders between agent and model", () => {
    wrap(<ComposerBox {...props({ pickers: { ...props().pickers, device: env() } })} />);
    const names = ["Agent: Research", "Device: Docker dev", "Model: opus 5.5"];
    const nodes = names.map((n) => screen.getByRole("button", { name: n }));
    expect(nodes[0]?.compareDocumentPosition(nodes[1] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(nodes[1]?.compareDocumentPosition(nodes[2] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("locked device picker opens no menu", async () => {
    const user = userEvent.setup();
    wrap(
      <ComposerBox
        {...props({
          pickers: {
            ...props().pickers,
            device: env({ locked: { hint: "Fixed after the first message" } }),
          },
        })}
      />,
    );
    const locked = document.querySelector('[data-part="picker"][data-locked="true"]');
    expect(locked?.textContent).toBe("Docker dev");
    expect(locked?.getAttribute("title")).toBe("Fixed after the first message");
    await user.click(locked as Element);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /Device/ })).toBeNull();
  });

  it("a disabled device item shows its hint and cannot be picked", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    wrap(<ComposerBox {...props({ pickers: { ...props().pickers, device: env({ onPick }) } })} />);
    await user.click(screen.getByRole("button", { name: "Device: Docker dev" }));
    const item = screen.getByRole("menuitemradio", { name: /E2B cloud/ });
    expect(item.textContent).toContain("Not configured");
    await user.click(item);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("ComposerBox frame", () => {
  it("draws its frame by default", () => {
    wrap(<ComposerBox {...props()} />);
    const frame = document.querySelector('[data-part="composer"]');
    expect(frame?.getAttribute("data-frame")).toBeNull();
    expect(frame?.getAttribute("data-cap-part")).toBe("composer");
  });

  it("frame={false} keeps the inputs and the composer part without the box", () => {
    wrap(<ComposerBox {...props({ frame: false })} />);
    const frames = document.querySelectorAll('[data-part="composer"]');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.getAttribute("data-frame")).toBe("bare");
    expect(frames[0]?.getAttribute("data-cap-part")).toBe("composer");
    expect(
      document.querySelector(
        '[data-cap-part~="composer"] [contenteditable][data-part="composer-input"]',
      ),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
  });
});

describe("composer context meter", () => {
  it("context meter sits right before the send button", () => {
    wrap(<ComposerBox {...props({ context: { pct: 43, over: false } })} />);
    const meter = document.querySelector('[data-part="composer-context-meter"]');
    expect(meter).toBeTruthy();
    const next = meter?.nextElementSibling;
    expect(next?.getAttribute("data-part")).toBe("send");
  });

  it("no meter without context", () => {
    wrap(<ComposerBox {...props()} />);
    expect(document.querySelector('[data-part="composer-context-meter"]')).toBeNull();
  });
});
