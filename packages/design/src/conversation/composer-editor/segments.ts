import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  type BaseSelection,
  type LexicalNode,
} from "lexical";
import type { IconName } from "../../icons/paths";
import { skillText } from "./token";
import { $createTokenNode, $isTokenNode } from "./token-node";

// The composer's model as the page sees it (composer inline tokens spec §1, §2): an ordered list of
// text and tokens. The page never touches Lexical nodes; this module turns segments into the
// editor's paragraph and back.

/** What a token names (spec §1). */
export type ComposerTokenKind =
  | "connector"
  | "resource"
  | "file"
  | "projectFile"
  | "conversation"
  | "skill";

/** One inline token: what it names, how it is drawn, and whether a send refused it. */
export type ComposerTokenData = {
  kind: ComposerTokenKind;
  id: string;
  label: string;
  /**
   * The lead: a connector's icon (`src`, the kernel icon route, falling back to `initial`), a named
   * icon, or a file's type mark (`fileType`, "PDF"). Absent: the kind's own lead.
   */
  icon?: { src?: string; initial?: string; name?: IconName; fileType?: string };
  /** A send refused it (spec §3.4): drawn with the fail border and the alert lead. */
  state?: "refused";
  /** Why it was refused; the token's accessible description. */
  reason?: string;
};

/** Text or a token. Two strings are never adjacent and a string is never empty. */
export type ComposerSegment = string | ComposerTokenData;

/** The marker that stands for a token in the editor's plain text (trigger detection). */
export const TOKEN_MARKER = "￼";

/** A token's plain form (spec §1 table): `@label`, a skill `/name`. */
export function tokenPlainForm(t: ComposerTokenData): string {
  return t.kind === "skill" ? skillText(t.label) : `@${t.label}`;
}

/** The draft as plain text, each token as its plain form (copy, cut, the bubble's fallback). */
export function segmentsPlainText(s: ComposerSegment[]): string {
  return s.map((x) => (typeof x === "string" ? x : tokenPlainForm(x))).join("");
}

/** Joins adjacent strings and drops empty ones, so equal drafts have one shape. */
export function normalizeSegments(s: readonly ComposerSegment[]): ComposerSegment[] {
  const out: ComposerSegment[] = [];
  for (const x of s) {
    if (typeof x === "string") {
      if (x === "") continue;
      const last = out[out.length - 1];
      if (typeof last === "string") out[out.length - 1] = last + x;
      else out.push(x);
    } else out.push(x);
  }
  return out;
}

/** Two drafts hold the same text and the same tokens in the same order. */
export function sameSegments(a: readonly ComposerSegment[], b: readonly ComposerSegment[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Pasted text as the composer takes it (spec §2 "Paste"): U+FFFC and every format character
 * (`Cf`: zero-width spaces and joiners, bidi marks, BOM) removed, line breaks kept, so a paste
 * never carries a stray token marker into the message.
 */
export function stripPastedText(text: string): string {
  return text.replace(/[￼\p{Cf}]/gu, "").replace(/\r\n?/g, "\n");
}

/** The editor's content as segments (inside a read or update). */
export function $readSegments(): ComposerSegment[] {
  const out: ComposerSegment[] = [];
  $getRoot()
    .getChildren()
    .forEach((block, i) => {
      if (i > 0) out.push("\n");
      if (!$isElementNode(block)) return;
      for (const node of block.getChildren()) {
        if ($isTokenNode(node)) out.push(node.getToken());
        else if ($isLineBreakNode(node)) out.push("\n");
        else if ($isTextNode(node)) out.push(node.getTextContent());
      }
    });
  return normalizeSegments(out);
}

/**
 * Replaces the editor's content with `segments` in one paragraph, the caret at its end (`select`,
 * default true; the initial state sets no selection, so mounting never takes the focus).
 */
export function $writeSegments(segments: readonly ComposerSegment[], select = true): void {
  const root = $getRoot();
  root.clear();
  const p = $createParagraphNode();
  for (const s of normalizeSegments(segments)) {
    if (typeof s !== "string") {
      p.append($createTokenNode(s));
      continue;
    }
    s.split("\n").forEach((line, i) => {
      if (i > 0) p.append($createLineBreakNode());
      if (line !== "") p.append($createTextNode(line));
    });
  }
  root.append(p);
  if (select) root.selectEnd();
}

/**
 * The draft as one string with each token as {@link TOKEN_MARKER} and each line break as "\n",
 * and the collapsed caret's offset in it (null with no caret: a range or a token selected).
 */
export function $plainWithCaret(selection: BaseSelection | null): {
  text: string;
  caret: number | null;
} {
  let text = "";
  let caret: number | null = null;
  const collapsed = $isRangeSelection(selection) && selection.isCollapsed();
  const anchor = collapsed ? selection.anchor : null;
  const piece = (n: LexicalNode): string =>
    $isTokenNode(n) ? TOKEN_MARKER : $isLineBreakNode(n) ? "\n" : n.getTextContent();
  $getRoot()
    .getChildren()
    .forEach((block, i) => {
      if (i > 0) text += "\n";
      if (!$isElementNode(block)) return;
      const children = block.getChildren();
      children.forEach((node, j) => {
        if (anchor?.type === "element" && anchor.key === block.getKey() && anchor.offset === j) {
          caret = text.length;
        }
        if (anchor?.type === "text" && anchor.key === node.getKey()) {
          caret = text.length + anchor.offset;
        }
        text += piece(node);
      });
      if (
        anchor?.type === "element" &&
        anchor.key === block.getKey() &&
        anchor.offset === children.length
      ) {
        caret = text.length;
      }
    });
  return { text, caret };
}
