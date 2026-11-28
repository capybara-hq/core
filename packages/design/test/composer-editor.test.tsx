import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  $createNodeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  type ElementNode,
  type LexicalEditor,
  UNDO_COMMAND,
} from "lexical";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { $isTokenNode, TokenNode } from "../src/conversation/composer-editor/token-node";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorProps,
  type ComposerSegment,
  type ComposerTokenData,
  DesignProvider,
  segmentsPlainText,
} from "../src/index";

// Composer inline tokens spec §2: the Lexical editor's behaviour contract in jsdom (caret, IME and
// centring run in Playwright: apps/web/visual/composer-editor.interaction.spec.ts).

afterEach(cleanup);

const slack: ComposerTokenData = { kind: "connector", id: "c-slack", label: "Slack" };
const noop = () => {};

type Over = Partial<ComposerEditorProps>;

/** A page holding the draft as ComposerBar will: segments in state, the editor's handle in a ref. */
function Harness({
  initial = [],
  over = {},
  handle,
  seen,
}: {
  initial?: ComposerSegment[];
  over?: Over;
  handle?: React.Ref<ComposerEditorHandle>;
  seen?: (s: ComposerSegment[]) => void;
}) {
  const [segments, setSegments] = useState(initial);
  return (
    <ComposerEditor
      ref={handle}
      segments={segments}
      onChange={(s) => {
        setSegments(s);
        seen?.(s);
      }}
      placeholder="Message"
      onSubmit={noop}
      {...over}
    />
  );
}

function mount(props: Parameters<typeof Harness>[0] = {}, locale: "zh" | "en" = "zh") {
  const handle = createRef<ComposerEditorHandle>();
  const utils = render(
    <DesignProvider locale={locale}>
      <Harness handle={handle} {...props} />
    </DesignProvider>,
  );
  const box = utils.container.querySelector<HTMLElement>("[contenteditable]") as HTMLElement;
  const editor = (box as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  // the editor has the focus, so its selection reaches the DOM (key events read it from there)
  act(() => {
    box.focus();
    editor.update(() => $getRoot().selectEnd(), { discrete: true });
  });
  return { ...utils, handle, box, editor, h: () => handle.current as ComposerEditorHandle };
}

/** Types `text` as one keystroke would (an update with no tag). */
function type(editor: LexicalEditor, text: string) {
  act(() => {
    editor.update(
      () => {
        const s = $getSelection();
        if ($isRangeSelection(s)) s.insertText(text);
        else $getRoot().selectEnd().insertText(text);
      },
      { discrete: true },
    );
  });
}

/** Selects the first token as a click does. */
function selectFirstToken(editor: LexicalEditor) {
  act(() => {
    editor.update(
      () => {
        const p = $getRoot().getFirstChildOrThrow() as ElementNode;
        const node = p.getChildren().find($isTokenNode);
        const s = $createNodeSelection();
        if (node) s.add(node.getKey());
        $setSelection(s);
      },
      { discrete: true },
    );
  });
}

/** A clipboard as a paste or copy event carries it. */
function clipboard(data: Record<string, string> = {}, files: File[] = []) {
  const store: Record<string, string> = { ...data };
  return {
    store,
    files,
    types: Object.keys(store),
    getData: (k: string) => store[k] ?? "",
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    clearData: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

describe("ComposerEditor (composer inline tokens spec §2)", () => {
  it("TokenNode round-trips JSON", () => {
    const { editor } = mount();
    const token: ComposerTokenData = {
      kind: "resource",
      id: "c-slack:mcp://send",
      label: "Send Message",
      icon: { src: "/api/v1/icon", initial: "S" },
      state: "refused",
    };
    let json: ReturnType<TokenNode["exportJSON"]> | undefined;
    let back: typeof json;
    editor.update(
      () => {
        json = new TokenNode(token).exportJSON();
        back = TokenNode.importJSON(json).exportJSON();
      },
      { discrete: true },
    );
    expect(json).toEqual({ type: "cap-token", version: 1, ...token });
    expect(back).toEqual(json);
  });

  it("segments in = segments out", () => {
    const initial: ComposerSegment[] = ["给 ", slack, " 发消息"];
    const { h, box } = mount({ initial });
    expect(h().value()).toEqual(initial);
    expect(box.textContent).toContain("Slack");
  });

  it("paste strips U+FFFC and format characters", async () => {
    const onTrigger = vi.fn();
    const seen = vi.fn();
    const { box, h } = mount({ over: { onTrigger }, seen });
    await act(async () => {
      fireEvent.paste(box, { clipboardData: clipboard({ "text/plain": "a￼b​c" }) });
    });
    expect(h().value()).toEqual(["abc"]);
    expect(seen).toHaveBeenLastCalledWith(["abc"]);
    expect(onTrigger.mock.calls.every(([t]) => t === null)).toBe(true);
  });

  it('paste of "@Slack" stays text', async () => {
    const onTrigger = vi.fn();
    const onPasteText = vi.fn();
    const { box, h } = mount({ over: { onTrigger, onPasteText } });
    await act(async () => {
      fireEvent.paste(box, {
        clipboardData: clipboard({ "text/plain": "@Slack", "text/html": "<b>@Slack</b>" }),
      });
    });
    expect(h().value()).toEqual(["@Slack"]);
    expect(onPasteText).toHaveBeenCalledWith("@Slack");
    expect(onTrigger.mock.calls.every(([t]) => t === null)).toBe(true);
  });

  it("paste hands files to onPasteFiles", async () => {
    const onPasteFiles = vi.fn();
    const { box, h } = mount({ over: { onPasteFiles } });
    const file = new File(["x"], "shot.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(box, { clipboardData: clipboard({}, [file]) });
    });
    expect(onPasteFiles).toHaveBeenCalledWith([file]);
    expect(h().value()).toEqual([]);
  });

  it("copy writes plain forms only", async () => {
    const { box, editor } = mount({ initial: ["给 ", slack, " 发消息"] });
    act(() => {
      editor.update(
        () => {
          const p = $getRoot().getFirstChildOrThrow() as ElementNode;
          p.select(0, p.getChildrenSize());
        },
        { discrete: true },
      );
    });
    const data = clipboard();
    await act(async () => {
      fireEvent.copy(box, { clipboardData: data });
    });
    expect(data.store).toEqual({ "text/plain": "给 @Slack 发消息" });
  });

  it("segmentsPlainText writes the plain forms of spec §1", () => {
    expect(
      segmentsPlainText([
        { kind: "skill", id: "s", label: "invoice-scan-match" },
        " 给 ",
        slack,
        " 和 ",
        { kind: "file", id: "f", label: "report.pdf" },
      ]),
    ).toBe("/invoice-scan-match 给 @Slack 和 @report.pdf");
  });

  it("insertToken replaces the query", () => {
    const { h, editor } = mount({ initial: [] });
    act(() => h().replace(["hi @sl"]));
    act(() => h().insertToken(slack, { trigger: "@", length: 3 }));
    expect(h().value()).toEqual(["hi ", slack, " "]);
    // the caret stands after the space
    type(editor, "x");
    expect(h().value()).toEqual(["hi ", slack, " x"]);
  });

  it("Backspace after a token removes it", async () => {
    const { h, box } = mount({ initial: ["a ", slack] });
    act(() => h().replace(["a ", slack]));
    await act(async () => {
      fireEvent.keyDown(box, { key: "Backspace" });
    });
    expect(h().value()).toEqual(["a "]);
  });

  it("a selected token goes with Delete", async () => {
    const { h, box, editor } = mount({ initial: ["a ", slack, " b"] });
    act(() => {
      editor.update(
        () => {
          const p = $getRoot().getFirstChildOrThrow() as ElementNode;
          const node = p.getChildren().find($isTokenNode);
          const s = $createNodeSelection();
          if (node) s.add(node.getKey());
          $setSelection(s);
        },
        { discrete: true },
      );
    });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Delete" });
    });
    expect(h().value()).toEqual(["a  b"]);
  });

  it("undo restores a removed token in one step", async () => {
    const { h, box, editor } = mount();
    act(() => h().replace(["a ", slack]));
    await act(async () => {
      fireEvent.keyDown(box, { key: "Backspace" });
    });
    expect(h().value()).toEqual(["a "]);
    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });
    expect(h().value()).toEqual(["a ", slack]);
  });

  it("replace is one undo step", async () => {
    const { h, editor } = mount();
    type(editor, "draft");
    act(() => h().replace(["quick ", slack]));
    expect(h().value()).toEqual(["quick ", slack]);
    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });
    expect(h().value()).toEqual(["draft"]);
  });

  it("insertToken is one undo step", async () => {
    const { h, editor } = mount();
    type(editor, "hi @sl");
    act(() => h().insertToken(slack, { trigger: "@", length: 3 }));
    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });
    expect(h().value()).toEqual(["hi @sl"]);
  });

  it("clear empties the draft and its history", async () => {
    const { h, editor } = mount();
    type(editor, "sent text");
    act(() => h().clear());
    expect(h().value()).toEqual([]);
    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });
    expect(h().value()).toEqual([]);
  });

  it("token accessible name", () => {
    mount({
      initial: [
        slack,
        " ",
        { kind: "connector", id: "c-lark", label: "Lark", state: "refused", reason: "已停用" },
      ],
    });
    expect(screen.getByRole("img", { name: "连接器：Slack" })).toBeTruthy();
    const refused = screen.getByRole("img", { name: "连接器：Lark，不可用" });
    expect(refused.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("img", { description: "已停用" })).toBe(refused);
  });

  it("names tokens in English too", () => {
    mount({ initial: [{ kind: "projectFile", id: "p", label: "src/app.ts" }] }, "en");
    expect(screen.getByRole("img", { name: "Project file: src/app.ts" })).toBeTruthy();
  });

  it("is a multiline text box without a menu", () => {
    const { box } = mount();
    expect(box.getAttribute("role")).toBe("textbox");
    expect(box.getAttribute("aria-multiline")).toBe("true");
  });

  it("combobox attributes pass through", () => {
    const { box } = mount({
      over: {
        combobox: {
          role: "combobox",
          "aria-expanded": true,
          "aria-autocomplete": "list",
          "aria-controls": "menu-list",
          "aria-activedescendant": "menu-row-2",
        },
      },
    });
    expect(box.getAttribute("role")).toBe("combobox");
    expect(box.getAttribute("aria-multiline")).toBe("true");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(box.getAttribute("aria-controls")).toBe("menu-list");
    expect(box.getAttribute("aria-activedescendant")).toBe("menu-row-2");
  });

  it("onTrigger reports @ mid-sentence and / mid-sentence", () => {
    const onTrigger = vi.fn();
    const { editor } = mount({ over: { onTrigger } });
    type(editor, "ask ");
    type(editor, "@");
    expect(onTrigger).toHaveBeenLastCalledWith({ trigger: "@", query: "", atStart: false });
    type(editor, "sl");
    expect(onTrigger).toHaveBeenLastCalledWith({ trigger: "@", query: "sl", atStart: false });
    type(editor, " ");
    type(editor, "x");
    // `@sl x`: still the open trigger (the menu closes a space itself when nothing matches)
    type(editor, "\n");
    expect(onTrigger).toHaveBeenLastCalledWith(null);
    type(editor, "then ");
    type(editor, "/");
    expect(onTrigger).toHaveBeenLastCalledWith({ trigger: "/", query: "", atStart: false });
    type(editor, "fix ");
    expect(onTrigger).toHaveBeenLastCalledWith(null);
  });

  it("/ at the start reports atStart", () => {
    const onTrigger = vi.fn();
    const { editor } = mount({ over: { onTrigger } });
    type(editor, "/");
    expect(onTrigger).toHaveBeenLastCalledWith({ trigger: "/", query: "", atStart: true });
  });

  it("an address is not a trigger", () => {
    const onTrigger = vi.fn();
    const { editor } = mount({ over: { onTrigger } });
    type(editor, "a");
    type(editor, "@");
    expect(onTrigger.mock.calls.every(([t]) => t === null)).toBe(true);
  });

  it("full-width ＠ is not a trigger", () => {
    const onTrigger = vi.fn();
    const { editor } = mount({ over: { onTrigger } });
    type(editor, "＠");
    expect(onTrigger.mock.calls.every(([t]) => t === null)).toBe(true);
  });

  it("Enter submits, Shift+Enter does not", async () => {
    const onSubmit = vi.fn();
    const { box, editor } = mount({ over: { onSubmit } });
    type(editor, "hello");
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Enter on a touch device is a newline", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("coarse"),
      media: q,
      addEventListener: noop,
      removeEventListener: noop,
    })) as unknown as typeof window.matchMedia;
    try {
      const onSubmit = vi.fn();
      const { box, editor } = mount({ over: { onSubmit } });
      type(editor, "hello");
      await act(async () => {
        fireEvent.keyDown(box, { key: "Enter" });
      });
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });

  it("the menu's keys come first", async () => {
    const onSubmit = vi.fn();
    const onKeyDown = vi.fn((e: KeyboardEvent) => e.key === "Enter");
    const { box } = mount({ over: { onSubmit, onKeyDown } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(onKeyDown).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the placeholder when empty and the hint after a lone skill token", () => {
    const skill: ComposerTokenData = { kind: "skill", id: "s", label: "fix-issue" };
    const { container, h } = mount({ over: { hint: "[issue-number]" } });
    expect(container.textContent).toContain("Message");
    act(() => h().replace([skill, " "]));
    expect(container.querySelector(".cb-composer-editor-hint")?.textContent).toBe("[issue-number]");
    act(() => h().replace([skill, " 42"]));
    expect(container.querySelector(".cb-composer-editor-hint")).toBeNull();
  });

  it("a page's new segments replace the draft", async () => {
    function Page() {
      const [segments, setSegments] = useState<ComposerSegment[]>(["old"]);
      return (
        <DesignProvider locale="zh">
          <ComposerEditor
            segments={segments}
            onChange={setSegments}
            placeholder="Message"
            onSubmit={noop}
          />
          <button type="button" onClick={() => setSegments(["restored ", slack])}>
            restore
          </button>
        </DesignProvider>
      );
    }
    render(<Page />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "restore" }));
    });
    expect(screen.getByRole("img", { name: "连接器：Slack" })).toBeTruthy();
    expect(screen.getByRole("textbox").textContent).toContain("restored");
  });
  it("format characters go but ZWJ and ZWNJ stay", async () => {
    const { box, h } = mount();
    await act(async () => {
      fireEvent.paste(box, {
        clipboardData: clipboard({ "text/plain": "👨\u200D👩\u200D👧 a\u200Bb\u200Cc\u202Ed" }),
      });
    });
    expect(h().value()).toEqual(["👨\u200D👩\u200D👧 ab\u200Ccd"]);
  });

  it("drop strips U+FFFC and format characters", () => {
    const onTrigger = vi.fn();
    const { editor, h } = mount({ over: { onTrigger } });
    // a native drop reaches the editor as beforeinput insertFromDrop, which Lexical turns into
    // this command at the drop point (jsdom has no beforeinput)
    act(() => {
      editor.update(
        () => {
          editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, {
            inputType: "insertFromDrop",
            data: null,
            dataTransfer: clipboard({ "text/plain": "@x\uFFFCy\u200B" }),
          } as unknown as InputEvent);
        },
        { discrete: true },
      );
    });
    expect(h().value()).toEqual(["@xy"]);
    expect(onTrigger.mock.calls.every(([t]) => t === null)).toBe(true);
  });

  it("a drag of a selection holding a token is refused", async () => {
    const { box, editor } = mount({ initial: ["给 ", slack, " 发消息"] });
    act(() => {
      editor.update(
        () => {
          const p = $getRoot().getFirstChildOrThrow() as ElementNode;
          p.select(0, 3);
        },
        { discrete: true },
      );
    });
    let prevented = false;
    await act(async () => {
      prevented = !fireEvent.dragStart(box, { dataTransfer: clipboard() });
    });
    expect(prevented).toBe(true);
  });

  it("no text node keeps a token marker", () => {
    const { editor, h } = mount();
    type(editor, "a\uFFFCb");
    expect(h().value()).toEqual(["ab"]);
  });

  it("copy and cut with a bare caret leave the clipboard alone", async () => {
    const { box, h } = mount({ initial: ["给 ", slack] });
    act(() => h().replace(["给 ", slack]));
    const data = clipboard({ "text/plain": "before" });
    await act(async () => {
      fireEvent.copy(box, { clipboardData: data });
      fireEvent.cut(box, { clipboardData: data });
    });
    expect(data.store).toEqual({ "text/plain": "before" });
    expect(h().value()).toEqual(["给 ", slack]);
  });

  it("cut writes plain forms and removes the selection", async () => {
    const { box, editor, h } = mount({ initial: ["给 ", slack, " 发消息"] });
    act(() => {
      editor.update(
        () => {
          const p = $getRoot().getFirstChildOrThrow() as ElementNode;
          p.select(0, 2);
        },
        { discrete: true },
      );
    });
    const data = clipboard();
    await act(async () => {
      fireEvent.cut(box, { clipboardData: data });
    });
    expect(data.store).toEqual({ "text/plain": "给 @Slack" });
    expect(h().value()).toEqual([" 发消息"]);
  });

  it("typing over a selected token replaces it", async () => {
    const { box, editor, h } = mount({ initial: ["a ", slack, " b"] });
    selectFirstToken(editor);
    await act(async () => {
      fireEvent.keyDown(box, { key: "x" });
    });
    expect(h().value()).toEqual(["a x b"]);
  });

  it("a paste over a selected token replaces it", async () => {
    const { box, editor, h } = mount({ initial: ["a ", slack, " b"] });
    selectFirstToken(editor);
    await act(async () => {
      fireEvent.paste(box, { clipboardData: clipboard({ "text/plain": "pasted" }) });
    });
    expect(h().value()).toEqual(["a pasted b"]);
  });

  it("a pick over a selected token replaces it", () => {
    const lark: ComposerTokenData = { kind: "connector", id: "c-lark", label: "Lark" };
    const { editor, h } = mount({ initial: ["a ", slack, " b"] });
    selectFirstToken(editor);
    act(() => h().insertToken(lark));
    expect(h().value()).toEqual(["a ", lark, " b"]);
  });

  it("a trigger opens after a line break, not right after a token", () => {
    const onTrigger = vi.fn();
    const { editor, h } = mount({ over: { onTrigger } });
    type(editor, "a");
    type(editor, "\n");
    type(editor, "@");
    expect(onTrigger).toHaveBeenLastCalledWith({ trigger: "@", query: "", atStart: false });
    act(() => h().replace(["x ", slack]));
    onTrigger.mockClear();
    type(editor, "@");
    expect(onTrigger.mock.calls.every(([t]) => t === null)).toBe(true);
  });

  it("a caret moved out of the query closes the trigger", () => {
    const onTrigger = vi.fn();
    const { editor } = mount({ over: { onTrigger } });
    type(editor, "hi ");
    type(editor, "@");
    type(editor, "sl");
    expect(onTrigger).toHaveBeenLastCalledWith({ trigger: "@", query: "sl", atStart: false });
    act(() => {
      editor.update(
        () => {
          const p = $getRoot().getFirstChildOrThrow() as ElementNode;
          p.getFirstDescendant()?.selectStart?.();
          const t = p.getFirstChild();
          if (t && "select" in t)
            (t as unknown as { select(a: number, b: number): void }).select(1, 1);
        },
        { discrete: true },
      );
    });
    expect(onTrigger).toHaveBeenLastCalledWith(null);
    // back at the end of the query, it stays closed: only a new trigger opens a menu
    act(() => {
      editor.update(() => $getRoot().selectEnd(), { discrete: true });
    });
    expect(onTrigger).toHaveBeenLastCalledWith(null);
  });

  it("dismissTrigger closes the trigger until a new one is typed", () => {
    const onTrigger = vi.fn();
    const { editor, h } = mount({ over: { onTrigger } });
    type(editor, "@");
    type(editor, "sl");
    act(() => h().dismissTrigger());
    expect(onTrigger).toHaveBeenLastCalledWith(null);
    type(editor, "a");
    expect(onTrigger).toHaveBeenLastCalledWith(null);
    type(editor, " ");
    type(editor, "@");
    expect(onTrigger).toHaveBeenLastCalledWith({ trigger: "@", query: "", atStart: false });
  });

  it("an IME composition holds the trigger until it ends", async () => {
    const onTrigger = vi.fn();
    const onSubmit = vi.fn();
    const { box, editor } = mount({ over: { onTrigger, onSubmit } });
    type(editor, "ask ");
    await act(async () => {
      fireEvent.compositionStart(box, { data: "" });
    });
    expect(editor.isComposing()).toBe(true);
    // the IME's text, the caret after it (as the browser's selection would put it)
    act(() => {
      editor.update(
        () => {
          const s = $getSelection();
          if ($isRangeSelection(s)) s.insertText("@");
          $getRoot().selectEnd();
        },
        { discrete: true },
      );
    });
    expect(onTrigger.mock.calls.every(([t]) => t === null)).toBe(true);
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", keyCode: 229, isComposing: true });
    });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.compositionEnd(box, { data: "@" });
    });
    expect(editor.isComposing()).toBe(false);
    expect(onTrigger).toHaveBeenLastCalledWith({ trigger: "@", query: "", atStart: false });
  });

  it("an echo and a label refresh call no onChange and keep the caret", async () => {
    const seen = vi.fn();
    let setPage: (s: ComposerSegment[]) => void = noop;
    function Page() {
      const [segments, setSegments] = useState<ComposerSegment[]>(["a ", slack, " b"]);
      setPage = setSegments;
      return (
        <DesignProvider locale="zh">
          <ComposerEditor
            segments={segments}
            onChange={(s) => {
              seen(s);
              setSegments(s);
            }}
            placeholder="Message"
            onSubmit={noop}
          />
        </DesignProvider>
      );
    }
    const { container } = render(<Page />);
    const box = container.querySelector("[contenteditable]") as HTMLElement & {
      __lexicalEditor: LexicalEditor;
    };
    const editor = box.__lexicalEditor;
    act(() => {
      box.focus();
      editor.update(() => $getRoot().selectEnd(), { discrete: true });
    });
    type(editor, "c");
    expect(seen).toHaveBeenCalledTimes(1);
    const caret = () =>
      editor.read(() => {
        const s = $getSelection();
        return $isRangeSelection(s) ? `${s.anchor.key}:${s.anchor.offset}` : null;
      });
    const before = caret();
    await act(async () => {
      setPage(["a ", { ...slack, label: "Slack 工作区" }, " bc"]);
    });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "连接器：Slack 工作区" })).toBeTruthy();
    expect(caret()).toBe(before);
    // the refresh is no undo step: undo takes back the typed "c"
    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenLastCalledWith(["a ", expect.objectContaining({ id: "c-slack" }), " b"]);
  });
});
