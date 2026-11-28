import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { type JSX, useEffect, useState } from "react";
import type { ComposerTokenData } from "./segments";
import { InlineToken, skillText } from "./token";

// The editor's one custom node (composer inline tokens spec §2): an inline, atomic decorator that
// draws `InlineToken`. The caret never enters it; Backspace, Delete and a word delete remove it
// whole.

/** A token node's JSON: `{type: "cap-token", version: 1, kind, id, label, icon?, state?}`. */
export type SerializedTokenNode = Spread<
  Omit<ComposerTokenData, never> & { type: "cap-token"; version: 1 },
  SerializedLexicalNode
>;

/** The token data without absent optional fields (so equal tokens serialize equally). */
function clean(t: ComposerTokenData): ComposerTokenData {
  return {
    kind: t.kind,
    id: t.id,
    label: t.label,
    ...(t.icon ? { icon: t.icon } : {}),
    ...(t.state ? { state: t.state } : {}),
    ...(t.reason ? { reason: t.reason } : {}),
  };
}

export class TokenNode extends DecoratorNode<JSX.Element> {
  __token: ComposerTokenData;

  static override getType(): string {
    return "cap-token";
  }

  static override clone(node: TokenNode): TokenNode {
    return new TokenNode(node.__token, node.__key);
  }

  static override importJSON(json: SerializedTokenNode): TokenNode {
    const { type: _type, version: _version, ...token } = json;
    return $createTokenNode(token);
  }

  constructor(token: ComposerTokenData, key?: NodeKey) {
    super(key);
    this.__token = clean(token);
  }

  override exportJSON(): SerializedTokenNode {
    return { type: "cap-token", version: 1, ...clean(this.getLatest().__token) };
  }

  getToken(): ComposerTokenData {
    return this.getLatest().__token;
  }

  override createDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cb-inline-token-host";
    return span;
  }

  override updateDOM(): false {
    return false;
  }

  override isInline(): true {
    return true;
  }

  /**
   * Not keyboard selectable: ← / → step over the token in one move (spec §2 "Caret"); a click or a
   * tap selects it as a node.
   */
  override isKeyboardSelectable(): boolean {
    return false;
  }

  /** The plain form: what a copy of a selection holding the token writes. */
  override getTextContent(): string {
    const t = this.getToken();
    return t.kind === "skill" ? skillText(t.label) : `@${t.label}`;
  }

  override decorate(): JSX.Element {
    return <TokenView nodeKey={this.getKey()} token={this.__token} />;
  }
}

export function $createTokenNode(token: ComposerTokenData): TokenNode {
  return new TokenNode(token);
}

export function $isTokenNode(node: LexicalNode | null | undefined): node is TokenNode {
  return node instanceof TokenNode;
}

/** Whether the token is selected: as a node (a click), or inside a range over it. */
function $isSelected(key: NodeKey): boolean {
  const selection = $getSelection();
  if ($isNodeSelection(selection)) return selection.has(key);
  if ($isRangeSelection(selection) && !selection.isCollapsed()) {
    const node = $getNodeByKey(key);
    return node !== null && selection.getNodes().some((n) => n.is(node));
  }
  return false;
}

/** The token in the editor, with its selected state from the editor (a click: commands.ts). */
function TokenView({ nodeKey, token }: { nodeKey: NodeKey; token: ComposerTokenData }) {
  const [editor] = useLexicalComposerContext();
  const [selected, setSelected] = useState(() => editor.read(() => $isSelected(nodeKey)));
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        setSelected(editorState.read(() => $isSelected(nodeKey)));
      }),
    [editor, nodeKey],
  );
  return <InlineToken token={token} selected={selected} />;
}
