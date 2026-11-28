/**
 * Test drivers for the composer's editor (`@capybara-hq/design/testing`): a page's tests type,
 * move the caret and read the draft through these, as a keystroke would, so `apps/web` never
 * imports Lexical (composer inline tokens spec §2). jsdom fires no `beforeinput`, so typing goes
 * through the editor itself. Each call runs inside React's `act`.
 */
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type LexicalEditor,
} from "lexical";
import { act } from "react";
import type { ComposerSegment, ComposerTokenData } from "../conversation/composer-editor/segments";
import { $plainWithCaret, $readSegments } from "../conversation/composer-editor/segments";
import { $createTokenNode } from "../conversation/composer-editor/token-node";

/**
 * Runs `fn` inside React's `act`, in an act environment for the call (as Testing Library's own
 * `act` does), so the renders it causes are flushed before the next step.
 */
function run(fn: () => void): void {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const before = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    act(fn);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = before;
  }
}

/** The Lexical editor behind the composer's text box (its content editable). */
function editorOf(box: HTMLElement): LexicalEditor {
  const editor = (box as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (editor === undefined) throw new Error("not a composer text box");
  return editor;
}

/** The draft as segments: text runs and tokens, in order. */
export function composerSegments(box: HTMLElement): ComposerSegment[] {
  return editorOf(box).getEditorState().read($readSegments);
}

/** The draft as the person reads it, each token as its label. */
export function composerText(box: HTMLElement): string {
  return editorOf(box)
    .getEditorState()
    .read(() => $getRoot().getTextContent());
}

/** Focuses the text box with the caret at the end of the draft. */
export function focusComposerEnd(box: HTMLElement): void {
  const editor = editorOf(box);
  run(() => {
    box.focus();
    editor.update(() => $getRoot().selectEnd(), { discrete: true });
  });
}

/**
 * Types `text` at the caret one character per update, as keystrokes do (a trigger typed this way
 * opens its menu). With no caret the text goes at the end.
 */
export function typeInComposer(box: HTMLElement, text: string): void {
  const editor = editorOf(box);
  for (const c of text) {
    run(() => {
      editor.update(
        () => {
          const s = $getSelection();
          if ($isRangeSelection(s)) s.insertText(c);
          else $getRoot().selectEnd().insertText(c);
        },
        { discrete: true },
      );
    });
  }
}

/**
 * Deletes the character before a collapsed caret in a text run, as Backspace does (jsdom has no
 * `Selection.modify`, which Lexical's own deletion steps with).
 */
export function backspaceInComposer(box: HTMLElement): void {
  const editor = editorOf(box);
  run(() => {
    editor.update(
      () => {
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

/** The caret's offset in the draft's plain text (a token counts one); null without a caret. */
export function composerCaret(box: HTMLElement): number | null {
  return editorOf(box)
    .getEditorState()
    .read(() => $plainWithCaret($getSelection()).caret);
}

/**
 * Commits the editor's pending updates now (a DOM event such as a paste commits on a microtask),
 * so the page has the draft before the next step.
 */
export function flushComposer(box: HTMLElement): void {
  const editor = editorOf(box);
  run(() => {
    editor.update(() => {}, { discrete: true });
  });
}

/**
 * Puts `tokens` at the end of the draft as they are, a space after each (a draft the menus would
 * take many picks to build: a test of the caps).
 */
export function appendComposerTokens(box: HTMLElement, tokens: ComposerTokenData[]): void {
  const editor = editorOf(box);
  run(() => {
    editor.update(
      () => {
        for (const t of tokens) {
          const s = $getRoot().selectEnd();
          s.insertNodes([$createTokenNode(t)]);
          $getRoot().selectEnd().insertText(" ");
        }
      },
      { discrete: true },
    );
  });
}
