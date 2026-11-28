import { act, screen } from "@testing-library/react";
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
} from "lexical";

// Helpers for tests that drive the composer's Lexical editor (composer inline tokens spec §2) in
// jsdom: typing, the caret and the draft's text go through the editor, as a keystroke would.

/** The composer's text box: the editor's content editable (a combobox while a menu is hosted). */
export function composerText(): HTMLElement {
  return (screen.queryByRole("combobox", { name: /^(消息|Message)$/ }) ??
    screen.getByRole("textbox", { name: /^(消息|Message)$/ })) as HTMLElement;
}

/** The Lexical editor behind a content editable. */
export function editorOf(box: HTMLElement): LexicalEditor {
  return (box as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
}

/** The draft's text as the person sees it (tokens drawn by their labels). */
export function draftText(box: HTMLElement = composerText()): string {
  return editorOf(box)
    .getEditorState()
    .read(() => $getRoot().getTextContent());
}

/** Focuses the text with the caret at the end of the draft. */
export function focusEnd(box: HTMLElement = composerText()): void {
  const editor = editorOf(box);
  act(() => {
    box.focus();
    editor.update(() => $getRoot().selectEnd(), { discrete: true });
  });
}

/** Types `text` at the caret as one keystroke would (an update with no tag). */
export function typeText(text: string, box: HTMLElement = composerText()): void {
  const editor = editorOf(box);
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

/**
 * Puts the selection at `[start, end]` (character offsets) in a draft of one text run; `end`
 * defaults to `start` (a caret).
 */
export function select(start: number, end = start, box: HTMLElement = composerText()): void {
  const editor = editorOf(box);
  act(() => {
    editor.update(
      () => {
        const p = $getRoot().getFirstChildOrThrow() as ElementNode;
        const node = p.getChildren().find($isTextNode);
        if (!node) {
          p.select(0, 0);
          return;
        }
        const s = $createRangeSelection();
        s.anchor.set(node.getKey(), start, "text");
        s.focus.set(node.getKey(), end, "text");
        $setSelection(s);
      },
      { discrete: true },
    );
  });
}

/** Deletes the character before the caret as Backspace does (jsdom fires no beforeinput). */
export function backspace(box: HTMLElement = composerText()): void {
  const editor = editorOf(box);
  act(() => {
    editor.update(
      () => {
        // jsdom has no Selection.modify, which Lexical's deleteCharacter steps with: the
        // character before a caret in a text run is removed as a one-character range
        const s = $getSelection();
        if (!$isRangeSelection(s) || !s.isCollapsed() || s.anchor.type !== "text") return;
        const { key, offset } = s.anchor;
        if (offset === 0) return;
        const range = $createRangeSelection();
        range.anchor.set(key, offset - 1, "text");
        range.focus.set(key, offset, "text");
        $setSelection(range);
        range.removeText();
      },
      { discrete: true },
    );
  });
}
