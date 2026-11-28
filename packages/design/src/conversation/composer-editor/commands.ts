import {
  $addUpdateTag,
  $createNodeSelection,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  BEFORE_INPUT_COMMAND,
  CLICK_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  COMPOSITION_END_TAG,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  COPY_COMMAND,
  CUT_COMMAND,
  CUT_TAG,
  DRAGSTART_COMMAND,
  HISTORIC_TAG,
  HISTORY_PUSH_TAG,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  mergeRegister,
  PASTE_COMMAND,
  PASTE_TAG,
  type RangeSelection,
  TextNode,
} from "lexical";
import { isTouchPointer } from "../../shell/pointer";
import type { ComposerMenuCaret } from "../composer-menu";
import { $plainWithCaret, stripPastedText, TOKEN_MARKER } from "./segments";
import { $isTokenNode } from "./token-node";

// The editor's command overrides (composer inline tokens spec §2): menu keys first, ↵ sends,
// plain-text paste and copy, a selected token deleted as a unit, and the `@` / `/` trigger read
// from the text before the caret. Nothing here acts during an IME composition.

/** An update the editor made itself (a pick, a replace): never opens a menu. */
export const PROGRAMMATIC_TAG = "cap-programmatic";

/** The open trigger at the caret: `@` or `/` typed at the start or after whitespace. */
export type ComposerTrigger = { trigger: "@" | "/"; query: string; atStart: boolean };

/** The editor's callbacks, read at the moment of each event (the latest props). */
export type ComposerCommandProps = {
  onTrigger?(t: ComposerTrigger | null): void;
  onKeyDown?(e: KeyboardEvent, caret: ComposerMenuCaret): boolean;
  onPasteFiles?(files: File[]): void;
  onPasteText?(text: string): void;
  onSubmit(): void;
};

type Clipboardish = { clipboardData?: DataTransfer | null; dataTransfer?: DataTransfer | null };

/** Writes `text` as the only clipboard flavour: no HTML and no Lexical clipboard type. */
function writePlain(event: ClipboardEvent | KeyboardEvent | null, text: string): void {
  const data = event && "clipboardData" in event ? event.clipboardData : null;
  if (event) event.preventDefault();
  if (data) {
    data.clearData();
    data.setData("text/plain", text);
    return;
  }
  // a copy started from the keyboard over a selected token: no clipboard event follows
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** Whether `c` ends a word for the trigger rule (a token counts as text, not as a space). */
const isSpace = (c: string | undefined) => c !== undefined && c !== TOKEN_MARKER && /\s/.test(c);

/**
 * Registers the composer's commands on `editor`; `props()` returns the latest callbacks. Returns
 * the cleanup and `dismissTrigger` (the page closed its menu).
 */
export function registerComposerCommands(
  editor: LexicalEditor,
  props: () => ComposerCommandProps,
): { dispose(): void; dismissTrigger(): void } {
  // ── The trigger (spec §2 "IME", composer menus spec §1) ──
  // `end`: where the query ended at the last report; a caret moved outside [at + 1, end] closes it
  let armed: { trigger: "@" | "/"; at: number; end: number } | null = null;
  let reported = "null";
  let prevLength = editor.getEditorState().read(() => $plainWithCaret(null).text.length);
  let composed = false;
  const report = (t: ComposerTrigger | null) => {
    const key = JSON.stringify(t);
    if (key === reported) return;
    reported = key;
    props().onTrigger?.(t);
  };

  const onUpdate = ({
    editorState,
    tags,
    dirtyElements,
    dirtyLeaves,
  }: {
    editorState: ReturnType<LexicalEditor["getEditorState"]>;
    tags: Set<string>;
    dirtyElements: Map<string, boolean>;
    dirtyLeaves: Set<string>;
  }) => {
    // During a composition no trigger opens and the query does not change: the committed text is
    // read once it ends.
    if (editor.isComposing()) {
      composed = true;
      return;
    }
    const { text, caret } = editorState.read(() => $plainWithCaret($getSelection()));
    const grew = text.length === prevLength + 1;
    prevLength = text.length;
    const afterComposition = composed || tags.has(COMPOSITION_END_TAG);
    composed = false;
    if (armed !== null) {
      // a selection over the query is plain editing: the menu stays as it is
      if (caret === null) return;
      const query = text.slice(armed.at + 1, caret);
      // a caret moved (a click, an arrow) out of the query leaves the trigger behind
      const moved =
        dirtyElements.size === 0 &&
        dirtyLeaves.size === 0 &&
        (caret < armed.at + 1 || caret > armed.end);
      const gone =
        moved ||
        text[armed.at] !== armed.trigger ||
        caret <= armed.at ||
        query.includes("\n") ||
        query.includes(TOKEN_MARKER) ||
        // `/name args`: past the name the text is the skill's arguments
        (armed.trigger === "/" && /\s/.test(query)) ||
        // `@ `: an address or plain text, not a pick
        (armed.trigger === "@" && /^\s/.test(query));
      if (!gone) {
        armed.end = caret;
        report({ trigger: armed.trigger, query, atStart: armed.at === 0 });
        return;
      }
      armed = null;
    }
    const typed =
      !tags.has(PASTE_TAG) &&
      !tags.has(CUT_TAG) &&
      !tags.has(HISTORIC_TAG) &&
      !tags.has(PROGRAMMATIC_TAG) &&
      (grew || afterComposition);
    if (typed && caret !== null && caret > 0) {
      const c = text[caret - 1];
      // only the ASCII characters: a full-width at sign (U+FF20) an IME commits is text
      if ((c === "@" || c === "/") && (caret === 1 || isSpace(text[caret - 2]))) {
        armed = { trigger: c, at: caret - 1, end: caret };
        report({ trigger: c, query: "", atStart: caret === 1 });
        return;
      }
    }
    report(null);
  };

  /** The page closed the menu (Esc): the trigger stays closed until a new one is typed. */
  const dismissTrigger = () => {
    armed = null;
    report(null);
  };

  const dispose = mergeRegister(
    editor.registerUpdateListener(onUpdate),
    // Defence in depth: no text node ever holds a token marker, whatever put it there.
    editor.registerNodeTransform(TextNode, (node) => {
      const t = node.getTextContent();
      if (t.includes(TOKEN_MARKER)) node.setTextContent(t.split(TOKEN_MARKER).join(""));
    }),
    // The menu's keys come before the editor's own; a `true` stops them (its ↵ picks, never sends).
    // A printable key over a selected token replaces it.
    editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        if (editor.isComposing() || event.isComposing) return false;
        if (props().onKeyDown?.(event, $caretFacts())) {
          event.preventDefault();
          return true;
        }
        const printable =
          event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (printable && $isNodeSelection($getSelection())) {
          const range = $replaceSelectedTokens();
          if (range === null) return false;
          event.preventDefault();
          $addUpdateTag(HISTORY_PUSH_TAG);
          range.insertText(event.key);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    // Text a soft keyboard inserts (or deletes) over a selected token replaces (or removes) it.
    editor.registerCommand(
      BEFORE_INPUT_COMMAND,
      (event) => {
        if (editor.isComposing() || !$isNodeSelection($getSelection())) return false;
        if (event.inputType === "insertText" && event.data) {
          const range = $replaceSelectedTokens();
          if (range === null) return false;
          event.preventDefault();
          $addUpdateTag(HISTORY_PUSH_TAG);
          range.insertText(event.data);
          return true;
        }
        if (event.inputType.startsWith("delete")) {
          event.preventDefault();
          $addUpdateTag(HISTORY_PUSH_TAG);
          $replaceSelectedTokens();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    // ↵ sends; Shift+↵ is a line break, and so is ↵ on a touch device (send is the button there).
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event === null || event.shiftKey || event.isComposing || editor.isComposing()) {
          return false;
        }
        // keyCode 229: the ↵ that confirms an IME's text (Safari reports it after
        // compositionend, with isComposing false). It is the IME's, neither a send nor a line
        // break: `true` stops Lexical's own line break, and the default is left alone so the
        // IME still commits its text.
        if (event.keyCode === 229) return true;
        if (isTouchPointer()) return false;
        event.preventDefault();
        props().onSubmit();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    // Paste is plain text: files go to the upload strip, text arrives without U+FFFC or format
    // characters, never as tokens and never opening a menu.
    editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (editor.isComposing()) return false;
        const e = event as unknown as Clipboardish & Event;
        const data = e.clipboardData ?? e.dataTransfer ?? null;
        if (data === null) return false;
        event.preventDefault();
        const files = Array.from(data.files ?? []);
        if (files.length > 0) props().onPasteFiles?.(files);
        const raw = data.getData("text/plain");
        if (raw === "") return true;
        props().onPasteText?.(raw);
        const text = stripPastedText(raw);
        if (text === "") return true;
        const selection = $isNodeSelection($getSelection())
          ? $replaceSelectedTokens()
          : $getSelection();
        if (!$isRangeSelection(selection)) return true;
        $addUpdateTag(PASTE_TAG);
        $addUpdateTag(HISTORY_PUSH_TAG);
        selection.insertRawText(text);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    // Text from a drop (or a replacement or yank) arrives cleaned as a paste does, at the point
    // Lexical put the selection; typed text over a selected token replaces it.
    editor.registerCommand(
      CONTROLLED_TEXT_INSERTION_COMMAND,
      (payload) => {
        if (editor.isComposing()) return false;
        const transfer = typeof payload === "string" ? null : payload.dataTransfer;
        const selected = $isNodeSelection($getSelection());
        if (transfer == null && !selected) return false;
        const range = selected ? $replaceSelectedTokens() : $getSelection();
        if (!$isRangeSelection(range)) return false;
        $addUpdateTag(HISTORY_PUSH_TAG);
        if (transfer != null) {
          $addUpdateTag(PASTE_TAG);
          const text = stripPastedText(
            transfer.getData("text/plain") || transfer.getData("text/uri-list"),
          );
          if (text !== "") range.insertRawText(text);
        } else {
          const text = typeof payload === "string" ? payload : (payload.data ?? "");
          if (text !== "") range.insertText(text);
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    // A selection holding a token is never dragged within the editor (a drop would bring back its
    // plain form as text, not the token).
    editor.registerCommand(
      DRAGSTART_COMMAND,
      (event) => {
        if (!$selectionHasToken()) return false;
        event.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    // Copy and cut write only text/plain, each token as its plain form.
    editor.registerCommand(
      COPY_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (editor.isComposing() || !$hasSelectedContent(selection)) return false;
        writePlain(event, selection.getTextContent());
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      CUT_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (editor.isComposing() || !$hasSelectedContent(selection)) return false;
        writePlain(event, selection.getTextContent());
        $addUpdateTag(CUT_TAG);
        $addUpdateTag(HISTORY_PUSH_TAG);
        if ($isRangeSelection(selection)) selection.removeText();
        else if ($isNodeSelection(selection)) removeSelectedTokens(selection);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    // A click or a tap on a token selects it as a node (the accent outline).
    editor.registerCommand(
      CLICK_COMMAND,
      (event) => {
        if (editor.isComposing()) return false;
        const target = event.target instanceof Element ? event.target : null;
        const host = target?.closest("[data-lexical-decorator]");
        if (!host) return false;
        const node = $getNearestNodeFromDOMNode(host);
        if (!$isTokenNode(node)) return false;
        event.preventDefault();
        const selection = $createNodeSelection();
        selection.add(node.getKey());
        $setSelection(selection);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    // A selected token (a click or a tap) goes with Backspace or Delete; ← / → leave it.
    editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => !editor.isComposing() && deleteSelectedToken(event),
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => !editor.isComposing() && deleteSelectedToken(event),
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => !editor.isComposing() && leaveSelectedToken(event, true),
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => !editor.isComposing() && leaveSelectedToken(event, false),
      COMMAND_PRIORITY_HIGH,
    ),
  );
  return { dispose, dismissTrigger };
}

/**
 * Where the caret stands in the draft (each token one character): collapsed, and at the start or
 * the end of the text. A range or a selected token is not collapsed and stands at no edge.
 */
export function $caretFacts(): ComposerMenuCaret {
  const { text, caret } = $plainWithCaret($getSelection());
  if (caret === null) return { collapsed: false, atStart: false, atEnd: false };
  return { collapsed: true, atStart: caret === 0, atEnd: caret === text.length };
}

/** A selection with something in it: a range that is not a caret, or selected tokens. */
function $hasSelectedContent(
  selection: ReturnType<typeof $getSelection>,
): selection is NonNullable<ReturnType<typeof $getSelection>> {
  if ($isRangeSelection(selection)) return !selection.isCollapsed();
  return $isNodeSelection(selection) && selection.getNodes().length > 0;
}

/** Whether the selection holds a token (selected as a node, or inside a range). */
function $selectionHasToken(): boolean {
  const selection = $getSelection();
  if ($isNodeSelection(selection)) return selection.getNodes().some($isTokenNode);
  return (
    $isRangeSelection(selection) &&
    !selection.isCollapsed() &&
    selection.getNodes().some($isTokenNode)
  );
}

/**
 * Removes the selected tokens and returns the caret where they stood, so what is typed, pasted
 * or picked next takes their place; null when no token is selected.
 */
export function $replaceSelectedTokens(): RangeSelection | null {
  const selection = $getSelection();
  if (!$isNodeSelection(selection)) return null;
  removeSelectedTokens(selection);
  const next = $getSelection();
  return $isRangeSelection(next) ? next : null;
}

/** Removes the selected tokens, the caret where the first one stood. */
function removeSelectedTokens(selection: ReturnType<typeof $getSelection>): void {
  if (!$isNodeSelection(selection)) return;
  const nodes = selection.getNodes();
  const first = nodes[0];
  if (first === undefined) return;
  const prev = first.getPreviousSibling();
  const parent = first.getParent();
  const index = first.getIndexWithinParent();
  for (const n of nodes) n.remove();
  if (prev !== null) prev.selectEnd();
  else parent?.select(index, index);
}

function deleteSelectedToken(event: KeyboardEvent): boolean {
  const selection = $getSelection();
  if (!$isNodeSelection(selection)) return false;
  event.preventDefault();
  $addUpdateTag(HISTORY_PUSH_TAG);
  removeSelectedTokens(selection);
  return true;
}

function leaveSelectedToken(event: KeyboardEvent, backward: boolean): boolean {
  const selection = $getSelection();
  if (!$isNodeSelection(selection) || event.shiftKey) return false;
  const nodes = selection.getNodes();
  const node = backward ? nodes[0] : nodes[nodes.length - 1];
  if (node === undefined) return false;
  event.preventDefault();
  if (backward) node.selectPrevious();
  else node.selectNext(0, 0);
  return true;
}
