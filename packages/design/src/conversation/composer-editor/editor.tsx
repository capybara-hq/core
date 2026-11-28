import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $addUpdateTag,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  CLEAR_HISTORY_COMMAND,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  SKIP_DOM_SELECTION_TAG,
} from "lexical";
import {
  type ForwardRefExoticComponent,
  forwardRef,
  type Ref,
  type RefAttributes,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useDesignT } from "../../provider";
import type { ComposerMenuCombobox } from "../composer-menu";
import {
  type ComposerCommandProps,
  type ComposerTrigger,
  PROGRAMMATIC_TAG,
  registerComposerCommands,
} from "./commands";
import {
  $readSegments,
  $writeSegments,
  type ComposerSegment,
  type ComposerTokenData,
  normalizeSegments,
  sameSegments,
} from "./segments";
import { InlineToken } from "./token";
import { $createTokenNode, TokenNode } from "./token-node";

// The composer's text box on Lexical (composer inline tokens spec §2): plain text with inline
// tokens, one paragraph with line breaks. The Lexical editor stays inside this module; the page
// passes and receives segments.

/** What the page holds on to: the draft, focus, a token pick, a replace, a clear. */
export type ComposerEditorHandle = {
  value(): ComposerSegment[];
  focus(): void;
  /**
   * Inserts a token at the caret (one undo step), a space after it, the caret after the space.
   * `replaceQuery`: the typed trigger and query (`length` characters before the caret) go first.
   */
  insertToken(t: ComposerTokenData, replaceQuery?: { trigger: "@" | "/"; length: number }): void;
  /** Replaces the draft (one undo step), the caret at its end. */
  replace(segments: ComposerSegment[]): void;
  /** Empties the draft and its undo history (after a send). */
  clear(): void;
};

export type ComposerEditorProps = {
  segments: ComposerSegment[];
  onChange(segments: ComposerSegment[]): void;
  placeholder: string;
  /** Ghost text after a lone skill token (the skill's argument hint). */
  hint?: string;
  /** The open trigger at the caret; null when there is none. */
  onTrigger?(t: ComposerTrigger | null): void;
  /** The menu's keys, offered first; `true` stops the editor's own handling. */
  onKeyDown?(e: KeyboardEvent): boolean;
  onPasteFiles?(files: File[]): void;
  /** The raw pasted text (the token warning's hook). */
  onPasteText?(text: string): void;
  /** ↵ without Shift, not composing, with a fine pointer. */
  onSubmit(): void;
  /** The combobox attributes while the page hosts a menu (`useComposerMenu().combobox`). */
  combobox?: ComposerMenuCombobox;
  autoFocus?: boolean;
  disabled?: boolean;
  /** The reference set and catalog only: draw the medium or compact form in a wide window. */
  referenceForm?: "medium" | "compact";
};

/** The ghost line's parts: the lone skill token and the whitespace after it, or nothing. */
function ghostOf(segments: ComposerSegment[]): { token: ComposerTokenData; space: string } | null {
  const [first, second, ...rest] = segments;
  if (first === undefined || typeof first === "string" || first.kind !== "skill") return null;
  if (rest.length > 0) return null;
  if (second === undefined) return { token: first, space: "" };
  if (typeof second === "string" && /^[^\S\n]*$/.test(second))
    return { token: first, space: second };
  return null;
}

/** Programmatic updates move the DOM caret only while the editor has the focus (no keyboard pops up). */
function $programmatic(editor: LexicalEditor): void {
  $addUpdateTag(HISTORY_PUSH_TAG);
  $addUpdateTag(PROGRAMMATIC_TAG);
  const root = editor.getRootElement();
  if (root === null || !root.contains(root.ownerDocument.activeElement)) {
    $addUpdateTag(SKIP_DOM_SELECTION_TAG);
  }
}

function Bridge({
  props,
  handle,
  setShown,
}: {
  props: ComposerEditorProps;
  handle: Ref<ComposerEditorHandle>;
  setShown(s: ComposerSegment[]): void;
}): null {
  const [editor] = useLexicalComposerContext();
  const latest = useRef(props);
  latest.current = props;
  const emitted = useRef<ComposerSegment[]>(normalizeSegments(props.segments));

  useEffect(() => {
    const commandProps = (): ComposerCommandProps => latest.current;
    const offCommands = registerComposerCommands(editor, commandProps);
    const offChange = editor.registerUpdateListener(({ editorState }) => {
      const next = editorState.read($readSegments);
      if (sameSegments(next, emitted.current)) return;
      emitted.current = next;
      setShown(next);
      latest.current.onChange(next);
    });
    return () => {
      offCommands();
      offChange();
    };
  }, [editor, setShown]);

  // A draft the page sets (a restore, a quick action) replaces the editor's content; a page that
  // only echoes what the editor reported changes nothing.
  const incoming = JSON.stringify(normalizeSegments(props.segments));
  useEffect(() => {
    const next = JSON.parse(incoming) as ComposerSegment[];
    if (sameSegments(next, emitted.current)) return;
    emitted.current = next;
    setShown(next);
    editor.update(
      () => {
        $programmatic(editor);
        $writeSegments(next);
      },
      { discrete: true },
    );
  }, [editor, incoming, setShown]);

  useEffect(() => {
    editor.setEditable(props.disabled !== true);
  }, [editor, props.disabled]);

  useEffect(() => {
    if (latest.current.autoFocus) editor.focus();
  }, [editor]);

  useImperativeHandle(
    handle,
    () => ({
      value: () => editor.getEditorState().read($readSegments),
      focus: () => editor.focus(),
      insertToken: (t, replaceQuery) => {
        editor.update(
          () => {
            $programmatic(editor);
            let selection = $getSelection();
            if (!$isRangeSelection(selection)) {
              $getRoot().selectEnd();
              selection = $getSelection();
            }
            if (!$isRangeSelection(selection)) return;
            if (!selection.isCollapsed()) selection.removeText();
            if (replaceQuery && replaceQuery.length > 0) {
              const anchor = selection.anchor;
              const node = anchor.getNode();
              if ($isTextNode(node) && anchor.offset >= replaceQuery.length) {
                node.spliceText(anchor.offset - replaceQuery.length, replaceQuery.length, "", true);
              } else {
                for (let i = 0; i < replaceQuery.length; i++) selection.deleteCharacter(true);
              }
              selection = $getSelection();
              if (!$isRangeSelection(selection)) return;
            }
            const token = $createTokenNode(t);
            selection.insertNodes([token]);
            const next = token.getNextSibling();
            if ($isTextNode(next) && /^\s/.test(next.getTextContent())) next.select(1, 1);
            else {
              const space = $createTextNode(" ");
              token.insertAfter(space);
              space.select(1, 1);
            }
          },
          { discrete: true },
        );
      },
      replace: (segments) => {
        editor.update(
          () => {
            $programmatic(editor);
            $writeSegments(segments);
          },
          { discrete: true },
        );
      },
      clear: () => {
        editor.update(
          () => {
            $programmatic(editor);
            $writeSegments([]);
          },
          { discrete: true },
        );
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      },
    }),
    [editor],
  );
  return null;
}

/**
 * The composer's editor (composer inline tokens spec §2): plain text with inline tokens (§1),
 * one line when empty growing to 8 lines, then scrolling. ↵ sends (a line break with Shift, and
 * on a touch device), paste and copy are plain text, a token is deleted, selected and undone as
 * one unit, and nothing reacts during an IME composition. `role="textbox"` with the combobox's
 * attributes while the page hosts a menu.
 */
export const ComposerEditor: ForwardRefExoticComponent<
  ComposerEditorProps & RefAttributes<ComposerEditorHandle>
> = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(props, ref) {
  const t = useDesignT();
  const id = useId();
  const [shown, setShown] = useState<ComposerSegment[]>(() => normalizeSegments(props.segments));
  const [initial] = useState(() => normalizeSegments(props.segments));
  const ghost = props.hint ? ghostOf(shown) : null;
  const hintId = `${id}-hint`;
  const { role: _role, ...aria } = props.combobox ?? ({} as Partial<ComposerMenuCombobox>);
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "cap-composer",
        nodes: [TokenNode],
        theme: { paragraph: "cb-composer-editor-paragraph" },
        editable: props.disabled !== true,
        editorState: () => {
          $writeSegments(initial, false);
        },
        onError: (error: Error) => {
          throw error;
        },
      }}
    >
      <div
        className="cb-composer-editor"
        data-part="composer-editor"
        data-form={props.referenceForm}
      >
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="cb-composer-input"
              data-part="composer-input"
              role="textbox"
              ariaMultiline
              ariaLabel={t("composer.message")}
              autoCapitalize="sentences"
              autoCorrect="on"
              {...(ghost ? { ariaDescribedBy: hintId } : {})}
              {...aria}
              aria-placeholder={props.placeholder}
              placeholder={
                <div className="cb-composer-editor-placeholder" aria-hidden="true">
                  {props.placeholder}
                </div>
              }
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        {ghost ? (
          <div className="cb-composer-editor-ghost" aria-hidden="true">
            <InlineToken token={ghost.token} hidden />
            {ghost.space}
            <span id={hintId} className="cb-composer-editor-hint">
              {props.hint}
            </span>
          </div>
        ) : null}
        <HistoryPlugin />
        <Bridge props={props} handle={ref} setShown={setShown} />
      </div>
    </LexicalComposer>
  );
});

export type { ComposerTrigger };
