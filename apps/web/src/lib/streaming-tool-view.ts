/**
 * What a tool call shows while the model still writes its input (streaming tool input spec §6.4):
 * the progress, the key argument a view replaces and the expanded detail, from the call's partial
 * input as parsed and the tool's declared `inputView`. Pure and display only; the timeline
 * (`lib/timeline.ts`) builds the rows from it.
 */
import type { DiffData, ToolRowData, ToolStreamProgress } from "@capybara-hq/design";
import type { ToolInfo } from "./conversations";
import { liveEditDiff, liveWriteDiff, writingLines } from "./live-diff";
import type { PartialJson } from "./partial-json";
import type { DraftTool } from "./run-drafts";

/** The most lines a live block or streaming text keeps (the last ones; the kernel's diff cap). */
export const LIVE_MAX_LINES = 2000;
/** A shown line is cut to this many characters (the kernel's `TOOL_VIEW_LINE_MAX_CHARS`). */
export const LIVE_LINE_MAX_CHARS = 2000;
/** The most characters of streaming text handed to the page (the tail is kept). */
export const LIVE_TEXT_MAX_CHARS = 256 * 1024;
/** The most characters of one generic input value shown (the head is kept). */
const INPUT_VALUE_MAX_CHARS = 16 * 1024;

type InputView = NonNullable<ToolInfo["inputView"]>;

/** The parts of a streaming row that depend on its input view. */
export interface StreamingView {
  progress: ToolStreamProgress;
  /** Set by a `command` view (the command as it grows), else the row's key argument stands. */
  keyArg?: string;
  /** A `command` view's description, only once its string is complete. */
  description?: string;
  added?: number;
  removed?: number;
  detail?: NonNullable<ToolRowData["detail"]>;
}

/** UTF-8 size of a string without encoding it. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Lines of a text as written so far; a final newline does not start another line. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

const cutLine = (s: string) =>
  s.length > LIVE_LINE_MAX_CHARS ? s.slice(0, LIVE_LINE_MAX_CHARS) : s;

/**
 * Streaming text bounded for the page (the design's live output draws all it gets): each line cut
 * at {@link LIVE_LINE_MAX_CHARS}, the last {@link LIVE_MAX_LINES} lines and at most
 * {@link LIVE_TEXT_MAX_CHARS} characters of the tail.
 */
export function liveTextTail(text: string): string {
  if (text.length <= LIVE_LINE_MAX_CHARS && !text.includes("\n")) return text;
  const lines = text.split("\n");
  const kept = lines.length > LIVE_MAX_LINES ? lines.slice(-LIVE_MAX_LINES) : lines;
  let out = kept.map(cutLine).join("\n");
  if (out.length > LIVE_TEXT_MAX_CHARS) {
    out = out.slice(out.length - LIVE_TEXT_MAX_CHARS);
    // never start inside a surrogate pair
    const c = out.charCodeAt(0);
    if (c >= 0xdc00 && c <= 0xdfff) out = out.slice(1);
  }
  return out;
}

/**
 * The last {@link LIVE_MAX_LINES} lines of a one-hunk live block (the writing and edit forms),
 * numbered where they stand, with the left-out earlier lines counted (`truncated`, `totalLines`).
 */
export function liveDiffTail(diff: DiffData): DiffData {
  const hunk = diff.hunks[0];
  if (diff.hunks.length !== 1 || hunk === undefined || hunk.lines.length <= LIVE_MAX_LINES)
    return diff;
  const drop = hunk.lines.length - LIVE_MAX_LINES;
  const dropped = hunk.lines.slice(0, drop);
  const olds = dropped.filter((l) => l.kind !== "add").length;
  const news = dropped.filter((l) => l.kind !== "del").length;
  return {
    hunks: [
      {
        oldStart: hunk.oldStart === 0 ? 0 : hunk.oldStart + olds,
        newStart: hunk.newStart === 0 ? 0 : hunk.newStart + news,
        lines: hunk.lines.slice(drop),
      },
    ],
    truncated: true,
    totalLines: hunk.lines.length,
  };
}

const str = (rec: Record<string, unknown>, k: string | undefined): string | undefined => {
  if (k === undefined) return undefined;
  const v = rec[k];
  return typeof v === "string" ? v : undefined;
};

/** A generic input value as the detail lists it: a string as is, anything else as JSON. */
function inputValue(v: unknown): string {
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  return s.length > INPUT_VALUE_MAX_CHARS ? `${s.slice(0, INPUT_VALUE_MAX_CHARS)}…` : s;
}

/**
 * The view-dependent parts of a streaming call (spec §6.4). `parsed` is its input as far as it
 * arrived; `view` the tool's declared input view (null, or not known yet: the generic form).
 */
export function streamingView(
  tool: DraftTool,
  parsed: PartialJson,
  view: InputView | null,
): StreamingView {
  const rec = parsed.value ?? {};
  // the size of the input so far (a truncated call's: of the head the draft kept)
  const bytes = utf8Bytes(tool.input);
  switch (view?.kind) {
    case "file_write": {
      const content = str(rec, view.content);
      const out: StreamingView = {
        progress: { bytes, ...(content !== undefined ? { lines: lineCount(content) } : {}) },
      };
      if (content === undefined) return out;
      // the base is the kernel's (only for the builtin Write, only when the log vouches for it)
      if (tool.base !== undefined) {
        const live = liveWriteDiff(tool.base.text, content);
        out.added = live.added;
        out.removed = live.removed;
        out.detail = { diff: live.diff, live: { pending: live.pending } };
      } else {
        out.detail = { diff: liveDiffTail(writingLines(content)), live: { preview: true } };
      }
      return out;
    }
    case "file_edit": {
      const oldText = str(rec, view.old);
      const newText = str(rec, view.new) ?? "";
      const out: StreamingView = { progress: { bytes, lines: lineCount(newText) } };
      if (oldText === undefined) return out;
      out.detail = {
        diff: liveDiffTail(liveEditDiff(oldText, newText)),
        live: { gutter: "pending" },
      };
      return out;
    }
    case "command": {
      const command = str(rec, view.command);
      const description = str(rec, view.description);
      return {
        progress: { bytes },
        ...(command !== undefined && command !== "" ? { keyArg: command } : {}),
        // never a half description: it replaces the command only once its string closed
        ...(description !== undefined &&
        description !== "" &&
        view.description !== undefined &&
        parsed.open !== view.description
          ? { description }
          : {}),
        ...(command !== undefined ? { detail: { command } } : {}),
      };
    }
    case "text": {
      const text = str(rec, view.field);
      return {
        progress: { bytes, ...(text !== undefined ? { lines: lineCount(text) } : {}) },
        ...(text !== undefined ? { detail: { output: liveTextTail(text) } } : {}),
      };
    }
    default: {
      const input = Object.entries(rec).map(([k, v]): [string, string] => [k, inputValue(v)]);
      return {
        progress: { bytes, generic: true },
        ...(input.length > 0 ? { detail: { input } } : {}),
      };
    }
  }
}
