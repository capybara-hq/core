import {
  $addUpdateTag,
  $createNodeSelection,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  COMPOSITION_END_TAG,
  COPY_COMMAND,
  CUT_COMMAND,
  CUT_TAG,
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
} from "lexical";
import { isTouchPointer } from "../../shell/pointer";
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
  onKeyDown?(e: KeyboardEvent): boolean;
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
 * the cleanup.
 */
export function registerComposerCommands(
  editor: LexicalEditor,
  props: () => ComposerCommandProps,
): () => void {
  // ── The trigger (spec §2 "IME", composer menus spec §1) ──
  let armed: { trigger: "@" | "/"; at: number } | null = null;
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
  }: {
    editorState: ReturnType<LexicalEditor["getEditorState"]>;
    tags: Set<string>;
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
      const gone =
        text[armed.at] !== armed.trigger ||
        caret <= armed.at ||
        query.includes("\n") ||
        query.includes(TOKEN_MARKER) ||
        // `/name args`: past the name the text is the skill's arguments
        (armed.trigger === "/" && /\s/.test(query)) ||
        // `@ `: an address or plain text, not a pick
        (armed.trigger === "@" && /^\s/.test(query));
      if (!gone) {
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
      // only the ASCII characters: a full-width ＠ an IME commits is text
      if ((c === "@" || c === "/") && (caret === 1 || isSpace(text[caret - 2]))) {
        armed = { trigger: c, at: caret - 1 };
        report({ trigger: c, query: "", atStart: caret === 1 });
        return;
      }
    }
    report(null);
  };

  return mergeRegister(
    editor.registerUpdateListener(onUpdate),
    // The menu's keys come before the editor's own; a `true` stops them (its ↵ picks, never sends).
    editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        if (editor.isComposing() || event.isComposing) return false;
        if (props().onKeyDown?.(event)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    // ↵ sends; Shift+↵ is a line break, and so is ↵ on a touch device (send is the button there).
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event === null || event.shiftKey || event.isComposing || editor.isComposing()) {
          return false;
        }
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
        const selection = $getSelection();
        if (text === "" || !$isRangeSelection(selection)) return true;
        $addUpdateTag(PASTE_TAG);
        $addUpdateTag(HISTORY_PUSH_TAG);
        selection.insertRawText(text);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    // Copy and cut write only text/plain, each token as its plain form.
    editor.registerCommand(
      COPY_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (selection === null) return false;
        writePlain(event, selection.getTextContent());
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      CUT_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (selection === null) return false;
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
      (event) => deleteSelectedToken(event),
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => deleteSelectedToken(event),
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => leaveSelectedToken(event, true),
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => leaveSelectedToken(event, false),
      COMMAND_PRIORITY_HIGH,
    ),
  );
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
